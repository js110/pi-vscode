---
created: "2026-09-14"
author: "Claude (sonnet-5) 与用户 grill-me 拷问收敛"
status: Draft
---

# Proposal: pi-vscode 对标 Copilot / Claude Code 的产品级完善（Marketplace 发布版）

## Problem

pi-vscode 目前是一个"能用的侧边栏聊天客户端"，但交互形态停留在聊天窗口内，缺少 Copilot / Claude Code 这类产品级 AI 编码插件的编辑器内交互、上下文注入、渲染体验与开箱即用能力，无法作为正式产品发布到 VS Code Marketplace。

### Evidence

- 全量代码盘点（2026-09-14，扩展宿主侧 + Webview 侧两轮分析）：`package.json` 无任何编辑器内交互贡献点（inline chat、右键菜单、code lens 均无）；协议已有 `prompt.images` 字段但 UI 从未发送；代码块无语法高亮、无 Apply 操作；流式渲染每 delta 全量重渲染 markdown（webview main.ts:1038）。
- 工具审批每次都要手动点 Approve，无记忆机制（pi/session.ts:305 仅全局开关）。
- compaction 仅手动命令触发（pi/session.ts:159）。
- 首次打开无任何凭证时是空白面板，无引导。
- TODO.md 原作者遗留 "* Modes"——模式能力是既定演进方向。
- 对标差距清单见 `ROADMAP.md`（14 项，逐条含现状与对标产品行为）。

### Urgency

- 目标是 Marketplace 公开发布：无 onboarding、无 i18n、无编辑器内交互的产品在市场里没有竞争力；发布窗口越晚，同类竞品（Copilot、Cline、Roo 等已占据心智）差距越大。
- UI 改版是横切项：新功能（图片、@-mention、Apply、Plan 模式）都要落进新界面，先定交互形态再逐个加功能，避免改版时二次返工。

## Proposed Solution

以现有 pi-vscode 为基座（保留 Pi SDK 后端全部原生能力），一次到位补齐四层能力并整体改版：

1. **对话体验完整化**（聊天流内）：图片输入（入口按当前模型动态启用）、代码块语法高亮 + Apply 按钮、流式渲染增量优化、工具审批按工具名记忆、上下文阈值询问式自动压缩。
2. **编辑器内交互**（长进编辑器）：选中代码呼出真 Inline Chat（编辑器内浮出输入、行内 diff、接受/放弃）、选区右键菜单、@-mention 文件+符号补全、拖拽文件进对话。
3. **模式与进阶**：Plan 模式（只读规划 → 批准即自动执行 → Esc 中断）、TODO 任务进度卡片、终端集成、commit message 生成、子代理/后台任务面板。
4. **产品化底座**（Marketplace 要求）：零配置接入（自动读取用户已配置好的 Pi 凭证/模型/技能/会话，未检测到 Pi 时明确提示而非内置向导）、界面与图标整体重设计（布局可重排）、界面多语言（中/英）。

用户全程体验：前提是用户已安装并配置好 Pi（CLI 或任意方式）。装完插件打开 → 自动读取已有模型与凭证 → 立即可对话 → 在侧边栏或编辑器内与 Pi 协作 → 审批一次后续自动放行 → 改动有 diff/checkpoint 兜底 → 上下文满时有提示压缩，不离开 VS Code 完成日常编码。

### Innovation Highlights

- 与 Cline/Roo 等竞品的本质差异：不自带 agent 协议，完全复用 Pi 的原生 agent 运行时（会话、压缩、技能、steer/队列、事件流），升级 Pi 即获得能力，无自研协议维护负担。
- IDE bridge 27 个 RPC 工具 + 6 类事件推送是现成的编辑器能力层，Inline Chat / @-mention / Plan 模式都在它之上做交互包装，而非重写集成层。
- 坦白说：单点功能均为行业标准做法（对标 Copilot/Claude Code），创新在于组合的完整度与 Pi 生态的免维护后端。

> 领域术语见 `.cache/glossary.md`（跨阶段共享术语表，拷问中即时维护）。

## Requirements Analysis

### Key Scenarios

- **Happy path**：安装（前提：Pi 已配置）→ 插件自动读取模型列表与凭证 → 选模型 → 侧边栏对话 → 粘贴截图问 UI 问题 → 选中代码右键/Inline Chat 局部重构 → @文件/@符号注入上下文 → Plan 模式出方案 → 批准自动执行 → diff 审查 → checkpoint 回滚 → commit 生成。
- **边界与异常**：未检测到 Pi 配置（明确错误态提示+文档链接，不引导配置流程）；模型不支持图片（入口置灰+提示）；key 无效/网络失败（对话中断错误条+重试）；上下文超阈值（提示压缩，用户可拒绝继续手动）；流式中断（Esc/网络）恢复；文件被外部修改后 Apply 冲突；工作区无符号索引时 @-mention 仅文件级。
- **失败模式**：压缩失败保留原上下文并提示；Inline Chat 放弃不落盘；审批记忆撤销后回到逐次审批。

### Non-Functional Requirements

- 流式渲染：长回复（≥2000 token）下滚动帧率不卡顿（性能指标在 PRD M13 量化）。
- 安全默认：审批记忆按工具名记忆但危险工具永不自动放行；API key 仅存 SecretStorage/`~/.pi/agent`，不落明文配置。
- 兼容性：VS Code ≥1.100；主题跟随（CSS 变量），深浅色自适应；i18n 中/英。

### Constraints & Dependencies

- 依赖 Pi SDK（`@earendil-works/pi-coding-agent`）能力面：Plan 模式、子代理等若 SDK 无原生支持，需扩展层包装且受 SDK 升级节奏约束（AGENTS.md 兼容性协议：唯一入口 `loadPiSdk()`、feature-detect、API 审计脚本）。
- Marketplace 发布依赖：图标（36x36 灰阶规范 + marketplace 彩色图标）、README、分类标签、版本号策略。
- **前提条件：用户已自行安装并配置好 Pi**（`~/.pi/agent` 中含凭证与模型配置）。插件只读取 Pi 既有配置，不创建、不引导配置；未检测到配置属于明确错误态。
- 用户自备 provider API key（DeepSeek/Anthropic/OpenAI/Google 等）。

## Alternatives & Industry Benchmarking

### Industry Solutions

- GitHub Copilot Chat：编辑器内 Inline Chat + 侧边栏 + agent 模式，交互形态行业标杆。
- Claude Code（VS Code 扩展）：Plan 模式、工具审批、TODO 卡片、checkpoints。
- Cline / Roo Code：自研 agent 循环 + React webview，功能全但维护重。

### Comparison Table

| Approach | Source | Pros | Cons | Verdict |
|----------|--------|------|------|---------|
| Do nothing（维持现状） | — | 零成本 | 无法发布、体验差距扩大 | Rejected: 达不到产品目标 |
| 换 Cline/Roo 架构 | cline/cline | 功能全 | 重写后端、丢 Pi 原生能力、维护重 | Rejected: 与复用 Pi 的定位冲突 |
| 渐进小步改（仅阶段1） | — | 风险低 | 横切改版反复返工、错过发布窗口 | Rejected: 用户明确选全量一次到位 |
| **Chosen approach** | 本 proposal | 保留 Pi 后端、一次到位、横切项一次做对 | 周期长、Inline Chat 等重交互风险集中 | **Selected: 用户确认全量+改版联动** |

## Feasibility Assessment

### Technical Feasibility

- 全部功能均在 VS Code 扩展 API 能力范围内（inline chat 有官方 API、右键菜单/code lens 为标准贡献点、webview 重排为既有技术栈）。
- Plan 模式/子代理依赖 Pi SDK 现状：若 0.85.x 无原生 Plan 支持，扩展层以"只读工具白名单+计划确认流"包装（用户可感知行为不变）。

### Resource & Timeline

- 单人 + AI 结对开发，全量范围（14 项 + 改版 + i18n + 向导）预计 4-6 周，分三批交付（对话体验 → 编辑器交互 → 产品化底座），每批可独立验证。

### Dependency Readiness

- Pi SDK 1-2 周一个 minor 版本，兼容性协议（canary + API 审计）已就绪；IDE bridge 已验证可用。

## Assumptions Challenged

| Assumption | Challenge Tool | Finding |
|------------|---------------|---------|
| "差距 14 项都要做" | Occam / Need Gate | 12 项确为新增、3 项为改造；用户明确 User Override 选全量，理由：横切改版一次做对 + 发布窗口 |
| "审批记忆需要精细到命令前缀" | Occam（用户拍板） | Refined: 按工具名总开关即可，危险工具例外，设置页可撤销 |
| "自动压缩应静默执行" | 用户拍板 | Refined: 询问后压缩（用户要控制感），保留手动命令 |
| "Marketplace 新用户需要内置配置向导" | Occam（用户拍板） | Overturned: 目标用户默认已配置好 Pi，插件零配置接入只读取既有配置；配置向导移出范围 |

## Scope

### Core Path（核心路径 — 本轮交付）

1. Pi 配置零配置接入：自动读取用户已配置好的凭证/模型/技能/会话；未检测到 Pi 配置时给出明确错误态与文档指引（不内置向导）
2. 图片输入（入口动态启用、粘贴/按钮/拖拽）
3. 代码块语法高亮 + Apply 按钮
4. 流式渲染性能优化
5. 工具审批按工具名记忆（会话/全局两档 + 设置页管理）
6. 上下文阈值询问式自动压缩
7. 选区右键菜单（携带上下文发送）
8. @-mention（文件+符号补全）
9. 拖拽文件进对话
10. 真 Inline Chat（编辑器内输入 + 行内 diff + 接受/放弃）
11. Plan 模式（只读规划 → 批准即自动执行 → Esc 中断）
12. TODO 任务进度卡片
13. 终端集成
14. commit message 生成
15. 子代理/后台任务面板
16. 界面与图标整体重设计（布局可重排，承载以上全部交互）
17. 界面多语言（中/英）

### Iteration Pool（迭代池 — 后续轮次处理）

- @-mention 目录级批量上下文 —— 推迟原因：文件+符号已覆盖高频场景，目录级涉及上下文体量控制策略
- 审批记忆按命令前缀细化 —— 推迟原因：先验证按工具名粒度的实际打扰率
- Plan 模式多方案对比 —— 推迟原因：单方案闭环先跑通

### Out of Scope

- 配置向导 / Pi CLI 安装引导（用户明确排除：默认用户已配置好 Pi，插件只读取既有配置）
- 遥测统计与数据埋点上报（用户明确排除）
- VS Code Marketplace 之外的发布渠道（OpenVSX 等）
- 账号体系 / 设置与凭证云同步
- Pi 后端协议本身的改造（只消费 SDK，不改 SDK）

## Key Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Inline Chat 等重交互开发周期超预期 | M | H | 分三批交付，Inline Chat 独立成批可最后集成；交互形态先出 HTML 原型确认 |
| Pi SDK 升级破坏扩展层包装（Plan/子代理） | M | M | 遵守 AGENTS.md 兼容协议：唯一网关 + feature-detect + API 审计 + canary |
| 布局重排导致既有功能入口丢失/回归 | M | M | 迁移清单驱动：改版前盘点全部交互入口，逐项验收；保留现有 21+16 项渲染测试基线 |
| 审批记忆被滥用于危险工具 | L | H | 危险工具（如任意 shell）永不自动放行 + 设置页显式管理可撤销 |
| i18n 覆盖不全出现硬编码文案 | M | L | 文案集中层（webview-text.ts）扩展为唯一文案出口，新增文案必须走它 |

## Success Criteria

- [ ] 全部 17 项核心路径功能可用且通过验收标准（PRD M03b 逐条验收）
- [ ] 已配置 Pi 的用户从打开插件到发出第一条消息 ≤ 30 秒，零额外配置步骤（模型与凭证自动读取）
- [ ] ≥2000 token 流式回复下 webview 滚动无可感知卡顿（无整块重绘闪烁）
- [ ] 深色/浅色主题 + 中/英语言组合下界面无破版、无英文残留（中文环境）
- [ ] VS Code Marketplace 审核通过并成功发布（含图标、README、分类完整）
- [ ] 既有能力零回归：单元测试 + 集成测试全绿，diff/checkpoint/会话管理行为不变

## Next Steps

- Proceed to `/zcode:prd` to formalize requirements into PRD（当前流程继续 Phase 3-8）
- UI 原型：PRD 完成后经 `/zcode:ui` 产出界面改版与图标设计原型
