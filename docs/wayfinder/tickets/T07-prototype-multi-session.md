---
id: T07
title: 原型验证——多 SessionManager 并行与 cwd 穿线
type: prototype
status: open
assignee: pi-agent
blocked-by: []
labels: wayfinder:prototype
---

## Question

最小薄切片验证：TabFactory.create({cwd}) → PiSessionManager.initialize({cwd}) 穿线后，主 tab 与第二 cwd 的 tab 并存（可手动建临时目录模拟 worktree），两个 tab 并行流式互不串扰（事件路由、状态栏、审批 UI）。产出：穿线补丁（非最终形态）+ F5 实测结论，作为 T09 的依据。
