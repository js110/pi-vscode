---
id: T05
title: 改动回主线的审阅流——v1 最小形态
type: grilling
status: closed
assignee: pi-agent
blocked-by: []
labels: wayfinder:grilling
---

## Question

任务完成后用户如何审阅并合回改动？PRD v1 只有"Open Folder 新窗口"。备选增强：worktree tab 的 Changed Files 区直接显示 vs base 分支的 diff（复用现有 DiffManager）；或提供"在主仓 cherry-pick/merge 该分支"按钮。裁决决定 T10 是否含 diff 视图入口。

## Resolution

**定稿方案 a：最小审阅（2026-10-14，用户确认）**

- 审阅入口 = worktree tab 现有 Changed Files 区：DiffManager 快照式对比在 worktree 场景天然等于 vs 基线（worktree 起点为基线干净检出），随 T09 cwd 穿线自动成立，零新增代码
- 辅以 Open Folder 按钮 + README 合并指引（`git merge pi/<任务名>`）
- 不做显式基线对比入口（b，与快照 diff 冗余）；不做 merge/cherry-pick 按钮（c，对主仓破坏性变更，v1 越界）
- 已知残余缺口（接受）：重启恢复会话后快照丢失 → Changed Files 变空，审阅退路为 Open Folder + git diff
