# ROADMAP — 向 Copilot / Claude Code 水平演进

> 制定日期：2026-09-14。基于对扩展宿主侧与 Webview 侧的全量代码分析（providers/、pi/、bridge/、webview/、shared/protocol.ts），对标 GitHub Copilot Chat 与 Claude Code VS Code 扩展的功能基准。

## 现状定位

后端能力已完整：27 个 IDE bridge RPC 工具 + 6 类事件推送、工具审批机制、checkpoint undo/redo、会话持久化、状态栏遥测（cost/缓存命中率/上下文用量）。短板集中在前端交互形态——当前是"聊天侧边栏"，对标产品是"长在编辑器里的"。

## 差距清单

| # | 能力 | Copilot / Claude Code | 现状 | 差距 |
|---|------|----------------------|------|------|
| 1 | Inline Chat（编辑器内 Ctrl+I） | ✅ 核心入口 | ❌ 全部交互在侧边栏 | 大 |
| 2 | 选中代码 → 右键/浮动操作 | ✅ Explain/Fix/Refactor | ❌ 无 | 大 |
| 3 | @-mention 文件/符号补全 | ✅ | ❌ 无 | 中 |
| 4 | 图片/截图粘贴输入 | ✅ | ⚠️ 协议已有 `images` 字段（protocol.ts:99），UI 未发送 | 小 |
| 5 | 代码块语法高亮 | ✅ | ❌ 无（main webview messages.ts:26 仅 Copy 按钮） | 中 |
| 6 | 代码块 Apply/插入编辑器 | ✅ | ❌ 无（bridge `applyWorkspaceEdit` 可复用） | 中 |
| 7 | 工具审批"总是允许"记忆 | ✅ 会话/持久两级 | ⚠️ 仅全局开关（pi/session.ts:305） | 小 |
| 8 | 自动 compaction | ✅ 阈值自动触发 | ⚠️ 仅手动命令（pi/session.ts:159） | 小 |
| 9 | 流式渲染性能 | 有优化 | ⚠️ 每 delta 全量重渲染 markdown（webview main.ts:1038） | 中 |
| 10 | Plan/Agent 模式切换 | ✅ | ❌ 无（TODO.md 原作者意图即 "* Modes"） | 中 |
| 11 | TODO 任务进度卡片 | ✅ | ❌ 无 | 小 |
| 12 | 终端内交互 / commit 生成 | ✅ | ❌ 无（bridge 已有 reportTerminalSession） | 中 |
| 13 | 拖拽文件进对话 | ✅ | ❌ 无 | 小 |
| 14 | 子代理/后台任务面板 | ✅ (Claude Code) | ❌ 无 | 大（后置） |

已达标无需改动：多 tab 会话、模型/thinking 切换、steer/消息队列、原生 diff 视图、checkpoint、会话历史、状态栏遥测、Esc 中断。

## 开发路线

### 阶段 0 — 建立基线

`npm install && npm run compile`，F5 实际试用，确认现有功能可用。

### 阶段 1 — 接线已有能力 + 补渲染（性价比最高）

- [ ] #4 图片输入：webview 输入框支持粘贴/选择图片，填入协议已有字段
- [ ] #5 代码块语法高亮（shiki 或 highlight.js）
- [ ] #6 代码块 Apply 按钮 → 走 bridge `applyWorkspaceEdit`
- [ ] #7 审批记忆：按工具"总是允许"（会话级 → 持久级）
- [ ] #8 自动 compaction：超过阈值自动触发
- [ ] #9 流式增量渲染：markdown 增量更新或节流
- [ ] #12 commit message 生成命令（SCM 输入框贡献）

### 阶段 2 — 长进编辑器（对标 Copilot 的关键一步）

- [ ] #2 选中代码右键菜单 → 带选区上下文发送到聊天（bridge 选区事件已有）
- [ ] #3 @-mention 文件/符号补全（补全源用 bridge `workspaceSymbols`/文档符号 RPC）
- [ ] #13 拖拽文件进对话
- [ ] #1 Inline Chat（VS Code interactive editor API 或自制 hover 面板）

### 阶段 3 — 模式与进阶

- [ ] #10 Plan/Agent 模式切换
- [ ] #11 TODO 进度卡片
- [ ] #12 终端集成
- [ ] #14 子代理/后台任务展示
