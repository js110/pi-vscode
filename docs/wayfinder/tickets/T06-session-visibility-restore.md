---
id: T06
title: worktree 会话的可见性与恢复语义
type: grilling
status: closed
assignee: pi-agent
blocked-by: []
labels: wayfinder:grilling
---

## Question

worktree 的 Pi 会话存全局 `~/.pi/agent/sessions/<encoded-cwd>/`（建票后核查的事实，原表述"存 worktree 的 .pi 下"有误），但会话树按主 cwd 列出（SM.list(主cwd)），worktree 会话不可见，重启后 worktree tab 也不恢复（与普通 tab 一致）。v1 接受此限制并在文档说明（恢复 = Open Folder 同路径后从会话树打开，或重建同名 worktree 后 cwd 相同即可见），还是必须在会话树中可见？后者会产生新的实现票。

## Resolution

**定稿方案 a：v1 接受限制（2026-10-14，用户确认）**

- 分支是成果载体（T02 语义），对话随 tab 关闭封存于全局会话目录（文件不丢、UI 暂不可达）
- 找回路径：同名 slug 重建 worktree（cwd 相同 → encoded-cwd 相同 → 会话树重新列出）；README 写明
- 不做会话树多 cwd 列出/分组/存在性过滤（升级路径 b 清晰，若实测成为高频痛点再立项）
