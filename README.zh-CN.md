# pi-skill-guard

一个用于防止错误的 skill-in-tool-call 行为的 pi 扩展。

## 安装

```bash
pi install npm:pi-skill-guard
```

---

## 功能说明

此扩展用于防止错误的 skill 调用模式。当 LLM 尝试调用一个与可用 skill 同名的工具时（例如，将 `brave-search` 作为工具调用，而不是使用 `/skill:brave-search` 或手动加载 skill），该扩展会拦截该调用并将其重定向到读取 skill 的 `SKILL.md` 文件。

### 工作原理

1. 监听 `tool_call` 事件
2. 检查工具名称是否匹配任何可用的 skill
3. 如果匹配，自动将工具调用转换为 `read` 工具调用，加载 skill 的 SKILL.md 文件
4. 通过 UI 通知用户该 skill 已被重定向

这确保即使模型错误地尝试将 skill 作为工具调用，仍能访问 skill 内容。

### 示例

如果模型错误地调用：
```
tool_call { toolName: "brave-search", input: {...} }
```

扩展将将其重定向为：
```
tool_call { toolName: "read", input: { path: "~/.pi/agent/skills/brave-search/SKILL.md" } }
```

---

## 使用场景

- 防止模型在误解 skill 调用方式时失败
- 确保无论模型如何尝试使用 skill，都可以访问 skill 内容
- 透明工作，无需显式使用 `/skill:name` 命令