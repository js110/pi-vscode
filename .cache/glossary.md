# 术语表（Glossary）

> Phase 1 调研沉淀；Phase 2 拷问中增量追加。来源：CONTEXT.md（项目领域词汇）+ 代码分析（2026-09-14）。

## 项目既有术语

| 术语 | 定义 |
|------|------|
| Tab（标签页） | 一个独立的 Pi 对话。每个 Tab 拥有自己的会话、diff 跟踪与 checkpoint，状态不跨 Tab 共享 |
| TabManager | 拥有所有 Tab 完整生命周期的核心模块：创建、会话替换、活跃选择、事件归约、流式状态、工具审批、diff/checkpoint 协调 |
| SidebarProvider | 薄的 webview 适配层：转发 ClientMessage 到 TabManager，回发 ServerMessage，持有零 Tab 状态 |
| Turn（轮次） | 一个 Tab 内一次"提示词-回复"循环，单调递增，checkpoint 与 diff 共用同一序号 |
| Checkpoint（检查点） | 按轮次的文件前后快照，用于回滚（undo）与重放（redo） |
| Tool approval（工具审批） | 拦截待执行的工具调用，弹出审批卡片由用户放行/拒绝；实现为对 SDK emitToolCall 的包装 |
| IDE Bridge | 本地令牌认证的 HTTP 服务，把 VS Code 编辑器能力（选区、诊断、符号、Code Actions、WorkspaceEdit 等）暴露为 Pi 工具 |
| Compaction（上下文压缩） | 上下文接近窗口上限时的摘要压缩机制，当前为手动触发 |
| Steer（转向） | 流式进行中插入的中断性引导消息（立即影响当前生成） |
| FollowUp / 队列 | 流式进行中排队的后续消息，当前轮结束后依序发送 |
| Session（会话） | Pi 的持久化对话记录，可加载/重命名/恢复 |
| Skill（技能） | Pi 的资源化提示词扩展，经 `/` 命令菜单调用 |
| Thinking Level（思考级别） | 推理深度档位：off/minimal/low/medium/high |
| Extension Host | VS Code 扩展主进程（Node.js 环境），持有 vscode API 与 Pi SDK |
| Webview | 聊天 UI 所在的 iframe 沙箱（纯浏览器环境，无 Node/vscode API） |
| SecretStorage | VS Code 提供的加密凭据存储，API key 专用，禁止明文 |
| Protocol（消息协议） | src/shared/protocol.ts 中定义的宿主↔webview 类型化消息集合 |

## 本次改造新增概念（Phase 2 收敛中）

| 术语 | 定义（暂定） |
|------|------|
| 图片输入 | 聊天输入框粘贴/选择图片并随消息发送给模型 |
| 代码块 Apply | 把聊天回复中的代码块一键写入/插入编辑器文件 |
| 审批记忆 | 按"工具名"记住放行决定（每个工具一个总开关，含本会话/全局范围），免重复审批 |
| 自动压缩（自动 compaction） | 上下文用量超过阈值时提示用户，确认后触发压缩 |
| Pi 配置发现 | 插件启动时自动读取用户已配置好的 Pi 凭证/模型/技能/会话；未检测到配置时呈现明确错误态（不内置向导、不引导安装） |
| Inline Chat | 编辑器内部直接呼出的对话（不离开代码） |
| @-mention | 输入 @ 引用文件/符号并作为上下文注入 |
| Plan 模式 | 只读规划模式：先产出计划、经确认再执行修改 |
| 界面改版 | 聊天 Webview 的整体视觉与布局重设计（含新图标），需承载本批全部新交互 |
