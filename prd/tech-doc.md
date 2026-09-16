# pi-vscode 实现技术方案（tech_doc）

> 依据 `prd/PRD.md` v1.4（冻结契约）与 `ROADMAP.md` 差距清单；全程遵守 `AGENTS.md` 约定：双 bundle（宿主 CJS / webview IIFE）、协议先行（protocol.ts 先加类型再写 handler）、`loadPiSdk()` 唯一网关 + feature-detect、Tab 隔离、SecretStorage 存密、webview 无框架无 CDN。

## 1. 架构基线（现状，保留不动）

| 层 | 现有模块 | 说明 |
|---|---------|------|
| 扩展宿主 | `extension.ts` → `providers/tab.ts` TabManager | 每 Tab 独立 PiSessionManager + DiffManager + CheckpointManager（6.1 实体关系落点） |
| Pi 接入 | `src/pi/compat.ts` `loadPiSdk()` 唯一网关 | 系统 Pi 优先 + 内置兜底；`scripts/check-pi-api.mjs` 审计新用到的 API |
| 审批钩子 | `src/pi/session.ts` emitToolCall 包裹 | 工具执行前唯一拦截点 → 审批记忆在此落地 |
| IDE Bridge | `src/bridge/` 27 工具 + 6 事件 | `applyWorkspaceEdit` / `reportTerminalSession` / `workspaceSymbols` 等已有，直接复用 |
| Webview | `webview/main.ts` + `settings.ts`（vanilla TS + `el()`） | 经 `src/shared/protocol.ts` 类型化 postMessage；marked 渲染 markdown |
| 渲染纯函数 | `webview/render/messages.ts` | 无状态 DOM builder，happy-dom 可测，保持纯度 |

## 2. 新增/改造组件

| # | 组件 | 位置 | 职责与关键规则 |
|---|------|------|---------------|
| C1 | 配置发现 ConfigDiscovery | `src/pi/config.ts`（新） | 激活时只读发现：auth.json 凭证、models.json 模型（SDK ModelRegistry + 自定义合并语义）、loadSkills 技能、会话目录列表；状态机（未检测/已发现/错误态/刷新中/部分可用）按 PRD 6.3；解析失败保留旧列表 + 文件级错误；拉取式热刷新（打开选择器/手动），无后台监听；**永不写 `~/.pi/agent`** |
| C2 | 审批记忆 ApprovalMemory | `src/pi/approval-memory.ts（新）+ src/shared/tool-safety.ts（危险工具判定单源）`（新） | 规则 {tool, scope: session\|global, createdAt}；session 档挂 TabManager 随 Tab 清除，global 档存 globalState；危险工具（bash/powerShell 等 shell 执行类）永不命中、禁止记忆；命中自动放行 → 产生痕迹条目（来源=记忆）；未命中走既有审批卡 round-trip，卡上新增"允许并记住（本会话/全局）"；设置页列表/逐条撤销（即时生效）/一键清空 |
| C3 | 代码块高亮 + Apply | webview render + 宿主 `providers/apply.ts`（新） | highlight.js 本地打包（禁 CDN）；Apply → 宿主计算目标文件候选 + Myers diff 预览回传 → 确认经 WorkspaceEdit 写入 → 纳入 CheckpointManager 一步撤销；预览与确认间文件 mtime 变化 → 冲突阻止（11.2）；防抖 5s |
| C4 | 流式增量渲染 | `webview/main.ts` 渲染管线改造 | 每 delta 只 patch 最后一条 assistant 消息块（不整块重绘）；marked 解析按消息节流（rAF 合帧）；代码块/表格增量重建；滚动锚定；目标 AC-OP-01（≥2000 token 无卡顿） |
| C5 | 压缩提示流 | `src/pi/session.ts` + webview | 监听 context 用量（SDK calculateContextTokens / queue 事件）；超阈值（配置 contextUsageWarningThreshold，默认 80%）发提示条（保留清单：计划/TODO/队列未发送消息）；确认 → SDK 原生 compact；失败保持原上下文提示（11.4）；"暂不"同区间不重复、90% 重新提示；保留手动 /compact |
| C6 | 图片输入 | webview 输入区 + protocol images 字段（已预留） | 粘贴/按钮/拖拽；按当前模型能力（models.json 元数据）动态启用；不支持置灰 + 点击/粘贴明确提示；图片随消息入 pi 会话格式 |
| C7 | 编辑器交互组 | contributes + webview | 右键菜单"发送到 Pi"（选区+路径+行号 → 当前 Tab / 流式中入队 / 无 Tab 新建）；@-mention 补全浮层（文件 findFiles + workspaceSymbols，无索引降级仅文件）；拖拽文件转引用（同 @ 注入路径） |
| C8 | Plan 模式 | `src/providers/plan.ts`（新）+ session | 规划中 = SDK readOnly 工具集白名单，写类调用直接拒绝；计划卡（可微调/重规划）→ 批准 = 计划内非危险工具放行凭据（留痕来源=Plan 批准）→ 按步执行 + TODO 实时勾选；Esc → 已完成步骤保留、未执行取消；失败暂停态（步骤失败/危险工具弹卡/写冲突/限流/401）可续跑/调整重批/放弃；状态机 8.5 |
| C9 | TODO 卡片 | protocol + webview | 计划步骤实时状态（待执行/执行中/已完成/失败/已取消）；压缩保活 |
| C10 | 终端集成 + commit 生成 | `providers/terminal-capture.ts`（新）+ SCM contributes | AI 读取终端输出 = shell integration 捕获（方案见 §2.2；reportTerminalSession 仅 session 关联）+ webview"引用终端"按钮；SCM 输入框旁按钮 → diff 生成 message 只填入不提交 |
| C11 | 后台任务面板 | protocol + webview | SDK 子代理事件呈现（运行中/完成/失败/可取消），不本地建模；后台失败发通知 |
| C12 | UI 改版 + i18n 集中层 | `webview/styles/main.css` 重写 + `src/shared/webview-text.ts` 升级 | 按 ui/ 原型移植：tokens（--proto-* 对齐 --vscode-*）、Header/Tab 条/消息流/输入区/Footer 骨架、审批卡/提示条/Changed Files/计划卡组件化；文案集中层唯一出口，中/英双语 + 语言设置（VS Code 侧，不回写 Pi） |
| C13 | Inline Chat | 编辑器内浮层（Q1 spike 已定：自绘方案，见 §2.1） | 选区呼出行内输入 → 行内 diff 预览（未落盘）→ 接受（纳入 Tab checkpoint）/放弃（中间工具写入按本轮 checkpoint 回滚）；轮次归属活跃 Tab；先 spike 后实做（PRD 风险预案：批内最后集成） |

### 2.1 C13 Inline Chat spike 结论（Q1，2026-09-15）

**结论：原生 inline chat 不可用（proposed API），采用 100% 稳定 API 自绘组合方案。**

- 原生路径（`chat.createChatParticipant` + `ChatLocation.Editor` / `ChatResponseTextEditPart`）：已核对 `@types/vscode` 1.116.0 完整 d.ts，`ChatLocation`、`ChatRequest.location2`、`ChatResponseTextEditPart` 均不存在——编辑器位置参与仍属 proposed API（Marketplace 禁用），**排除**。
- `ContentWidget` 自绘输入框：稳定 API 不允许扩展创建，**排除**。
- `CommentController`/`CommentThread` 伪行内输入（stable 可用）：评论区 chrome（"Comments" 标题/线程生命周期/经 `comments/commentThread/context` 命令参数 `CommentReply` 提交），样式不可控、UX 错位，**不采纳**。
- **采用方案（全部稳定 API）**：
  1. 呼出：`pi-agent.inlineChat` 命令（editor/context 菜单 + keybinding），选区经 `buildSelectionPrompt`（复用 C7）作上下文，输入用 `window.createInputBox`（Esc 取消；单行限制记为已知差异）。
  2. 轮次归属活跃 Tab：指令经 TabManager 正常 `prompt` 分发（流式中拒绝并提示），中间工具调用/审批/流式渲染复用面板现有链路。
  3. 行内 diff：round 开始时快照目标文件内容；订阅该 Tab DiffManager `onFileChange`（`turnIndex ≥ 本轮首 turn`），`computeUnifiedDiff(base, current)` 解析 hunk 得变更行区间，用 `TextEditorDecorationType` 高亮；工具照常落盘，"未落盘"为 round 级 pending 视图语义（PRD 9.4 与 AC-FN-11 的口径统一：pending = 可一次回滚）。
  4. 接受/放弃（round 级，状态栏两项 + 命令 + 键）：接受 = 清 pending（本轮 checkpoint 已在链上，仍可继续 undo）；放弃 = `restoreCheckpoint(firstTurnIdx - 1)` 一次回到最初（多轮含在内，AC-FN-11）。
  5. 冲突（AC-FN-12）：呼出时缓冲 dirty 先要求保存；轮内/评审期手改 → 冲突提示 + pending 置灰，放弃时 modal 确认不静默覆盖。
  6. 生成中断：abort 后 `agent_settled` → 有变更则进 pending 评审态（置灰可查看），接受/放弃仍可用。

### 2.2 C10 终端集成设计（T13，2026-09-15）

**勘误 + API 核实（@types/vscode 1.116.0 稳定 d.ts）**：C10 原文"reportTerminalSession 已有"不准确——bridge 的 `reportTerminalSession` 仅把 pi CLI 终端与其 sessionFile 关联（terminalId↔sessionFile，供面板跳转），**不读终端输出**。稳定 API 面核实：

- 可用（stable）：`window.activeTerminal`、`onDidChangeActiveTerminal`、`onDidStart/EndTerminalShellExecution`、`TerminalShellIntegration.executeCommand`、`TerminalShellExecution.read()`（AsyncIterable，仅含 read 调用后写入的数据）、`Terminal.state`。
- 不可用（proposed）：`Terminal.selection`（terminalSelection）、`onDidWriteTerminalData`（terminalDataWriteEvent，读既有 scrollback 唯一途径）、`onDidChangeTerminalSelection`。→ **无法程序化读取用户选区/历史 scrollback**。

**方案（100% 稳定 API，shell integration 捕获路径）**：

1. **捕获**：`providers/terminal-capture.ts` 新增 `TerminalCapture`——订阅 `onDidStartTerminalShellExecution`（立即 `execution.read()` 起异步累积，带字符上限防失控）+ `onDidEndTerminalShellExecution`（终结为 {command, output, terminalName}，按 Terminal 对象键存最近一次；跨终端再存全局最近）+ `onDidCloseTerminal`（清除该终端条目与在飞 run，防泄漏）。命令被中断导致 end 不触发时该次捕获弃用。
2. **纯模块**：`shared/terminal-quote.ts`——`stripAnsi`（CSI/OSC/控制序列，含 `\r` 归一）、`truncateTerminalOutput`（上限 8000 字符，保尾部并标注省略，错误通常在末尾）、`formatTerminalQuote`（复用 `fenceFor` 自动加长围栏，体内容 `$ command` + output）。
3. **引用入口**：webview 输入区 footer 新增"引用终端"按钮 → client→host `terminalQuote`（requestId 查询模式，同 mention/drop）→ tab.ts case 经 hooks `quoteTerminal()` → host 回 `terminalQuoted`{requestId, result}；`{ok:true, entry}` → 插入 composer 光标处（纯文本围栏块，不入 mentions）；`{ok:false, reason: 'noTerminal'|'noShellIntegration'|'noOutput'}` → 错误提示。
4. **用户引用路径**：PRD 9.8 原文"用户也可复制终端内容粘贴进对话"——选区/scrollback 读取是 proposed API，用户复制后手动粘贴即为该路径（无需代码）；AC-FN-23 的触发"用户引用终端内容**或** AI 读取终端输出"由捕获路径完整满足。
5. AC-FN-23 口径：集成终端有输出（shell integration 捕获到命令输出）→ 引用 → 终端输出作为上下文进入对话。

### 2.3 C10 commit message 生成设计（T14，2026-09-16）

**API 核实（本机 VS Code 1.112.0 工作台代码 + SDK d.ts）**：

- `scm/inputBox` 菜单贡献点稳定存在：workbench 源码含 `MenuId.SCMInputBox = new a("SCMInputBox")` 与 `"scm/inputBox"` 字符串（Copilot Chat 生成按钮同款入口）。
- `ModelRuntime.completeSimple(model, context, options?): Promise<AssistantMessage>`（SDK model-runtime.d.ts:90）——单轮无工具文本生成，凭据由 runtime 内部解析（与 T2 secrets 注入同一链路），无需手动传 apiKey、无需新建 AgentSession/ResourceLoader。消息形状照抄 SDK `buildSummarizationContext`（`{role:'user', content:[{type:'text',text}], timestamp}`）。

**方案**：

1. **入口**（package.json contributes）：命令 `pi-agent.generateCommitMessage`（icon `$(sparkle)`）+ `menus["scm/inputBox"]` navigation 组（`when: scmProvider == git`）+ commandPalette（`when: gitOpenRepositoryCount != 0`）。重新生成 = 再次点击（SC-MSG-RGEN）。
2. **diff 来源**：git 扩展 API（`vscode.extensions.getExtension('vscode.git').exports.getAPI(1)`），`repository.diff(true)`（staged）与 `repository.diff()`（unstaged）；纯函数 `pickCommitDiffSource`：staged 非空 → staged，否则 unstaged，都空 → null（无改动）。截断 `COMMIT_DIFF_MAX_CHARS = 40_000`，保头部（diff 结构信息在前）并标注省略。
3. **纯模块** `shared/commit-message.ts`：`pickCommitDiffSource` / `truncateCommitDiff` / `buildCommitMessagePrompt`（英文 message、≤72 字符标题、祈使句、可选 body、只输出 message 本身）/ `extractCommitMessage`（去 code fence、去引导语行、trim；空输出报错）。
4. **生成**：模型选择（`pickCommitModel`）：活跃 Tab 会话 `session.model` → VS Code `defaultModel/apiProvider` 设置（registry.find）→ `getAvailableSnapshot()[0]`；全无 → 报错。`completeSimple` maxTokens 512 + AbortSignal。
5. **填入**：`repository.inputBox.value = message`，只填入不提交。生成中先写本地化占位并**保存原值**，失败恢复原文（防覆盖用户已写 message）；重入点击 → 提示生成中；仓库选取：与首工作区路径匹配的 repository，否则第一个。
6. **错误分支**：无 git 扩展 / 无仓库 / 无改动 / 无可用模型 / 生成失败——各有 i18n 文案（commit.*）。provider 错误经 `stopReason` 检查透传（completeSimple 以 resolve 而非 reject 报告错误）；diff 读取失败走 error 分支而非误报 noChanges；生成挂起由 AbortSignal.timeout(120s) 兜底；失败恢复仅在输入框仍是占位符时回写（生成期间用户键入的内容优先）；生成中重复点击静默忽略。
7. **多仓库局限**：`scm/inputBox` 按钮出现在每个仓库输入框；命令优先使用 VS Code 传入的 repository 参数（duck-type 校验），否则写与工作区路径（大小写不敏感，Windows）匹配的仓库，再退回第一个仓库。
8. **数据流与隐私**：diff 全文（截断后）作为 prompt 上下文发送给所配模型 provider——新增行可能含密钥/敏感内容，与 Copilot 等同类功能语义一致；不留存、不落日志。

### 2.4 C11 后台任务面板 + 单写者呈现（T15，2026-09-16）

**SDK 现状核实（pi monorepo 源码 + SDK 0.84.x dist）**：

- **无原生子代理**：内置工具仅 bash/powershell/edit/read/write/find/grep/ls，pi-agent-core `AgentEvent` 仅有 agent/turn/message/tool_execution 族事件，全库 grep 无 subagent/task 工具。PRD Q3 风险预案启用——**降级为状态列表**。
- **可取消能力**：`AgentSession.abortBash(): void`（agent-session.d.ts:597）独立于整轮 abort，支持运行中 bash/powershell 任务单独取消。
- **无会话锁机制**：SessionManager 无 lock/occupied API；`getSessionFile()` 新会话首次持久化前为 undefined（`isPersisted()` 区分）。

**A. 后台任务面板（经 SDK 事件呈现，不本地建模）**：

1. **任务投影**（`shared/tasks.ts` 纯模块）：以 `tool_execution_start/end` 事件为唯一事实源投影任务条目 {id: toolCallId, toolName, label（参数摘要，命令截 80 字符）, status: running|done|failed, startedAt, endedAt?}。只有长时执行类工具入列表（`TASK_TOOLS = ['bash','powershell']`，未来子代理工具名加入即自动呈现——feature-detect 常量表）；瞬时工具（read/grep 等）不进，信息密度按 SDK 现状裁剪。isError → failed。投影返回原引用表示无变化（调用方以 !== 跳过 stateSync 推送）；完成态历史裁剪至最近 `TASK_HISTORY_MAX`(20) 条，running 恒保留。
2. **协议**：stateSync 增 `tasks?: TaskInfo[]`（数量小，全量快照同 plan 模式）；client→host 增 `taskCancel {taskId}` → 活跃 Tab `session.abortBash()`。TabInfo 不变。
3. **UI**：Header 右侧任务图标按钮（运行中数量徽标）→ 浮层面板（列表：状态图标+label+耗时+取消按钮；空态说明"子代理能力由 Pi SDK 提供后自动呈现"）。**Tab 标题状态图标**：活跃 Tab 有运行中任务时 tab-strip 图标切换为运行态（与流式 spinner 区分）。
4. **后台失败通知口径**：failed 任务 → Tab hasNotification 图标（既有机制）+ 面板内红态；不弹 OS 通知（bash 失败高频，Copilot/Claude Code 同为应用内通知语义）。
5. 非 bash 工具运行中不可取消（无 per-tool abort API），取消按钮置灰。

**B. 单写者语义呈现（呈现层标记，不新增状态机状态）**：

1. **锁文件**（`src/pi/session-lock.ts`，注入 fs + pid 探测器可测）：`<globalStorageUri>/locks/<sha1(sessionFile)>.lock`，内容 {pid, token, acquiredAt, heartbeatAt}——**不写 ~/.pi/agent**（红线）。心跳 15s。**所有权 = pid && token**：token 由每个 Tab 的 lock manager 生成（randomUUID），区分同窗口多 Tab（同 pid 不同 token，接管/被接管语义与跨窗口一致）。acquire 判定：无锁→占有（排他写 wx flag，EEXIST 即争用失败——关闭双窗口同时通过 stale 判定的 TOCTOU 窗口）；锁且 (pid 死 ∨ heartbeat 超 45s)→先删再排他写；否则 occupied。全部锁操作经 per-manager promise 队列串行化，避免 adopt/heartbeat 交错。
2. **获取时机**：loadSession 立即 acquire；新会话在 `entry_appended` 事件回调发现 getSessionFile() 首次非 undefined 时 acquire。释放：切走会话/Tab 关闭/扩展停用（best-effort，仅删除自己 pid+token 持有的锁）。
3. **接管与被接管**：client→host `sessionTakeover` → 覆盖写锁（owner=自己新 token）→ 恢复可写；被接管方心跳发现锁 token 不是自己 → 转只读（occupancy: 'lostLock'），**绝不自动抢回**。
4. **呈现**：stateSync 增 `occupancy?: 'none'|'occupiedByOther'|'releasedByOther'|'lostLock'`。occupiedByOther → 输入区 disabled + 占用提示条（复用 compaction-banner 样式，含"接管"按钮）；releasedByOther → 占用者释放/死亡后心跳发现，提示"占用已解除" + "恢复可写"（同接管语义，AC-OP-03 出口）；lostLock → "已被其他窗口接管" + "接管"按钮；接管/恢复后回 none。
5. pid 存活：`process.kill(pid, 0)` ESRCH 判死（同机窗口前提，跨机不适用——本地扩展场景成立）。

**协议扩展汇总**：stateSync 增 `tasks`/`occupancy` 字段；client→host 增 `taskCancel`/`sessionTakeover`；无 host→client 新消息（均走既有 stateSync 全量）。i18n 增 tasks.* 与 occupancy.*。

### 2.5 性能与状态机收口（T16，2026-09-16）

**现状核实（AC-FN-18 / M13.1 相关代码路径）**：

- **激活路径重活**：`activate()` 同步 `await tabManager.initialize()`（extension.ts:272）——SDK 加载 + resourceLoader.reload + 会话创建全在激活关键路径；`createBridge` 仅注册事件订阅 + 起本地端口，轻。
- **stateSync 全量重发（T7 遗留）**：每次 `_emitStateChange` → `getState()` → `serializeState()` 对全部消息 `JSON.parse(JSON.stringify())` 深拷贝；`postMessage` 结构化克隆全量传输。消息里 base64 图片（T7）随每次 stateSync 重发——粘贴过的图每帧都传一遍。
- **会话列表**：SDK `SessionManager.list` 对每个 .jsonl 用 readline **遍历全文件**（并发 10）统计 name/messageCount——500 会话首次全扫是 O(总字节) IO；面板每次打开/改名都重复触发。
- **模型过滤**：webview 输入 `name.includes(q)` 遍历 DOM display 切换，100+ 模型为微秒级——提纯函数 + 性能测试背书即可。

**A. stateSync 消息增量（messages 未变则不发送）**：

1. `SerializedAgentState.messages` 改可选（`messages?: any[]`）。host 每个 Tab 维护 `messagesDirty`（初始 true）：置位点 = 一切会改变 messages 序列化结果的地方——message_end（assistant，含 messageMeta 写入）、restoreCheckpointOnTab、redoCheckpoint、newSession/loadSession/renameSession(换路径)、suspendedMessages 变化（prompt 前 discard / restore / redo）、活跃 Tab 切换（_switchTab/_closeTab 换活跃 tab / _createTab）。
2. `TabManager.getState()` 改 `getSnapshot(force = false): { state, images? }`：`!force && !dirty` 时 `serializeState(false)`（session.ts 增参：跳过 messages 深拷贝，返回对象不带 messages 键）——省掉 clone + postMessage 全量；发送后清 dirty。dispatch `getState` 走 force=true。
3. webview `applyStateSync`：`state.messages = s.messages ?? state.messages`（保留现值）；`updateMessages` 逻辑不变。
4. serializeState 的深拷贝保留（append-only 下文本消息 CPU 可接受；不引入 WeakMap 缓存——避免缓存副本被 meta/images 后处理污染）。

**B. 图片资产分离（base64 走旁路缓存）**：

1. `shared/message-assets.ts` 纯函数 `collectAndReplaceImages(messages, known: Map<dataUrl, assetId>, allocId)`：遍历消息 content，`type: 'image' | 'image_url'` 且有 data 的项替换为 `{ type: 'image', assetId }`，返回 `{ messages, images }`（images = 本次新增 assetId→dataUrl，仅首次）。known 保证了 assetId 稳定（同一图跨帧同 id，webview 缓存可去重）。
2. host 每 Tab `imageAssets: Map<dataUrl, assetId>`（assetId 由 TabManager 实例级计数器分配，跨 Tab 唯一）；`getSnapshot` 内在 meta 附加之后对 `state.messages` 执行替换，新增图片随 stateSync 顶层 `images?: Record<string, string>` 发出（空则省略）。
3. webview 维护 `state.imageCache: Record<assetId, dataUrl>`（生命周期 = webview 存续，不清理——内存占用与图片留在消息里等价）；`extractUserImages` 改查 `c.assetId → imageCache`（不再读 `c.data`，host 不再发 base64）。
4. agentEvent 的 message_end 事件仍含 base64（safeSerialize 副本）——接受：每图仅随其 message_end 传输一次（理论下限），后续所有 stateSync 均为 assetId 引用。
5. 消息未变（A 省略 messages）时 images 必为空（新图只随新消息出现），逻辑自洽。

**C. 激活懒初始化**：

1. `TabManager.initialize()` 幂等化（缓存 ready promise，重复调用立即 resolve）。extension.ts 不再 `await`（`void tabManager.initialize().catch(log)`）；SidebarProvider.resolveWebviewView 先 post 空态（`getState()` 无 Tab 分支已有兜底），再 `initialize().then(post 真态 + postConfigSnapshot)`。
2. 所有 Tab 访问入口（dispatch/sendToPi/abort/selectModel/toggleThinking/compact/recordFileSnapshot/inline-chat 命令）开头 `await initialize()`——幂等零成本；早到的命令不再被静默丢弃。
3. activationEvents=[] 且 contributes.views 存在：VS Code 在视图首次可见时激活——懒初始化把 SDK 加载移出激活计时（AC ≤1.5s 主路径只剩事件订阅 + 端口监听）。

**D. 会话列表缓存（stale-while-ignore，TTL 5s）**：

1. `shared/ttl-cache.ts` 纯类 `TtlCache<V>(ttl, { now? })`：`get(key)` 命中返回副本、过期返回 undefined；`set(key, value)`；`invalidate()`。单测覆盖。
2. `PiSessionManager.getSessions()` 接入：key = cwd+sessionDir，命中免 SDK 全文件扫描；返回值始终做逐条浅拷贝（调用方不可污染缓存）。失效点 = `setSessionName`（改名后立即 getSessions 必须见新名）/ `newSession` / `loadSession`（列表可能新增条目）。首次 500 会话扫描依赖 SDK 并发 10，为一次性成本——面板第二次打开 ≤10ms。

**E. 并发口径**：既有保护盘点（session-lock promise 队列、plan driver runId 单飞、compactionInFlight、prompt 双检 isStreaming）；新增 whenReady/initialize 幂等 promise 并发安全；补"快速连续 dispatch（prompt 流式中拒绝 / newSession-loadSession-switchTab 交错）不死锁"测试。

**协议变更**：`SerializedAgentState.messages` → 可选；stateSync 增顶层 `images?: Record<string, string>`（仅新增资产）；`getSnapshot` 为 host 内部签名（不进协议）。i18n 无新增。

### 2.6 四组合兼容收口（T17，2026-09-16）

目标：深/浅主题 × 中/英语言四组合无英文残留、无破版（AC-OP-02）；面向用户错误文案人话——发生什么 + 影响 + 建议动作，不透传 SDK/API 术语堆砌（13.4）。

**A. 错误文案人话层**（`shared/error-copy.ts` 纯模块）：
- `classifyError(err)`：按 message/name/code 特征把未知错误归为 `auth | network | rateLimit | aborted | config | unknown`（如 401/api key/credential→auth、fetch/ECONN/network→network、429/rate→rateLimit、abort→aborted、config/not found→config）。
- `humanizeErrorMessage(err)`：返回 i18n 文案；`aborted` 返回 undefined（用户主动停止，静默）。每类文案含三段：发生了什么、影响、建议动作（如 auth→检查 API 密钥/设置入口；network→检查网络与代理后重试）。原始 `err.message` 保留给 outputChannel/console 诊断，不上屏。
- 应用点（原先均裸透传 `err.message`）：sidebar `_handleMessage` catch（prompt 等主错误出口）、inline-chat 三处（保存/回滚/轮次失败）、extension.ts sendToPi catch、tab.ts applyPreview 意外错误、settings-panel 保存错误。commit-message 已有人话前缀模式，保持。

**B. 残留文案收口**（全部走 i18n 集中层）：`models.selectPlaceholder`（session.ts showModelPicker）、`models.noneAvailable`、`command.thinkingChanged`（extension.ts toggleThinking toast，level 经 `thinkingLevelLabel()` 复用 settings.think.* 译名）、`compact.done`、`common.yes`（两处模态确认按钮）、`init.failed`（sidebar 初始化失败横幅）。例外：extension.ts 激活失败提示保持英文——setLang 可能尚未执行，且激活失败即扩展损坏场景。

**C. 主题四组合**：CSS 审计结论——全部颜色走 `--vscode-*` 变量；仅 box-shadow 的 `color-mix(#000 α)` 与 `-webkit-mask` 渐变含黑色（阴影/遮罩语义，双主题通用，符合 VS Code 内置扩展惯例）。新增守卫测试（theme.test.ts）：静态扫描 main.css/settings.css，硬编码颜色只允许出现在 box-shadow / -webkit-mask 声明行，防止回归。

**D. i18n 一致性守卫**：新增测试——EN 与 ZH 每个同名 key 的 `{param}` 插值参数集合必须一致（防翻译漂移导致运行时留 `{n}` 占位符或缺参）。key 集合一致已由 `ZH: Record<TextKey, string>` 编译期保证。

**E. 人工走查清单**（机械验证之外的四组合遍历，F5 手工执行）：面板空态/流式/工具卡/审批卡/模型选择/会话面板/计划卡/任务面板/占用横幅/apply 卡 × 深浅 × 中英；设置页全部区块；inline chat 三态提示。机械部分（文案扫描、CSS 变量、参数一致性、key 奇偶）已由测试固化。

### 2.7 升级/回退与数据迁移验证（T18，2026-09-16）

结论：本项目对上游（Zetaphor/pi-vscode-extension 首提交 e12decae）的全部数据变更均为**加性**——无设置键重命名/删除、无既有存储格式改写，升级保留全部旧数据，回退到旧版本无静默失效（AC-OP-04、13.5）。

| 数据 | 位置 | 上游 | 本项目 | 回退影响 |
|------|------|------|--------|----------|
| 设置键 ×8 | contributes.configuration | 有 | 全保留，仅新增 displayLanguage | 旧版忽略新键 |
| API 密钥 | SecretStorage `pi-agent.apiKey.<provider>` | 有 | 同名沿用（settings-panel API_KEY_PREFIX 不变） | 保留 |
| SDK 凭据 | SDK ModelRuntime credentials（与 Pi CLI 共享） | 有 | 同一 SDK 机制透传 | 与 CLI 一致 |
| 审批记忆 | globalState `pi-agent.approvalRules.global` | 无（新增） | 缺失/损坏初始化为空，畸形条目滤除不崩溃 | 旧版不读该键 |
| 面板放置标记 | globalState `pi-agent.sidebarPlacementDone` | 无（新增） | **已移除**（2026-09-16）：首次运行移动 hack 被声明式 `viewsContainers.secondarySidebar`（本机 1.112 manifest schema 稳定支持）取代，残留在用户 globalState 中的旧键无人读取、无害 | 旧版不读 |
| 会话 | 工作区 .pi/ pi 原生 jsonl | 有 | 只读不改写格式 | 天然兼容 |
| 会话锁 | globalStorage/locks/<sha1>.lock | 无（新增） | 呈现层标记，绝不写 ~/.pi/agent | 旧版不读，残留文件无害 |
| checkpoint 快照 | 内存（不落盘） | 有 | 同 | — |

守卫测试（test/unit/migration.test.ts）：上游 8 个设置键必须仍存在于 package.json（防未来重命名）；`parseGlobalRules`（自 extension.ts 内联提取至 pi/approval-memory.ts 纯函数）对 undefined/null/非数组/畸形条目的行为——初始化为空、逐条校验（tool 非空字符串 + createdAt 数字）、绝不过滤出合法规则也绝不抛错。迁移无需用户提示（无格式转换）。

### 2.8 Marketplace 发布资产（T19，2026-09-16）

- **图标（AC-FN-29）**：marketplace 彩色图标 `media/pi-icon-full.png` 128×128（vsce 要求 ≥128，合规）；视图/活动栏图标 `media/pi-icon.svg` 24×24 `stroke="currentColor"`——VS Code 用 currentColor 自动适配主题色，即灰阶规范图标的正确实现形态，无需再生成 36×36 位图。media/icons/ 14 个 UI 图标与磁盘一一核对后打包。
- **categories 勘误**：预研曾记录 `"AI"` 非 Marketplace 有效枚举；查证官方文档，`AI` 与 `Chat` 均为 2023-11 起的官方 category（extension manifest schema 枚举含二者），故**保留 `["AI", "Chat"]` 不改**。
- **keywords 补充**：`pi / ai / agent / coding / chat / assistant`。
- **.vscodeignore 收口**（此前 prd//docs//ui//scripts//.cache/ 等开发资产会全量打入 vsix）：新增排除 `.cache/**`、`prd/**`、`docs/**`、`ui/**`、`scripts/**`、`proposal.md`、`ROADMAP.md`、`ac.md`、`CONTEXT.md`、`package-lock.json`、`tsconfig.webview.json`；`*.map` 改 `**/*.map`（原 glob 不跨目录，22.47 MB sourcemap 曾漏排进包）。保留 `RESEARCH.md`/`THIRD_PARTY_NOTICES.md`/`screenshot.png`（README 引用，`--no-rewrite-relative-links` 下链接必须可达）、`bridge/`（运行时 additionalExtensionPaths）、`media/`、`out/`。打包体积 7.15 MB → 2.55 MB（30 files）。
- **README 发布向扩写**：What works 补齐 T8–T18 已实现功能（右键发送选区/文件、@-mention、拖拽文件、图片附件、Plan 模式、inline chat、commit message 生成、终端引用、后台任务面板与占用横幅、双语 UI）；新增 Getting started 三步；Package 段的排除说明与实际 .vscodeignore 对齐。
- **已知非阻塞项**：vsce 警告 `out/extension.js` 11.9 MB（SDK 全量 bundle；远低于 Marketplace 限额，minify/裁剪留待后续优化）。`publisher` 仍为占位 `"local"`——正式发布需注册 Marketplace publisher 后改名（账号所有权属用户决定）；`npm run package` 本地打包验证通过。打包脚本暂带 `--allow-missing-repository`（历史遗留 flag）：repository 字段实际已配置且公网可达，正式提审前应跑一次不带该 flag 的打包确认 vsce 仓库校验独立通过。

### 2.9 E2E 全循环演练方案（T20，2026-09-16）

AC-FN-28 验收：已配置 Pi 的环境中，从一个可复现 bug 出发完成"描述问题→AI 改文件→审 diff→跑测试→生成 commit"全流程，全程不出 VS Code。五个环节全部由扩展内 UI 承载（聊天面板 / diff 预览卡 / 内置终端 / SCM input box），无外部工具依赖，故演练本身是 GUI 人工验收。

**自动化覆盖**（已验证）：`npm run test:integration` 在真实 VS Code Extension Host（本地 code.cmd + 隔离 profile `.vscode-test-local/`）通过激活冒烟与命令注册（exit 0）；`npm run check` 492 单测覆盖各环节核心逻辑——① 描述问题：流式渲染/stateSync/@-mention（mention.ts、render-messages）；② 改文件：diff 计算/apply 状态机（tab-snapshot、shared/diff）；③ 审 diff：apply 卡接受/放弃 + inline chat 接受/放弃状态栏流（inline-chat.test）；④ 跑测试：终端捕获/引用（terminal-capture、terminal-quote）；⑤ commit message：diff 源选择/截断/提取（commit-message.test 20 例）。

**人工演练清单**（需真实凭据与 GUI，留待用户执行；建议用装好的 vsix 或 F5）：

1. **描述问题**：侧栏新开 Tab →（可选 `@`-mention 相关文件/符号）→ 输入 bug 描述发送；验证流式回复、思考块与工具卡逐帧渲染。
2. **AI 改文件**：Pi 调用编辑类工具产生 diff 预览卡 → Preview 逐文件查看 → Confirm 写入；验证 apply 卡状态流转与 per-file undo。
3. **审 diff**：VS Code 原生 diff 视图复查改动；或用 Inline Chat（命令面板 `pi-agent.inlineChat`）改一行 → 状态栏 Accept/Discard 两向验证。
4. **跑测试**：在扩展宿主工作区的集成终端跑 `npm run check`（或让 Pi 的 bash 工具跑）→ 失败时复制终端输出粘贴回聊天继续修复（原"引用终端"按钮已于 2026-09-16 按用户要求删除，见 §2.10）。
5. **生成 commit**：SCM input box 右侧菜单触发 commit message 生成 → 验证生成文案写入输入框。

演练结果（bug 场景、各环节结果、发现的问题）回填本节。



| 方向 | 消息 | 用途 |
|------|------|------|
| client→host | `config.refresh` / `approval.remember` / `approval.revoke` / `apply.preview` / `apply.confirm` / `plan.approve` / `plan.adjust` / `plan.abort` / `mention.query` / `terminalQuote` / `commit.generate` / `queue.confirm` / `queue.clear` | 对应 C1–C11 操作（消息名按代码惯例 camelCase，`terminalQuote` 即原计划 `terminal.quote`） |
| host→client | `config.state` / `approval.trace` / `apply.previewResult` / `apply.done` / `plan.state` / `todo.update` / `compaction.prompt` / `compaction.result` / `mention.results` / `terminalQuoted` / `queue.state` / `lang.changed` | 状态与结果推送 |

> 勘误（2026-09-16）：按用户要求，`plan.approve`/`plan.adjust`/`plan.abort`/`plan.state`/`todo.update`（计划模式）与 `terminalQuote`/`terminalQuoted`（引用终端）已全部删除，对应实现见 §2.10；上表保留为设计史记录。

### 2.10 会话存活修复 + Copilot 式选中上下文（2026-09-16）

**a) 侧栏隐藏丢失会话（用户报告"点开插件后聊天记录消失"）**：VS Code 在视图隐藏时销毁侧栏 webview，`resolveWebviewView` 里的 `onDidDispose` 钩子随即 dispose 整个 TabManager（tab.ts M4 注释表明上游有意为之：隐藏即弃）。修复：删除该钩子，TabManager 生命周期跟随扩展（已在 context.subscriptions）；webview 重建时 `resolveWebviewView` 经 `getSnapshot(true)` 重发全量状态原地恢复。会话文件本有 SDK 磁盘持久化，历史可经会话列表重载。新增 sidebar.test.ts 回归测试。

**b) 选中上下文 chip（用户需求：与 Copilot 一致感知编辑器选区）**：

- **协议**：host→client `selectionChanged`（`SelectionContextInfo {path,startLine,endLine}` 或 null）；client→host `dismissSelection`。选区代码永不出主机——webview 只拿显示信息。
- **主机**：新模块 `providers/selection-context.ts` `SelectionContextTracker`——订阅 activeEditor 变化/选区变化/活动文档编辑，150ms 防抖重算；非空选区 → 工作区相对 posix 路径 + 1-based 行段（复用 send-to-pi `selectionLineRange` 的整行拖拽折算）；信息变化才推送（防抖后仍可能重复事件）。发送时 `consumePrompt(text)` 一次性重读活动编辑器当前选区（显示信息可能过期，代码以发送瞬间为准），经 `buildSelectionPrompt` 包裹为 `用户文本前置选区上下文`；选区已空→原样发送；超 40K→提示 `sendToPi.tooLarge` 并丢弃选区不阻塞消息；消费/关闭后芯片清除。**@-mention 消息不包裹**（mention 自带文件上下文，避免重复注入）；queueMessage 同样包裹（FollowUp 轮同样需要上下文）。
- **webview**：输入区上方 `.selection-chip`（`路径:行段` + × 关闭）；`dismissSelection` 发回主机；发送后由主机的 `selectionChanged(null)` 驱动清除（单一状态源在主机）。视图重建时 resolveWebviewView 重发当前芯片状态。
- **装配**：extension.ts 创建 tracker（post 走 providerRef、notify 走 showInformationMessage），随 subscriptions 释放。
- 边界：纯选区光标移动不推送（null→null / 同值不重复）；文档编辑触发重算（行段可能漂移）；芯片状态不进 stateSync（独立消息，主机为单一事实源）；render() 全量重建骨架时随 populate 调 updateSelectionChip() 恢复芯片。
- **面板焦点（审查 HIGH，VS Code #180720）**：聚焦侧栏 webview 时 `window.activeTextEditor` 变 undefined——若按"无编辑器=清除"处理，用户点进输入框的瞬间芯片消失且发送永远包不上选区。故 activeTextEditor 为空时**保持现状**（只有真实编辑器/空选区能改变芯片），且芯片出现时即快照完整选区（含 code），发送用快照而非实时读编辑器。
- **失败回滚（审查 MEDIUM）**：consumePrompt 在 dispatch 前消费芯片；dispatch 抛出（如流式中发送）时 sidebar 调 `reinstate(prior)` 用 `_priorLive` 快照恢复芯片。局限：dispatch 内部早退路径（图片校验失败/mention 全失效/只读锁占用地）以 error 消息结束且不抛出，芯片不回滚——此时消息本身也未发出，用户重发时需重新框选，记为已知局限。
- steer（Ctrl+Enter 流式中插话）有意不包裹：插话是对运行中轮次的中途纠正，附带文件上下文语义不明（审查 LOW，定为设计意图）。
- 测试：selection-context.test.ts 14 例（广播/面板焦点保持/面板焦点后仍包裹/切换编辑器清除/折叠/去重/包裹/空快照/超大丢弃/reinstate/关闭/dispose 丢防抖/文档变化）+ sidebar.test.ts 7 例（回归 3 + 包裹/mention 豁免/queueMessage 包裹/dispatch 拒绝回滚）。

**c) 面板默认右侧改为声明式（用户报告"打开插件还是默认显示在左侧"，2026-09-16）**：原"首次运行自动移至次侧边栏"实现在 `activate()` 末尾先写 `sidebarPlacementDone` 标记再执行 `workbench.action.moveViewToSecondarySideBar`——标记先于结果落盘，而移动依赖"先聚焦容器再 300ms 等待"的碰运气时序，失败只写 outputChannel 日志；重装扩展不清 globalState，第一次没移成功就永不重试。修复：核实本机 1.112 稳定 manifest schema 后把 `viewsContainers` 从 `activitybar` 改声明到 `secondarySidebar`（VS Code 注册处直接支持位置 2），默认位置由清单保证、零运行时时序依赖；删除 `SIDEBAR_PLACEMENT_KEY` 与首次运行移动块，`moveToSecondarySidebar`/`moveToPrimarySidebar` 手动命令保留（用户后续自行搬动）。曾评估内部命令 `vscode.moveViews`（本机 bundle 存在，`{viewIds, destinationId}` 无需聚焦）——未文档化 API，不采用（项目坚持 100% 稳定 API）。

## 4. 安全与边界

- `~/.pi/agent` 全生命周期只读（含发现器、错误恢复路径）；私有数据（审批记忆/checkpoint）存扩展自有存储，设置页标注并支持导出/清空
- 危险工具清单：bash / powerShell 及一切 shell 执行类；永不自动放行、禁止写入记忆、Plan 批准不覆盖
- 凭证不新增处理方式（Pi 侧 auth.json 只读 + SecretStorage 不动）；不落明文/日志
- Webview CSP 不放宽；highlight.js / 资源全部本地打包
- 会话每轮即时落盘为 pi 原生格式（SDK 原生行为，不自建缓冲）

## 5. 测试策略

- vitest 单测（happy-dom）：C1 配置解析与状态机、C2 审批记忆规则（含危险工具例外）、C3 diff 预览计算、C4 增量渲染纯函数、C8 计划状态机
- mocha + @vscode/test-electron 集成：激活冒烟（已有）+ Apply 写入/撤销 + 撤销规则即时生效
- 每任务收口跑 `npm run check`（typecheck + API 审计 + compile + unit）
- AC 映射：task-list.md 每项标注对应 AC-FN/AC-OP
