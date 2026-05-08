# pi-skill-guard

A pi extension for protecting against incorrect skill-in-tool-call behavior.

## Install

```bash
pi install npm:pi-skill-guard
```

---

## What it does

This extension protects against incorrect skill invocation patterns. When an LLM tries to call a tool name that matches an available skill (e.g., calling `brave-search` as a tool instead of using `/skill:brave-search` or loading the skill manually), this extension **intercepts the error** and replaces it with the skill's documentation.

### How it works

**Key insight**: The extension uses the `context` event to intercept and fix "tool not found" errors right before they're sent to the LLM.

1. **Session start**: Load all available skills and cache their file paths
2. **LLM calls wrong tool**: Agent creates a "Tool X not found" error message
3. **Before next turn**: Extension's `context` handler intercepts the message flow
4. **Detect & fix**: Replaces error with actual skill documentation from SKILL.md file
5. **LLM sees success**: Instead of an error, the LLM receives the skill content and can learn from it

### Architecture note

The `context` event fires in `transformContext()` before each LLM call, allowing us to:
- Modify messages non-destructively (returns new array)
- Replace tool result errors with successful results
- Add educational notes suggesting proper `/skill:name` usage

This is **more efficient than pre-registering skills as tools** because:
- ✅ No token overhead from adding extra tool schemas to every request
- ✅ No cluttering the available tools list
- ✅ Simpler code without TypeBox schemas
- ✅ Better UX: actually loads skill documentation instead of just warning

### Example

If the model incorrectly calls:
```json
{ toolName: "brave-search", input: { ... } }
```

**Without skill-guard:**
```json
// The agent creates this error message
{
  role: "toolResult",
  toolCallId: "call_abc123",
  toolName: "brave-search",
  content: [{ text: "Tool brave-search not found" }],
  isError: true
}
```

**With skill-guard:**
```json
// Extension intercepts via context event and replaces with raw SKILL.md content:
{
  role: "toolResult",
  toolCallId: "call_abc123",
  toolName: "brave-search",
  content: [{ 
    text: `# brave-search
\nA pi extension for searching...

## Install
...
` // ← Actual file content, no wrapping!
  }],
  details: {
    path: "~/.pi/agent/skills/brave-search/SKILL.md",
    sizeBytes: 1428,
    source: "skill_guard_intercept"
  },
  isError: false  // ← Fixed!
}
```

The LLM receives exactly the same content as if it had used the `read` tool on the SKILL.md file.

---

## Use cases

- Prevents model from failing when it misunderstands skill invocation
- Ensures skill content is always accessible regardless of how the model tries to use it
- Works transparently without requiring explicit `/skill:name` commands