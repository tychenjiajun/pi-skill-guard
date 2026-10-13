# pi-skill-guard

一个 pi 扩展，用于拦截"工具未找到"错误：为匹配的 skill 名称注入文档，并对包含 `command` 参数的未知工具回退到 bash 执行。

## 安装

```bash
pi install npm:pi-skill-guard
```

---

## 功能说明

该扩展通过 `message_end` 事件拦截工具错误，并在 LLM 看到失败之前静默修复。包含两种保护：

### 1. Skill 文档注入

当模型调用与可用 skill 同名的工具时（例如 `brave-search`），扩展将"未找到"错误替换为 skill 的 `SKILL.md` 内容。

**修复前：** `Tool brave-search not found`（错误）
**修复后：** 完整的 SKILL.md 内容作为成功的工具结果注入

### 2. Bash 命令执行

当模型调用包含 `command` 参数的未知工具时，扩展通过 pi 内置的 bash 工具执行。支持可选的 `timeout`（数字或字符串）。

**修复前：** `Tool my-script not found`（错误）
**修复后：** 实际的 bash 执行结果（含截断和临时文件管理）

---

## 相关扩展

字段别名规范化（`edit` / `write` / `read` 参数修正），请参见 [pi-arg-corrector](https://github.com/tychenjiajun/pi-arg-corrector)。

---

## 架构

所有拦截均在 `message_end` 事件中处理，该事件在每条消息完成后触发，并支持原地替换消息。每个工具调用通过 ID 跟踪，防止在替换链中重复处理。

- `session_start`：加载 skills，缓存文件路径
- `turn_end`：清除已处理的工具调用跟踪
- `message_end`：检查错误结果，应用保护机制
