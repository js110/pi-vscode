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
| C10 | 终端集成 + commit 生成 | bridge 复用 + SCM contributes | AI 读取终端输出（reportTerminalSession 已有）+ webview"引用终端选区"；SCM 输入框旁按钮 → diff 生成 message 只填入不提交 |
| C11 | 后台任务面板 | protocol + webview | SDK 子代理事件呈现（运行中/完成/失败/可取消），不本地建模；后台失败发通知 |
| C12 | UI 改版 + i18n 集中层 | `webview/styles/main.css` 重写 + `src/shared/webview-text.ts` 升级 | 按 ui/ 原型移植：tokens（--proto-* 对齐 --vscode-*）、Header/Tab 条/消息流/输入区/Footer 骨架、审批卡/提示条/Changed Files/计划卡组件化；文案集中层唯一出口，中/英双语 + 语言设置（VS Code 侧，不回写 Pi） |
| C13 | Inline Chat | 编辑器内浮层（Q1 spike 后定 API） | 选区呼出行内输入 → 行内 diff 预览（未落盘）→ 接受（纳入 Tab checkpoint）/放弃（中间工具写入按本轮 checkpoint 回滚）；轮次归属活跃 Tab；先 spike 后实做（PRD 风险预案：批内最后集成） |

## 3. 协议扩展（`src/shared/protocol.ts`，向后兼容新增）

| 方向 | 消息 | 用途 |
|------|------|------|
| client→host | `config.refresh` / `approval.remember` / `approval.revoke` / `apply.preview` / `apply.confirm` / `plan.approve` / `plan.adjust` / `plan.abort` / `mention.query` / `terminal.quote` / `commit.generate` / `queue.confirm` / `queue.clear` | 对应 C1–C11 操作 |
| host→client | `config.state` / `approval.trace` / `apply.previewResult` / `apply.done` / `plan.state` / `todo.update` / `compaction.prompt` / `compaction.result` / `mention.results` / `queue.state` / `lang.changed` | 状态与结果推送 |

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
