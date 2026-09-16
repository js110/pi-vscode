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

## 3. 协议扩展（`src/shared/protocol.ts`，向后兼容新增）

| 方向 | 消息 | 用途 |
|------|------|------|
| client→host | `config.refresh` / `approval.remember` / `approval.revoke` / `apply.preview` / `apply.confirm` / `plan.approve` / `plan.adjust` / `plan.abort` / `mention.query` / `terminalQuote` / `commit.generate` / `queue.confirm` / `queue.clear` | 对应 C1–C11 操作（消息名按代码惯例 camelCase，`terminalQuote` 即原计划 `terminal.quote`） |
| host→client | `config.state` / `approval.trace` / `apply.previewResult` / `apply.done` / `plan.state` / `todo.update` / `compaction.prompt` / `compaction.result` / `mention.results` / `terminalQuoted` / `queue.state` / `lang.changed` | 状态与结果推送 |

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
