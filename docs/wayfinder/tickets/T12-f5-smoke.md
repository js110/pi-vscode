---
id: T12
title: F5 冒烟——全链路验收清单
type: task
status: open
assignee:
blocked-by: [T08, T09, T10, T11]
labels: wayfinder:task
---

## Question

Extension Development Host 中人工验收：创建（分支/目录/exclude 生效、Open Folder）、隔离（agent 编辑不碰主仓、主仓 status 无 .pi/worktrees）、并行（两 worktree tab 同时流式）、**关 tab 清理链路（空闲/流式两种情形：auto-commit → 删 worktree → 留分支 → 通知，对话历史仍在全局会话）**、cleanWorktrees（孤儿清理、干净删/脏拒删）、错误路径（非 git 目录）。发现的问题回灌地图（见 Not yet specified）。
