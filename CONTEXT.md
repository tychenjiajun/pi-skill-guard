# CONTEXT.md

Domain knowledge for understanding pi-skill-guard and pi-arg-corrector.

## Extensions

### pi-skill-guard
Intercepts "tool not found" errors. Two cases:
1. **Skill matching** — if the tool name matches a known skill, inject the SKILL.md content
2. **Bash fallback** — if the unknown tool has a `command` argument, execute it via bash

Uses `message_end` event (the only hook that fires for missing tools).

### pi-arg-corrector
Normalizes LLM tool call argument aliases for built-in `edit`, `write`, `read` tools. Fixes wrong field names (e.g., `file` → `path`, `old_str` → `oldText`) before schema validation.

Uses `prepareArguments` on overridden built-in tools via `createXxxToolDefinition`.

## Terminology

### Skill
A pi extension that provides knowledge/instructions to the LLM, loaded from SKILL.md files. Skills are NOT tools by default.

### Tool
An executable function the LLM can call (e.g., `bash`, `read`, `edit`). Skills are NOT tools.

### Extension
A pi plugin that can register tools, listen to events, and modify behavior.

### prepareArguments
A hook on `ToolDefinition` that runs before schema validation. Used by pi-arg-corrector to normalize alias field names before the built-in tool validates them.