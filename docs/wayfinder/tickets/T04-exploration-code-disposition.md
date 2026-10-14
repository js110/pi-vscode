---
id: T04
title: 探索代码处置——修正后沿用
type: grilling
status: closed
assignee: pi-agent
blocked-by: []
labels: wayfinder:grilling
---

## Question

已冻结的 `src/utils/git-worktree.ts`（纯函数+注入 exec）与配套单测，按 PRD 修正（path.join、porcelain 解析规范化）后作为 T08 的起点沿用——还是丢弃重写？

## Resolution

**定稿：修正后沿用（2026-10-14，用户选方案 a）**。T08 以冻结稿为底，修复四项欠账：

1. 路径拼接改 `path.join`（Windows 兼容）
2. porcelain 前缀匹配做路径规范化（`path.resolve` 两侧）
3. 清除 `ensureExcluded` 的 `void stat` 残留
4. 过 `npm run check`（typecheck + 编译）并跑单测

不重写；测试资产（mock exec 全覆盖）随用例同步更新。
