---
id: T01
title: 命名约定——.pi/worktrees 与 pi/ 分支前缀
type: grilling
status: closed
assignee: pi-agent
blocked-by: []
labels: wayfinder:grilling
---

## Question

worktree 目录与分支命名采用 `.pi/worktrees/<slug>` + `pi/<slug>`（slug 保留中文、冲突加 8 位随机后缀）是否定稿？备选：`pi-vscode/worktrees`、分支前缀 `pi-agent/`，或可配置（Kilo 提供 branchPrefix 设置）。裁决影响 T08/T09/T10 的实现常量与 i18n 文案。

## Resolution

**定稿方案 ★（2026-10-14，用户按推荐确认）**：

- 目录：`<repoRoot>/.pi/worktrees/<slug>`（经 `.git/info/exclude` 追加 `/.pi/worktrees/` 隐蔽，不动用户 .gitignore）
- 分支：`pi/<slug>`；slug 保留中文（[^a-z0-9\u4e00-\u9fa5] → `-`）、陠30字符、冲突加 8 位随机 hex 后缀
- v1 硬编码常量（`WORKTREE_DIR` / `WORKTREE_BRANCH_PREFIX`），不做可配置项；真有需求再加
- 依据：Pi 的 `.pi` 目录只按特定文件名读项目配置、不递归扫描，worktrees/ 放里面不会被误读；与 Kilo `.kilo/worktrees` 同构
