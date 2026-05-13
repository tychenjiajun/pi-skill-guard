
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
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

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

function isToolNotFoundError(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Pi's bare "not found" error for missing tools
  if (lower === "not found") return true;
  // Tool-not-found or unknown-tool error patterns
  if (lower.startsWith("tool not found") || lower.startsWith("unknown tool")) return true;
  return false;
}

/**
 * Find a tool call by ID from recent assistant messages.
 * Only scans the last ~20 entries for efficiency - tool calls are always near their results.
 */
function findMatchingToolCall(
  sessionManager: any,
  toolCallId: string
): { arguments?: Record<string, unknown> } | undefined {
  const entries = sessionManager.getEntries();
  // Scan backwards from most recent, limited to ~20 entries for performance
  const scanLimit = Math.min(20, entries.length);
  
  for (let i = entries.length - 1; i >= entries.length - scanLimit; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const msgEntry = entry as SessionMessageEntry;
      const msg = msgEntry.message;
      if (msg.role === "assistant") {
        const contents = Array.isArray(msg.content) ? msg.content : [];
        for (const content of contents) {
          if (
            content &&
            typeof content === "object" &&
            "type" in content && content.type === "toolCall" &&
            "id" in content && content.id === toolCallId &&
            "arguments" in content
          ) {
            return { arguments: content.arguments };
          }
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
   * Intercept "tool not found" errors via message_end event.
   * When a tool doesn't exist, pi creates an immediate error that bypasses afterToolCall,
   * so tool_result event never fires. However, message_end always fires for all messages
   * and allows replacing the message in place.
   */
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    
    // Only handle toolResult messages with errors
    if (msg.role !== "toolResult") return;
    if (!(msg as any).isError) return;

    const toolResultMsg = msg as ToolResultMessage;
    const combinedText = toolResultMsg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Check if it's a "not found" error
    if (!isToolNotFoundError(combinedText)) return;

    const toolName = toolResultMsg.toolName;

    // Case 1: It's a skill name - replace with skill documentation
    if (skillPaths.has(toolName)) {
      const skillFilePath = skillPaths.get(toolName)!;
      
      try {
        // Read or retrieve cached content
        let skillContent = fileContentCache.get(skillFilePath);
        if (!skillContent) {
          skillContent = await fs.readFile(skillFilePath, "utf-8");
          fileContentCache.set(skillFilePath, skillContent);
        }
        
        ctx.ui.notify(
          `Skill guard: Loaded skill "${toolName}" documentation`,
          "info",
        );

        // Return replacement message
        return {
          message: {
            ...toolResultMsg,
            content: [
              {
                type: "text" as const,
                text: skillContent,
              },
            ],
            isError: false,
          },
        };
      } catch {
        // Quietly fail - let original error through
      }
    }

    // Case 2: Unknown tool with command argument - execute via bash
    // We need to get the tool call arguments from the assistant message
    // Since we don't have direct access here, we scan recent messages for the toolCall
    const toolCall = findMatchingToolCall(ctx.sessionManager, toolResultMsg.toolCallId);
    if (toolCall && toolCall.arguments?.command && typeof toolCall.arguments.command === "string") {
      const { command, timeout } = toolCall.arguments;
      let timeoutNum: number | undefined;
      if (typeof timeout === "number") {
        timeoutNum = timeout;
      } else if (typeof timeout === "string") {
        const parsed = parseFloat(timeout);
        if (!isNaN(parsed)) timeoutNum = parsed;
      }

      try {
        const result = await executeBashCommand(
          ctx.cwd,
          command,
          timeoutNum,
          ctx.signal,
        );
        
        ctx.ui.notify(
          `Skill guard: Executed bash command from "${toolName}" call`,
          "info",
        );

        // Return replacement message
        return {
          message: {
            ...toolResultMsg,
            toolName: "bash",
            content: result.content,
            isError: result.isError,
          },
        };
      } catch {
        // Quietly fail - let original error through
      }
    }
  });
}
