# Architecture & Design Decisions

This document explains the design decisions behind pi-skill-guard and pi-arg-corrector.

## Problem Statement

LLMs make two kinds of tool call mistakes:

1. **Tool not found** — calling a tool name that matches a skill (e.g., `brave-search`) instead of using `/skill:name`, or calling a nonexistent tool with a `command` argument
2. **Wrong argument names** — calling `edit` with `file` instead of `path`, or `old_str` instead of `oldText`

These are separate problems requiring separate solutions.

## Solution: Two Extensions

### pi-skill-guard — "tool not found" interception

Uses `message_end` event to detect "tool not found" errors and:
- **Case 1**: If tool name matches a skill → inject SKILL.md content
- **Case 2**: If unknown tool has `command` arg → execute via bash

**Why `message_end`?**

| Event | Fires for missing tool? | Can modify result? |
|---|---|---|
| `tool_call` | ❌ No | ✅ Yes |
| `tool_result` | ❌ No | ✅ Yes |
| `tool_execution_end` | ✅ Yes | ❌ No |
| **`message_end`** | ✅ **Yes** | ✅ **Yes** |

The `tool_call` and `tool_result` events never fire for missing tools — pi-agent-core short-circuits before reaching them. `message_end` is the only hook that fires for all tool results including "not found" errors.

### pi-arg-corrector — argument alias normalization

Uses `prepareArguments` on overridden built-in tools to fix alias field names before schema validation.

**Why `prepareArguments` + tool override?**

| Approach | Pros | Cons |
|---|---|---|
| `message_end` + re-execute | Works | Double execution, error visible to LLM, needs session scanning |
| `tool_call` mutation | Clean, no re-execution | Mutates in place, couples to event ordering |
| **`prepareArguments` override** | **Cleanest — normalizes before validation, built-in execute/renderer inherited** | **Needs `cwd` at registration (from `session_start`)** |

The override approach uses `createEditToolDefinition(cwd)` to get the full built-in tool definition (execute, renderer, schema), then adds `prepareArguments` to normalize aliases. The LLM never sees a validation error — the normalized args pass validation on the first try.

## Investigated Approaches (Rejected)

### ❌ `tool_call` event for "tool not found"

`tool_call` fires in `beforeToolCall` hook, which only executes **after** pi-agent-core validates that the tool exists. Missing tools never reach this hook.

### ❌ `tool_result` event for "tool not found"

`tool_result` fires in `afterToolCall` hook, which only executes for successfully prepared tools. Immediate errors skip finalization entirely.

### ❌ Pre-register skills as tools

Works but adds token overhead (~50-100 tokens per skill per request), clutters the tools list, and may confuse LLM about tool vs skill usage.

### ❌ `context` event

Works (fires for all messages, allows modification), but `message_end` is more targeted — it fires per-message rather than requiring scanning the full message array each LLM call.
