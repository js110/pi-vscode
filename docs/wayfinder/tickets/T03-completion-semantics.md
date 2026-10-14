---
id: T03
title: 关 tab 清理语义——流式关闭与提交信息来源
type: grilling
status: closed
assignee: pi-agent
blocked-by: []
labels: wayfinder:grilling
---

## Question

T02 已定"关 tab 即清理（auto-commit → 删 worktree → 留分支）"，剩余两个实现语义待裁决：

1. **流式中关 tab**：agent 正在写文件时关闭——先 abort 再走清理（推荐，与普通 tab 关闭一致），还是拒绝关闭？
2. **提交信息来源**：AI 生成（复用现有 CommitMessageManager，失败回退固定文案）vs 固定文案（`pi: <任务名>`，零成本但无描述力）？

顺带确认清理完成后的通知文案（信息提示"已提交至 pi/x 并清理 worktree"，带分支名）。

## Resolution

**两个子问题均定案（2026-10-14，用户均选方案 a）：**

1. **流式中关 tab = abort + 清理**：先 abort agent → 等 `agent_settled` 落定 → auto-commit 已写内容 → 删 worktree → 留分支。关闭意图被尊重，半成品落在分支可找回。
2. **提交信息 = AI 生成 + 固定回退**：复用现有 `CommitMessageManager`（已接会话模型）；AI 失败/超时回退 `pi: <任务名>`，绝不因 AI 失败阻塞删除。
3. **整体异步**：关 tab 界面立即消失，清理链路后台执行，完成后信息提示"已提交至 pi/x 并清理 worktree"（含分支名）。
