# pi-skill-guard

一个用于防止错误的 skill-in-tool-call 行为的 pi 扩展。

## 安装

```bash
pi install npm:pi-skill-guard
```

---

## 功能说明

此扩展用于防止错误的 skill 调用模式。当 LLM 尝试调用一个与可用 skill 同名的工具时（例如，将 `brave-search` 作为工具调用，而不是使用 `/skill:brave-search` 或手动加载 skill），该扩展会**拦截错误信息并将其替换为 skill 的文档内容**。

### 工作原理

**关键机制**：扩展使用 `context` 事件在消息发送给 LLM 之前拦截并修复 "工具未找到" 错误。

1. **会话开始时**：加载所有可用的 skills 并缓存它们的路径
2. **LLM 调用错误的工具**：Agent 创建一个 "Tool X not found" 错误消息
3. **下一个 turn 之前**：扩展的 `context` 处理器拦截消息流
4. **检测并修复**：从 SKILL.md 文件读取实际的 skill 文档来替换错误
5. **LLM 看到成功**：LLM 接收的是 skill 内容而不是错误，从而可以从中学习

### 架构说明

`context` 事件在每次 LLM 调用之前的 `transformContext()` 中触发，允许我们：
- 非破坏性地修改消息（返回新数组）
- 用成功的结果替换工具结果错误
- 添加教育性提示，建议正确使用 `/skill:name` 命令

这种方法**比预先注册 skills 为工具更高效**，因为：
- ✅ 不会在每个请求中添加额外的工具模式而产生 token 开销
- ✅ 不会 clutter 可用工具列表
- ✅ 无需 TypeBox schema，代码更简单
- ✅ 更好的用户体验：实际加载 skill 文档而不只是警告

### 示例

如果模型错误地调用：
```json
{ toolName: "brave-search", input: { ... } }
```

**使用 skill-guard 之前：**
```json
// Agent 创建此错误消息
{
  role: "toolResult",
  toolCallId: "call_abc123",
  toolName: "brave-search",
  content: [{ text: "Tool brave-search not found" }],
  isError: true
}
```

**使用 skill-guard 之后：**
```json
// 扩展通过 context 事件拦截并替换为原始的 SKILL.md 内容：
{
  role: "toolResult",
  toolCallId: "call_abc123",
  toolName: "brave-search",
  content: [{ 
    text: `# brave-search
\nA pi extension for searching...

## Install
...
` // ← 实际的文件内容，无包装！
  }],
  details: {
    path: "~/.pi/agent/skills/brave-search/SKILL.md",
    sizeBytes: 1428,
    source: "skill_guard_intercept"
  },
  isError: false  // ← 已修复！
}
```

LLM 接收到与使用 `read` 工具读取 SKILL.md 文件完全相同的内容。

---

## 使用场景

- 防止模型在误解 skill 调用方式时失败
- 确保无论模型如何尝试使用 skill，都可以访问 skill 内容
- 透明工作，无需显式使用 `/skill:name` 命令