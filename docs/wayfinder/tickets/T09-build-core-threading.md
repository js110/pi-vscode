---
id: T09
title: 实现——tab/session/protocol 核心穿线
type: task
status: open
assignee:
blocked-by: [T07, T01]
labels: wayfinder:task
---

## Question

按 T07 验证结论生产化：session.ts initialize({cwd})、TabFactory options、tab.ts createWorktreeTab（经 adapters.worktree 注入，保持 tab.ts 零 git 依赖）、TabInfo.worktreeBranch 协议字段、tab.ts 单测（mock adapter）。
