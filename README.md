# pi-skill-guard

A pi extension that guards against common model mistakes: wrong tool names, missing skills, broken argument schemas, and field name mismatches.

## Install

```bash
pi install npm:pi-skill-guard
```

---

## What it does

The extension intercepts tool errors via the `message_end` event and silently fixes them before the LLM sees a failure. Three guard cases:

### 1. Skill documentation injection

When the model calls a tool name that matches an available skill (e.g. `brave-search`), the extension replaces the "not found" error with the skill's `SKILL.md` content.

**Before:** `Tool brave-search not found` (error)
**After:** Full SKILL.md content injected as a successful tool result

### 2. Bash command execution

When the model calls an unknown tool that has a `command` argument, the extension executes it via pi's built-in bash tool. Supports optional `timeout` (number or string).

**Before:** `Tool my-script not found` (error)
**After:** Actual bash execution result with proper truncation and temp file management

### 3. Field alias normalization (`edit` / `write` / `read`)

When a tool call fails validation due to wrong field names, the extension scans the original arguments, renames common aliases, and re-executes correctly.

| Tool | Canonical | Accepted aliases |
|---|---|---|
| edit | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| edit | `edits[].oldText` | `old_str`, `old_string`, `oldContent`, `old`, `original`, `search` |
| edit | `edits[].newText` | `new_str`, `new_string`, `newContent`, `new`, `replacement`, `replace` |
| write | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| write | `content` | `text`, `body`, `code`, `data`, `fileContent`, `contents` |
| read | `path` | `file`, `filePath`, `file_path`, `target`, `filename`, `file_name` |
| read | `offset` | `start`, `startLine`, `start_line`, `from`, `line` |
| read | `limit` | `lines`, `maxLines`, `max_lines`, `count`, `numLines`, `num_lines` |

---

## Architecture

All interception happens in the `message_end` event, which fires after each message is finalized and allows replacing the message in place. Each tool call is tracked by ID to prevent double-handling across the replacement chain.

- `session_start`: loads skills, caches file paths
- `turn_end`: clears handled-tool-call tracking
- `message_end`: inspects error results, applies guards
