# pi-skill-guard

A pi extension that intercepts "tool not found" errors: injects skill documentation for matching skill names and falls back to bash for unknown tools with a command argument.

## Install

```bash
pi install npm:pi-skill-guard
```

---

## What it does

The extension intercepts tool errors via the `message_end` event and silently fixes them before the LLM sees a failure. Two guard cases:

### 1. Skill documentation injection

When the model calls a tool name that matches an available skill (e.g. `brave-search`), the extension replaces the "not found" error with the skill's `SKILL.md` content.

**Before:** `Tool brave-search not found` (error)
**After:** Full SKILL.md content injected as a successful tool result

### 2. Bash command execution

When the model calls an unknown tool that has a `command` argument, the extension executes it via pi's built-in bash tool. Supports optional `timeout` (number or string).

**Before:** `Tool my-script not found` (error)
**After:** Actual bash execution result with proper truncation and temp file management

---

## Related

For field alias normalization (`edit` / `write` / `read` argument correction), see [pi-arg-corrector](https://github.com/tychenjiajun/pi-arg-corrector).

---

## Architecture

All interception happens in the `message_end` event, which fires after each message is finalized and allows replacing the message in place. Each tool call is tracked by ID to prevent double-handling across the replacement chain.

- `session_start`: loads skills, caches file paths
- `turn_end`: clears handled-tool-call tracking
- `message_end`: inspects error results, applies guards
