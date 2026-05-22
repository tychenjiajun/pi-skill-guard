# pi-skill-guard

一个 pi 扩展，用于防止常见的模型错误：错误的工具名称、缺失的 skill、损坏的参数模式以及字段名不匹配。

## 安装

```bash
pi install npm:pi-skill-guard
```

---

## 功能说明

该扩展通过 `message_end` 事件拦截工具错误，并在 LLM 看到失败之前静默修复。包含三种保护：

### 1. Skill 文档注入

当模型调用与可用 skill 同名的工具时（例如 `brave-search`），扩展将"未找到"错误替换为 skill 的 `SKILL.md` 内容。

**修复前：** `Tool brave-search not found`（错误）
**修复后：** 完整的 SKILL.md 内容作为成功的工具结果注入

### 2. Bash 命令执行

当模型调用包含 `command` 参数的未知工具时，扩展通过 pi 内置的 bash 工具执行。支持可选的 `timeout`（数字或字符串）。

**修复前：** `Tool my-script not found`（错误）
**修复后：** 实际的 bash 执行结果（含截断和临时文件管理）

### 3. 字段别名规范化（`edit` / `write` / `read`）

当工具调用因字段名错误而验证失败时，扩展扫描原始参数、重命名常见别名并重新执行。

| 工具 | 标准字段 | 接受的别名 |
|---|---|---|
| edit | `path` | `file`、`filePath`、`file_path`、`target`、`filename`、`file_name` |
| edit | `edits[].oldText` | `old_str`、`old_string`、`oldContent`、`old`、`original`、`search` |
| edit | `edits[].newText` | `new_str`、`new_string`、`newContent`、`new`、`replacement`、`replace` |
| write | `path` | `file`、`filePath`、`file_path`、`target`、`filename`、`file_name` |
| write | `content` | `text`、`body`、`code`、`data`、`fileContent`、`contents` |
| read | `path` | `file`、`filePath`、`file_path`、`target`、`filename`、`file_name` |
| read | `offset` | `start`、`startLine`、`start_line`、`from`、`line` |
| read | `limit` | `lines`、`maxLines`、`max_lines`、`count`、`numLines`、`num_lines` |

> **Edit 工具简写支持**: 如果未提供 `edits` 数组，顶层的 `oldText`/`newText`（或它们的别名）会被自动包装为单元素 edits 数组。
>
> **Read 工具类型转换**: `offset` 和 `limit` 的字符串值（例如 `"10"` 而不是 `10`）会在有效时自动转换为数字。

---

## 架构

所有拦截均在 `message_end` 事件中处理，该事件在每条消息完成后触发，并支持原地替换消息。每个工具调用通过 ID 跟踪，防止在替换链中重复处理。

- `session_start`：加载 skills，缓存文件路径
- `turn_end`：清除已处理的工具调用跟踪
- `message_end`：检查错误结果，应用保护机制
