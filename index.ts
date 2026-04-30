import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import {
  getAgentDir,
  loadSkills,
  type Skill,
} from '@mariozechner/pi-coding-agent';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SkillCache {
  skills: Map<string, Skill>;
  loadedAt: number;
}

const SKILL_CACHE_TTL_MS = 60_000;
let skillCache: SkillCache | undefined;

const getSkillDir = (): string => join(getAgentDir(), 'skills');

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
  // skill.filePath could be the SKILL.md file directly or a directory
  try {
    const stat = await fs.stat(skill.filePath);
    if (stat.isFile()) {
      return skill.filePath;
    }
    // If it's a directory, look for SKILL.md
    return join(skill.filePath, 'SKILL.md');
  } catch {
    // Fallback to the filePath as-is (might be SKILL.md already)
    return skill.filePath;
  }
};

export default function skillGuardExtension(pi: ExtensionAPI) {
  let extensionContext: ExtensionContext | undefined;

  pi.on('session_start', (_event, ctx) => {
    extensionContext = ctx;
    // Invalidate cache on new session
    skillCache = undefined;
  });

  pi.on('resources_discover', async () => {
    // Preload skills cache when resources are discovered
    if (extensionContext) {
      await loadSkillsCache(extensionContext.cwd);
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    // Get the tool name that was called
    const toolName = event.toolName;

    // Skip if no tool name
    if (!toolName) return;

    // Load available skills
    const skills = await loadSkillsCache(ctx.cwd);

    // Check if the tool name matches a skill
    const skill = skills.get(toolName);
    if (!skill) return;

    // Found a skill match! Modify the tool_call to read the skill file
    const skillFilePath = await findSkillFilePath(skill);

    // Mutate the event to replace the tool with 'read'
    event.toolName = 'read';
    event.input = {
      path: skillFilePath,
    };

    ctx.ui.notify(`Skill guard: Redirected "${toolName}" to read skill file`, 'info');
  });
}