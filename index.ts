
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  type Skill,
  createLocalBashOperations,
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, ToolCall } from "@earendil-works/pi-ai";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SkillCache {
  skills: Map<string, Skill>;
  loadedAt: number;
}

const SKILL_CACHE_TTL_MS = 60_000;
let skillCache: SkillCache | undefined;

const loadSkillsCache = async (cwd: string): Promise<Map<string, Skill>> => {
  const now = Date.now();
  if (skillCache && skillCache.loadedAt + SKILL_CACHE_TTL_MS > now) {
    return skillCache.skills;
  }

  const result = await loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: [],
    includeDefaults: true,
  });

  const skillsMap = new Map<string, Skill>();
  for (const skill of result.skills) {
    skillsMap.set(skill.name, skill);
  }

  skillCache = { skills: skillsMap, loadedAt: now };
  return skillsMap;
};

const findSkillFilePath = async (skill: Skill): Promise<string> => {
  try {
    const stat = await fs.stat(skill.filePath);
    if (stat.isFile()) {
      return skill.filePath;
    }
    return join(skill.filePath, "SKILL.md");
  } catch {
    return skill.filePath;
  }
};

function getTempFilePath() {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-bash-${id}.log`);
}

async function executeBashCommand(
  cwd: string,
  command: string,
  timeoutSeconds?: number,
  parentSignal?: AbortSignal
) {
  // Handle timeout by creating an AbortSignal that aborts after timeout
  // and also respects the parent signal
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();

  if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
    timeoutId = setTimeout(() => timeoutController.abort(), timeoutSeconds * 1000);
  }

  // Combine parent signal and timeout signal
  const combinedSignal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;

  const ops = createLocalBashOperations();

  const chunks: string[] = [];
  let totalBytes = 0;
  const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
  let tempFilePath: string | undefined;
  let tempFileStream: ReturnType<typeof createWriteStream> | undefined;

  const ensureTempFile = () => {
    if (tempFilePath) return;
    tempFilePath = getTempFilePath();
    tempFileStream = createWriteStream(tempFilePath);
    for (const chunk of chunks) tempFileStream.write(chunk);
  };

  const handleData = (data: Buffer) => {
    totalBytes += data.length;
    const text = data.toString("utf-8");

    if (totalBytes > DEFAULT_MAX_BYTES) {
      ensureTempFile();
    }
    if (tempFileStream) tempFileStream.write(text);

    chunks.push(text);
    totalBytes = chunks.join("").length;
    while (totalBytes > maxOutputBytes && chunks.length > 1) {
      const removed = chunks.shift();
      totalBytes -= removed?.length ?? 0;
    }
  };

  let exitCode: number | null | undefined;
  let killed = false;

  try {
    const result = await ops.exec(command, cwd, {
      onData: handleData,
      signal: combinedSignal,
    });
    exitCode = result.exitCode;
  } catch {
    if (combinedSignal.aborted) {
      killed = true;
    }
  }

  if (timeoutId) clearTimeout(timeoutId);
  if (tempFileStream) tempFileStream.end();

  const fullOutput = chunks.join("");
  const truncation = truncateTail(fullOutput);

  if (truncation.truncated) {
    ensureTempFile();
  }

  let text = truncation.content || "(no output)";

  if (truncation.truncated && tempFilePath) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    if (truncation.lastLinePartial) {
      text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${tempFilePath}]`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
    } else {
      text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
    }
  }

  if (killed) {
    if (timeoutController.signal.aborted && !parentSignal?.aborted) {
      text += `\n\nCommand timed out after ${timeoutSeconds} seconds`;
    } else {
      text += "\n\nCommand was cancelled";
    }
  } else if (exitCode !== undefined && exitCode !== 0) {
    text += `\n\nCommand exited with code ${exitCode}`;
  }

  return {
    content: [{ type: "text" as const, text }],
    isError: exitCode !== undefined && exitCode !== 0,
  };
}

function findToolCall(messages: any[], toolCallId: string): ToolCall | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      const contents = Array.isArray(msg.content) ? msg.content : [];
      for (const content of contents) {
        if (content && typeof content === "object" && "type" in content && content.type === "toolCall" && "id" in content && content.id === toolCallId) {
          return content as ToolCall;
        }
      }
    }
  }
  return undefined;
}

export default function skillGuardExtension(pi: ExtensionAPI) {
  let extensionContext: ExtensionContext | undefined;
  const skillPaths = new Map<string, string>();
  // Cache file contents to avoid repeated reads within same turn
  const fileContentCache = new Map<string, string>();

  pi.on("session_start", async (_event, ctx) => {
    extensionContext = ctx;
    skillCache = undefined;
    skillPaths.clear();
    fileContentCache.clear();

    try {
      const skills = await loadSkillsCache(ctx.cwd);
      
      // Cache skill paths (don't register as tools!)
      for (const [name, skill] of skills) {
        const skillFilePath = await findSkillFilePath(skill);
        skillPaths.set(name, skillFilePath);
      }
    } catch (err) {
      // Quietly fail or log to a proper logger if available
    }
  });

  /**
   * Intercept "tool not found" errors for skill names.
   * Replaces them with successful results showing the skill documentation.
   */
  pi.on("context", async (event, ctx) => {
    const messages = [...event.messages];
    let modified = false;
    
    // Find tool result messages with "tool not found" errors for our skills
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || (msg as any).role !== "toolResult") {
        continue;
      }

      const toolResultMsg = msg as ToolResultMessage;
      const isNotFoundError = toolResultMsg.isError &&
        toolResultMsg.content.some(
          (c: any) => c.type === "text" && c.text.toLowerCase().includes("not found")
        );
      
      if (!isNotFoundError) continue;

      // Check if it's a skill
      if (skillPaths.has(toolResultMsg.toolName)) {
        const skillName = toolResultMsg.toolName;
        const skillFilePath = skillPaths.get(skillName)!;
        
        try {
          // Read or retrieve cached content
          let skillContent = fileContentCache.get(skillFilePath);
          if (!skillContent) {
            skillContent = await fs.readFile(skillFilePath, "utf-8");
            fileContentCache.set(skillFilePath, skillContent);
          }
          
          // Create a successful tool result matching what read tool would return
          const fixedToolResult: ToolResultMessage = {
            role: "toolResult",
            toolCallId: toolResultMsg.toolCallId,
            toolName: skillName,
            content: [
              {
                type: "text",
                text: skillContent, // Raw SKILL.md content, no wrapping
              },
            ],
            details: {
              path: skillFilePath,
              sizeBytes: skillContent.length,
              source: "skill_guard_intercept",
            },
            isError: false,
            timestamp: Date.now(),
          };
          
          // Replace the error message with our fixed one
          messages[i] = fixedToolResult as any;
          modified = true;
          ctx.ui.notify(
            `Skill guard: Fixed "${skillName}" error → loaded documentation`,
            "info",
          );
        } catch (err) {
          // Quietly fail
        }
      } else {
        // Check if this tool call had a "command" argument
        const toolCall = findToolCall(messages, toolResultMsg.toolCallId);
        if (toolCall && toolCall.arguments && typeof toolCall.arguments.command === "string") {
          const { command, timeout } = toolCall.arguments;
          let timeoutNum: number | undefined;
          if (typeof timeout === "number") {
            timeoutNum = timeout;
          } else if (typeof timeout === "string") {
            const parsed = parseFloat(timeout);
            if (!isNaN(parsed)) timeoutNum = parsed;
          }

          try {
            const result = await executeBashCommand(ctx.cwd, command, timeoutNum, ctx.signal);
            const fixedToolResult: ToolResultMessage = {
              role: "toolResult",
              toolCallId: toolResultMsg.toolCallId,
              toolName: "bash",
              content: result.content,
              isError: result.isError,
              timestamp: Date.now(),
            };
            messages[i] = fixedToolResult as any;
            modified = true;
            ctx.ui.notify(
              `Skill guard: Fixed "${toolResultMsg.toolName}" error → executed bash command`,
              "info",
            );
          } catch (err) {
            // Quietly fail
          }
        }
      }
    }
    
    return modified ? { messages: messages as any } : undefined;
  });
}
