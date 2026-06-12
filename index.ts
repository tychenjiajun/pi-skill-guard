import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  type Skill,
  createBashTool,
} from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// skill loading with TTL cache
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isToolNotFoundError(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (lower === "not found") return true;
  if (lower.startsWith("tool not found") || lower.startsWith("unknown tool"))
    return true;
  return false;
}

const findToolCallArgs = (
  entries: readonly SessionEntry[],
  toolCallId: string,
): Record<string, unknown> | undefined => {
  const scanLimit = Math.min(20, entries.length);
  for (let i = entries.length - 1; i >= entries.length - scanLimit; i--) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "toolCall" &&
        "id" in block &&
        block.id === toolCallId &&
        "arguments" in block
      ) {
        return block.arguments;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// extension — handles "tool not found" errors only
// ---------------------------------------------------------------------------

export default function skillGuardExtension(pi: ExtensionAPI) {
  const skillPaths = new Map<string, string>();
  const fileContentCache = new Map<string, string>();
  const handledToolCallIds = new Set<string>();

  pi.on("turn_end", () => handledToolCallIds.clear());

  pi.on("session_start", async (_event, ctx) => {
    skillCache = undefined;
    skillPaths.clear();
    fileContentCache.clear();
    handledToolCallIds.clear();

    try {
      const skills = await loadSkillsCache(ctx.cwd);
      for (const [name, skill] of skills) {
        const skillFilePath = await findSkillFilePath(skill);
        skillPaths.set(name, skillFilePath);
      }
    } catch {
      // Quietly fail
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;

    if (msg.role !== "toolResult") return;
    if (!msg.isError) return;
    if (!msg.toolCallId || handledToolCallIds.has(msg.toolCallId)) return;

    const textBlocks = msg.content;
    const combinedText = textBlocks
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    if (!isToolNotFoundError(combinedText)) return;

    const toolName = msg.toolName;
    const toolCallId = msg.toolCallId;

    // ── Case 1: skill name (tool not found) ───────────────────────────
    if (skillPaths.has(toolName)) {
      const skillFilePath = skillPaths.get(toolName)!;
      try {
        let skillContent = fileContentCache.get(skillFilePath);
        if (!skillContent) {
          skillContent = await fs.readFile(skillFilePath, "utf-8");
          fileContentCache.set(skillFilePath, skillContent);
        }

        handledToolCallIds.add(toolCallId);
        ctx.ui.notify(
          `Skill guard: Loaded skill "${toolName}" documentation`,
          "info",
        );

        return {
          message: {
            ...msg,
            content: [{ type: "text" as const, text: skillContent }],
            isError: false,
          },
        };
      } catch {
        // Let original error through
      }
      return;
    }

    // ── Case 2: unknown tool with command arg (tool not found) ────────
    const entries = ctx.sessionManager.getEntries();
    const args = findToolCallArgs(entries, toolCallId);
    const command = args?.command;
    if (typeof command !== "string") return;

    let timeoutNum: number | undefined;
    const rawTimeout = args!.timeout;
    if (typeof rawTimeout === "number") {
      timeoutNum = rawTimeout;
    } else if (typeof rawTimeout === "string") {
      const parsed = parseFloat(rawTimeout);
      if (!isNaN(parsed)) timeoutNum = parsed;
    }

    try {
      const execResult = await createBashTool(ctx.cwd).execute(
        toolCallId,
        timeoutNum !== undefined
          ? { command, timeout: timeoutNum }
          : { command },
        ctx.signal,
        undefined,
      );

      handledToolCallIds.add(toolCallId);
      ctx.ui.notify(
        `Skill guard: Executed bash command from "${toolName}" call`,
        "info",
      );

      return {
        message: { ...msg, content: execResult.content, isError: false },
      };
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);

      handledToolCallIds.add(toolCallId);
      ctx.ui.notify(
        `Skill guard: Bash command from "${toolName}" failed: ${errorText.slice(0, 80)}`,
        "warning",
      );

      return {
        message: {
          ...msg,
          content: [{ type: "text" as const, text: errorText }],
          isError: true,
        },
      };
    }
  });
}
