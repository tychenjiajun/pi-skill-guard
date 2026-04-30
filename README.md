# pi-skill-guard

A pi extension for protecting against incorrect skill-in-tool-call behavior.

## Install

```bash
pi install npm:pi-skill-guard
```

---

## What it does

This extension protects against incorrect skill invocation patterns. When an LLM tries to call a tool name that matches an available skill (e.g., calling `brave-search` as a tool instead of using `/skill:brave-search` or loading the skill manually), this extension intercepts the call and redirects it to read the skill's `SKILL.md` file instead.

### How it works

1. Listens to the `tool_call` event
2. Checks if the tool name matches any available skill
3. If matched, automatically converts the tool call to a `read` tool call that loads the skill's SKILL.md file
4. Notifies the user via UI that the skill was redirected

This ensures the LLM can still access the skill content even when it incorrectly tries to invoke the skill as a tool.

### Example

If the model incorrectly calls:
```
tool_call { toolName: "brave-search", input: {...} }
```

The extension will redirect it to:
```
tool_call { toolName: "read", input: { path: "~/.pi/agent/skills/brave-search/SKILL.md" } }
```

---

## Use cases

- Prevents model from failing when it misunderstands skill invocation
- Ensures skill content is always accessible regardless of how the model tries to use it
- Works transparently without requiring explicit `/skill:name` commands