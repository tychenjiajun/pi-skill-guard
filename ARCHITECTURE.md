# Architecture & Design Decisions

This document explains the design decisions behind pi-skill-guard and why we use the `context` event instead of other approaches.

## Problem Statement

When an LLM tries to call a tool that matches a skill name (e.g., `brave-search`) instead of using the proper `/skill:name` command, pi-agent-core throws "Tool not found" because skills are not registered as tools by default.

## Investigated Approaches

### ❌ Approach 1: Intercept at `tool_call` Event

```typescript
pi.on("tool_call", async (event) => {
  if (isSkillName(event.toolName)) {
    // Too late - validation already failed!
  }
});
```

**Problem**: The `tool_call` extension event fires in the `beforeToolCall` hook, which only executes **after** pi-agent-core validates that the tool exists. Missing tools never reach this hook.

**Flow**:
```
prepareToolCall() → check if tool exists → FAIL for missing tools → return immediate error
                                    ↓ Never reaches beforeToolCall hook
                            Extension's tool_call handler
```

---

### ❌ Approach 2: Pre-register Skills as Tools

```typescript
pi.on("session_start", async () => {
  const skills = await loadSkills();
  for (const skill of skills) {
    pi.registerTool({
      name: skill.name,
      parameters: Type.Object({...}),
      execute: ...
    });
  }
});
```

**Pros**: Works reliably because tools exist before validation.

**Cons**:
- 📈 Token overhead (~50-100 tokens per skill per request)
- 📋 Clutters the available tools list presented to LLM
- 🎯 May confuse LLM about whether it should call tools vs use `/skill:name`
- 🔧 Requires maintaining TypeBox schemas for all skills

---

### ❌ Approach 3: Intercept at `tool_execution_start`

```typescript
pi.on("tool_execution_start", async (event) => {
  // Can see toolName but cannot modify or block
});
```

**Problem**: This event is notification-only with no return value. Cannot prevent execution or modify arguments. Handler results are discarded by the framework.

---

### ❌ Approach 4: Fix at `tool_result` Event

```typescript
pi.on("tool_result", async (event) => {
  // Too late - this hook never fires for missing tools!
});
```

**Problem**: The `tool_result` extension event fires in the `afterToolCall` hook, which only executes for successfully prepared tools. Immediate errors skip the entire finalization process.

**Code evidence from pi-agent-core**:
```typescript
if (preparation.kind === "immediate") {
  finalized = { result: preparation.result, isError: true };
  await emitToolExecutionEnd(finalized, emit);
  continue; // ← Skips finalizeExecutedToolCall where afterToolCall lives!
}
```

---

### ✅ Approach 5: Intercepts at `context` Event (Chosen Solution)

```typescript
pi.on("context", async (event, ctx) => {
  const messages = [...event.messages];
  
  // Find "tool not found" errors for our skills
  for (const msg of messages) {
    if (msg.role === "toolResult" && 
        isSkillError(msg)) {
      
      // Replace with actual skill content
      const fixedMsg = {
        ...msg,
        content: [await readSkillDoc()],
        isError: false
      };
      
      // Fix in array
      messages[messages.indexOf(msg)] = fixedMsg;
    }
  }
  
  return modified ? { messages } : undefined;
});
```

**Why This Works**:

1. **Timing**: Fires in `transformContext()` before each LLM call, giving us access to all accumulated messages including tool result errors

2. **Modification Power**: Can return new message array to replace error messages with successful ones containing skill documentation

3. **No Token Overhead**: Doesn't add extra tools to the schema sent to LLM

4. **Clean UX**: LLM receives actual skill content instead of errors, can learn from it

5. **Educational**: Can add notes suggesting proper `/skill:name` usage

**Event Flow**:
```
Turn N: Assistant calls "brave-search" tool
  ↓
Agent creates toolResult { isError: true, text: "not found" }
  ↓
Add to context.messages[]
  ↓
Turn N+1 starts
  ↓
transformContext() fires
  ├─ Extension's context handler intercepts
  │   └─ Replaces error with skill documentation
  ↓
convertToLlm() converts AgentMessage[] to LLM format
  ↓
LLM sees successful tool result instead of error ✓
```

## Key Insights

### Why `context` Event Is Special

| Event | Fires For Missing Tool? | Can Modify? | Useful? |
|-------|------------------------|-------------|---------|
| `tool_execution_start` | ✅ Yes | ❌ No | ❌ Notification only |
| `tool_call` | ❌ No | ✅ Yes | ❌ Never reached |
| `tool_result` | ❌ No | ✅ Yes | ❌ Hook doesn't fire |
| `tool_execution_end` | ✅ Yes | ❌ No | ❌ Notification only |
| **`context`** | ✅ Yes | ✅ **Yes** | ✅ **Perfect!** |

The `context` event is the **only extension hook** that:
- Fires regardless of whether tools succeeded or failed
- Allows modifying the message history
- Returns values that actually affect what the LLM sees

### Message Mutation Pattern

```typescript
pi.on("context", async (event, ctx) => {
  const messages = [...event.messages]; // Deep copy is safe
  
  // Mutate messages
  const idx = messages.findIndex(m => shouldFix(m));
  if (idx !== -1) {
    messages[idx] = fixedMessage;
    return { messages }; // Return modified array
  }
  
  return undefined; // Or don't return anything
});
```

From types.d.ts:
> Fired before each LLM call. Can modify messages non-destructively. See Session Format for message types.
>
> event.messages - deep copy, safe to modify

## Future Enhancements

Potential improvements could include:

1. **Rate limiting notifications**: Don't spam UI for repeated errors
2. **Learning mechanism**: Track which skills get confused most often
3. **Custom fixers**: Allow extensions to register custom handlers for specific skill names
4. **Session stats**: Report how many errors were intercepted per session

## Conclusion

Using the `context` event provides the optimal balance of:
- ✅ Reliability (works for all error cases)
- ✅ Efficiency (no token overhead)
- ✅ Cleanliness (doesn't clutter tool list)
- ✅ Educational value (provides actual content to learn from)

This pattern demonstrates how understanding the event architecture enables elegant solutions within framework constraints.
