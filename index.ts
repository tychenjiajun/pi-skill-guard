import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  type Skill,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

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

function isToolNotFoundError(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (lower === "not found") return true;
  if (lower.startsWith("tool not found") || lower.startsWith("unknown tool")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// alias normalization for edit / write / read argument fields
// ---------------------------------------------------------------------------

const PATH_FIELD_ALIASES = {
  path: ["file", "filePath", "file_path", "target", "filename", "file_name"],
} as const;

const EDIT_FIELD_ALIASES: Record<string, readonly string[]> = {
  ...PATH_FIELD_ALIASES,
  oldText: ["old_str", "old_string", "old_text", "oldStr", "oldString", "oldContent", "old_content", "old", "original", "search"],
  newText: ["new_str", "new_string", "new_text", "newStr", "newString", "newContent", "new_content", "new", "replacement", "replace"],
};

const WRITE_FIELD_ALIASES: Record<string, readonly string[]> = {
  ...PATH_FIELD_ALIASES,
  content: ["text", "body", "code", "data", "fileContent", "file_content", "contents"],
};

const READ_FIELD_ALIASES: Record<string, readonly string[]> = {
  ...PATH_FIELD_ALIASES,
  offset: ["start", "startLine", "start_line", "from", "line"],
  limit: ["lines", "maxLines", "max_lines", "count", "numLines", "num_lines"],
};

const buildAliasMap = (aliases: Record<string, readonly string[]>) => {
  const map = new Map<string, string>();
  for (const [canonical, alts] of Object.entries(aliases)) {
    for (const alt of alts) {
      if (!map.has(alt)) map.set(alt, canonical);
    }
  }
  return map;
};

const editAliasMap = buildAliasMap(EDIT_FIELD_ALIASES);
const writeAliasMap = buildAliasMap(WRITE_FIELD_ALIASES);
const readAliasMap = buildAliasMap(READ_FIELD_ALIASES);

const renameAliasKeys = (
  obj: Record<string, unknown>,
  canonicalKeys: Record<string, readonly string[]>,
  aliasMap: Map<string, string>,
) => {
  for (const [key, value] of Object.entries(obj)) {
    const canonical = key in canonicalKeys ? key : aliasMap.get(key);
    if (canonical && canonical !== key) {
      obj[canonical] = value;
      delete obj[key];
    }
  }
};

/** Returns a deep clone with alias keys renamed. Does NOT mutate the original. */
const normalizeEditArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const normalized = structuredClone(args) as Record<string, unknown>;

  // Normalize top-level keys (path aliases like "file" → "path")
  renameAliasKeys(normalized, EDIT_FIELD_ALIASES, editAliasMap);

  // Pattern A: oldText/newText at top level (no edits array) → wrap
  if (
    !Array.isArray(normalized.edits) &&
    typeof normalized.oldText === "string" &&
    typeof normalized.newText === "string"
  ) {
    normalized.edits = [{ oldText: normalized.oldText, newText: normalized.newText }];
    delete normalized.oldText;
    delete normalized.newText;
  }

  // Pattern B: alias keys at top level → wrap into edits
  if (!Array.isArray(normalized.edits)) {
    const topOld = Object.keys(normalized).find((k) => editAliasMap.get(k) === "oldText");
    const topNew = Object.keys(normalized).find((k) => editAliasMap.get(k) === "newText");
    if (topOld && topNew && typeof normalized[topOld] === "string" && typeof normalized[topNew] === "string") {
      normalized.edits = [{ oldText: normalized[topOld], newText: normalized[topNew] }];
      delete normalized[topOld];
      delete normalized[topNew];
    }
  }

  // Normalize keys inside each edit object
  if (Array.isArray(normalized.edits)) {
    for (const edit of normalized.edits) {
      if (edit && typeof edit === "object") {
        renameAliasKeys(edit as Record<string, unknown>, EDIT_FIELD_ALIASES, editAliasMap);
      }
    }
  }

  return normalized;
};

const normalizeWriteArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const normalized = structuredClone(args) as Record<string, unknown>;
  renameAliasKeys(normalized, WRITE_FIELD_ALIASES, writeAliasMap);
  return normalized;
};

const normalizeReadArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const normalized = structuredClone(args) as Record<string, unknown>;
  renameAliasKeys(normalized, READ_FIELD_ALIASES, readAliasMap);
  // Coerce string offset/limit values to numbers when possible
  if (typeof normalized.offset === "string") {
    const n = parseFloat(normalized.offset);
    if (!isNaN(n)) normalized.offset = n;
  }
  if (typeof normalized.limit === "string") {
    const n = parseFloat(normalized.limit);
    if (!isNaN(n)) normalized.limit = n;
  }
  return normalized;
};

// ---------------------------------------------------------------------------
// session-entry scanner (message_end only sees one message at a time)
// ---------------------------------------------------------------------------

type Entryish = { type: string; message?: { role: string; content: unknown } };

const findToolCallArgs = (
  entries: readonly Entryish[],
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
        block && typeof block === "object" &&
        "type" in block && block.type === "toolCall" &&
        "id" in block && block.id === toolCallId &&
        "arguments" in block
      ) {
        return block.arguments as Record<string, unknown>;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// extension
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

    const textBlocks = (msg as { content: { type: string; text?: string }[] }).content;
    const combinedText = textBlocks
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const toolName = msg.toolName;
    const toolCallId = msg.toolCallId;

    // ── Case 1: skill name (tool not found) ───────────────────────────
    if (isToolNotFoundError(combinedText) && skillPaths.has(toolName)) {
      const skillFilePath = skillPaths.get(toolName)!;
      try {
        let skillContent = fileContentCache.get(skillFilePath);
        if (!skillContent) {
          skillContent = await fs.readFile(skillFilePath, "utf-8");
          fileContentCache.set(skillFilePath, skillContent);
        }

        handledToolCallIds.add(toolCallId);
        ctx.ui.notify(`Skill guard: Loaded skill "${toolName}" documentation`, "info");

        return {
          message: { ...msg, content: [{ type: "text" as const, text: skillContent }], isError: false },
        };
      } catch {
        // Let original error through
      }
      return;
    }

    // ── Case 2: unknown tool with command arg (tool not found) ────────
    if (isToolNotFoundError(combinedText)) {
      const entries = ctx.sessionManager.getEntries() as readonly Entryish[];
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
          timeoutNum !== undefined ? { command, timeout: timeoutNum } : { command },
          ctx.signal,
          undefined,
        );

        handledToolCallIds.add(toolCallId);
        ctx.ui.notify(`Skill guard: Executed bash command from "${toolName}" call`, "info");

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
          message: { ...msg, content: [{ type: "text" as const, text: errorText }], isError: true },
        };
      }
    }

    // ── Case 3: edit/write/read validation error (wrong field names) ─
    if (
      (toolName !== "edit" && toolName !== "write" && toolName !== "read") ||
      !combinedText.startsWith("Validation failed")
    ) {
      return;
    }

    const entries = ctx.sessionManager.getEntries() as readonly Entryish[];
    const args = findToolCallArgs(entries, toolCallId);
    if (!args) return;

    try {
      const normalizedArgs =
        toolName === "edit" ? normalizeEditArgs(args)
        : toolName === "write" ? normalizeWriteArgs(args)
        : normalizeReadArgs(args);

      const factory =
        toolName === "edit" ? createEditTool
        : toolName === "write" ? createWriteTool
        : createReadTool;
      const execResult = await factory(ctx.cwd).execute(
        toolCallId,
        normalizedArgs as any,
        ctx.signal,
        undefined,
      );

      handledToolCallIds.add(toolCallId);
      ctx.ui.notify(
        `Skill guard: Fixed "${toolName}" field names and re-executed`,
        "info",
      );

      return {
        message: {
          ...msg,
          content: execResult.content,
          details: execResult.details,
          isError: false,
        },
      };
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);

      handledToolCallIds.add(toolCallId);
      ctx.ui.notify(
        `Skill guard: "${toolName}" re-execution failed: ${errorText.slice(0, 80)}`,
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
