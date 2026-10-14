---
id: T11
title: 实现——关 tab 清理 + cleanWorktrees 命令
type: task
status: open
assignee:
blocked-by: [T02, T03]
labels: wayfinder:task
---

## Question

按 T02/T03 裁决实现双入口清理：(1) 关闭 worktree tab 钩子——abort（若在流式）→ auto-commit（提交信息来源按 T03）→ git worktree remove → 保留分支 → 通知；(2) `pi-agent.cleanWorktrees` 命令——porcelain 列出孤儿托管 worktree、QuickPick 多选（脏的禁选并标注）、remove + branch -D、i18n 文案与错误提示。
