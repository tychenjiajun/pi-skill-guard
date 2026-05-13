
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  type Skill,
  createLocalBashOperations,
} from "@mariozechner/pi-coding-agent";
import type { ToolResultMessage, ToolCall } from "@mariozechner/pi-ai";

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

// Copy of truncateTail and DEFAULT_MAX_BYTES/DEFAULT_MAX_LINES from @mariozechner/pi-coding-agent/dist/core/tools/truncate
const DEFAULT_MAX_LINES = 500;
const DEFAULT_MAX_BYTES = 100 * 1024; // 100KB

function getTempFilePath() {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-bash-${id}.log`);
}

function truncateTail(text: string) {
  const lines = text.split("\n");
  const totalLines = lines.length;
  
  // First truncate by lines
  let truncatedLines = lines.slice(-DEFAULT_MAX_LINES);
  let truncatedBy: "lines" | "bytes" | undefined = totalLines > DEFAULT_MAX_LINES ? "lines" : undefined;
  
  // Then truncate by bytes
  let result = truncatedLines.join("\n");
  let bytes = Buffer.byteLength(result, "utf8");
  if (bytes > DEFAULT_MAX_BYTES) {
    truncatedBy = "bytes";
    // Binary search to find the right truncation point
    let low = 0;
    let high = result.length;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const slice = result.slice(-mid);
      const sliceBytes = Buffer.byteLength(slice, "utf8");
      if (sliceBytes <= DEFAULT_MAX_BYTES) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    result = result.slice(-best);
  }

  const outputLines = result.split("\n").length;
  const lastLinePartial = truncatedBy === "bytes" && outputLines === 1 && totalLines > 1;
  
  return {
    content: result,
    truncated: truncatedBy !== undefined,
    truncatedBy,
    totalLines,
    outputLines,
    outputBytes: Buffer.byteLength(result, "utf8"),
    maxBytes: DEFAULT_MAX_BYTES,
    lastLinePartial,
  };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

async function executeBashCommand(command: string, timeout: number | undefined, cwd: string, signal?: AbortSignal) {
  const ops = createLocalBashOperations();
  return new Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: any;
    isError: boolean;
  }>((resolve) => {
    let tempFilePath: string | undefined;
    let tempFileStream: any;
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

    const ensureTempFile = () => {
      if (tempFilePath) return;
      tempFilePath = getTempFilePath();
      tempFileStream = createWriteStream(tempFilePath);
      for (const chunk of chunks) tempFileStream.write(chunk);
    };

    const handleData = (data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > DEFAULT_MAX_BYTES) {
        ensureTempFile();
      }
      if (tempFileStream) tempFileStream.write(data);
      chunks.push(data);
      chunksBytes += data.length;
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
    };

    const execOpts: any = { onData: handleData };
    if (signal) execOpts.signal = signal;
    if (typeof timeout === "number") execOpts.timeout = timeout;
    
    ops.exec(command, cwd, execOpts)
      .then(({ exitCode }) => {
        const fullBuffer = Buffer.concat(chunks);
        const fullOutput = fullBuffer.toString("utf-8");
        const truncation = truncateTail(fullOutput);
        if (truncation.truncated) {
          ensureTempFile();
        }
        if (tempFileStream) tempFileStream.end();

        let outputText = truncation.content || "(no output)";
        let details: any;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: tempFilePath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
            outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
          } else if (truncation.truncatedBy === "lines") {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
          } else {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
          }
        }
        if (exitCode !== 0 && exitCode !== null) {
          outputText += `\n\nCommand exited with code ${exitCode}`;
          resolve({
            content: [{ type: "text", text: outputText }],
            details,
            isError: true,
          });
        } else {
          resolve({
            content: [{ type: "text", text: outputText }],
            details,
            isError: false,
          });
        }
      })
      .catch((err) => {
        if (tempFileStream) tempFileStream.end();
        const fullBuffer = Buffer.concat(chunks);
        let output = fullBuffer.toString("utf-8");
        if (err.message === "aborted") {
          if (output) output += "\n\n";
          output += "Command aborted";
        } else if (err.message.startsWith("timeout:")) {
          const timeoutSecs = err.message.split(":")[1];
          if (output) output += "\n\n";
          output += `Command timed out after ${timeoutSecs} seconds`;
        } else {
          output = err.message;
        }
        resolve({
          content: [{ type: "text", text: output }],
          isError: true,
        });
      });
  });
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
            const result = await executeBashCommand(command, timeoutNum, ctx.cwd, ctx.signal);
            const fixedToolResult: ToolResultMessage = {
              role: "toolResult",
              toolCallId: toolResultMsg.toolCallId,
              toolName: "bash",
              content: result.content,
              details: result.details,
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
