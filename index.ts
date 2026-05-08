import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  getAgentDir,
  loadSkills,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { ToolResultMessage } from "@mariozechner/pi-ai";

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

export default function skillGuardExtension(pi: ExtensionAPI) {
  let extensionContext: ExtensionContext | undefined;
  const skillPaths = new Map<string, string>();
  // Cache file contents to avoid repeated reads within same turn
  const fileContentCache = new Map<string, string>();

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Skill guard: Session started`);
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
      
      ctx.ui.notify(`Skill guard: Cached ${skills.size} skills (will intercept errors)`);
    } catch (err) {
      ctx.ui.notify(`Skill guard: Error loading skills: ${err}`, "error");
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
    for (const msg of messages) {
      if (
        msg.role !== "toolResult" ||
        typeof msg.toolName !== "string" ||
        !skillPaths.has(msg.toolName)
      ) {
        continue;
      }
      
      const toolResultMsg = msg as ToolResultMessage;
      
      // Check if it's a "not found" error
      const isNotFoundError = toolResultMsg.isError &&
        toolResultMsg.content.some(
          (c: any) => c.type === "text" && c.text.toLowerCase().includes("not found")
        );
      
      if (!isNotFoundError) continue;
      
      // Found a skill invocation error! Replace with actual skill content.
      const skillName = msg.toolName;
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
              text: skillContent,  // Raw SKILL.md content, no wrapping
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
        const idx = messages.indexOf(msg);
        if (idx !== -1) {
          messages[idx] = fixedToolResult;
          modified = true;
          ctx.ui.notify(
            `Skill guard: Fixed "${skillName}" error → loaded documentation`,
            "info",
          );
        }
      } catch (err) {
        ctx.ui.notify(
          `Skill guard: Failed to read ${skillName}: ${err}`,
          "error",
        );
      }
    }
    
    return modified ? { messages } : undefined;
  });
}
