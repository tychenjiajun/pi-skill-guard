# CONTEXT.md

Domain knowledge for understanding pi-skill-guard.

## Terminology

### Skill
A pi extension that provides knowledge/instructions to the LLM, loaded from SKILL.md files. Skills are NOT tools by default.

### Tool
An executable function the LLM can call (e.g., `bash`, `read`, `edit`). Skills are NOT tools.

### Extension
A pi plugin that can register tools, listen to events, and modify behavior. Both skills and pi-skill-guard are extensions.

### context event
A pi extension hook that fires before each LLM call, allowing message modification. This is the only hook that:
- Fires regardless of whether tools succeeded or failed
- Allows modifying the message history
- Returns values that actually affect what the LLM sees

## Key Insight

The extension uses the `context` event because it's the **only** pi extension hook that:
1. Fires for missing tools (unlike `tool_call` and `tool_result` which are never reached)
2. Allows modification (unlike `tool_execution_start` which is notification-only)

See ARCHITECTURE.md for detailed comparison of all approaches investigated.