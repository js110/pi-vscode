---
id: T02
title: 清理策略——默认保留 + 显式命令清理
type: grilling
status: closed
assignee: pi-agent
blocked-by: []
labels: wayfinder:grilling
---

## Question

v1 采用保守策略：关闭 worktree tab 不自动删 worktree，仅提供 `pi-agent.cleanWorktrees` 显式清理（多选、脏 worktree 拒删）——是否定稿？备选：Copilot 式"关闭即清理（auto-commit 后删）"。

## Resolution

**定稿方案 b（2026-10-14，用户选择）：关 tab 即清理（Copilot 式）**

- 关闭 worktree tab：auto-commit 未提交改动 → 删 worktree → **保留分支**（可恢复）
- 实现语义（流式关闭处理、提交信息来源）由重写后的 T03 裁决
- `cleanWorktrees` 命令仍保留：VS Code 重启/崩溃/多窗口场景下孤儿 worktree 仍需显式清理入口（scope 并入 T11）
- 事实佐证（建票后核查）：Pi 会话存全局 `~/.pi/agent/sessions/<encoded-cwd>/`，删 worktree 不丢对话历史（SDK `session-manager.js:1314`）
