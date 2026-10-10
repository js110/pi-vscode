# Pi coding agent 1.0 之后的新能力与本扩展的差距分析

- 研究日期：2026-10-10
- 范围：`@earendil-works/pi-coding-agent` **1.0.0 之后**（1.0.1 → 1.1.0）的全部发布，附带 1.0.0 本身作为基线
- 性质：research-only，未修改任何代码
- 保存位置说明：仓库现有研究文件为根目录 `RESEARCH.md`（一次性决策记录）与 `docs/native-commands.md`（功能文档）、`docs/adr/`（架构决策）。`docs/` 下没有 `research-*` 命名先例，因此按任务默认约定新建 `docs/research/pi-post-1.0-features.md`。

---

## 1. 版本现状

| 项目 | 值 | 来源 |
|---|---|---|
| npm latest | `1.1.0`（dist-tag `latest`） | `npm view @earendil-works/pi-coding-agent`（输出 `dist-tags.latest = "1.1.0"`） |
| 本仓库依赖 | `^1.1.0` | `package.json:342` |
| 实际安装 | `1.1.0` | `package-lock.json:12`（spec `^1.1.0`）、`package-lock.json:503`（resolved `pi-coding-agent-1.1.0.tgz`） |
| 1.0.0 发布 | 2026-10-01 | `npm view` `time` 字段：`"1.0.0": "2026-10-01T19:15:22.967Z"` |
| 1.1.0 发布 | 2026-10-07 | `npm view` `time`：`"1.1.0": "2026-10-07T22:16:26.802Z"` |
| 上游仓库 | `github.com/earendil-works/pi`（monorepo，`repository.directory = packages/coding-agent`） | `npm view` `repository` 字段 |
| 官方文档 | 仓库内 `packages/coding-agent/docs/*.md`；官网 `pi.dev`（安装脚本/品牌） | npm `homepage` = `https://github.com/earendil-works/pi#readme`；包 `README.md:2,28` |
| Changelog | `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`（6199 行，含 1.1.0 → 0.10.0） | 本地安装包 |

**1.0.0 之后仅 6 个版本、6 天窗口**（1.0.0 10-01 → 1.1.0 10-07）：
`1.0.1`（10-03）、`1.0.2`（10-04）、`1.0.3`（10-05）、`1.0.4`（10-05）、`1.1.0`（10-07），无 1.0.5。

发布页已核对：GitHub Release `https://github.com/earendil-works/pi/releases/tag/v1.1.0`（通过 `https://api.github.com/repos/earendil-works/pi/releases` 取到 body，与本地 CHANGELOG 1.1.0 节逐条一致）。

---

## 2. 1.0.0 之后的发布总览

行内引用均为安装包内 `CHANGELOG.md` 的行号（下文简写 `CL:n`），并可与 GitHub Release 页对照。

### 1.1.0（2026-10-07）— CL:3-53

- **Program status reporting（OSC 7501）**：终端/仪表盘可看到 Pi 处于 working / blocked（对话框或登录）/ done / failed；`PI_PROGRAM_STATUS=1|0` 覆盖（CL:7,20；文档 `docs/terminal-setup.md:221` "Program status"）。
- **`agent_settled` 事件新增 `aborted` 字段**："so integrations can tell a cancelled run from a finished one"（CL:21；类型 `dist/core/agent-session.d.ts:54-55`：`{ type: "agent_settled"; aborted: boolean }`）。
- **`tool_execution_end` 事件与 tool render context 新增 `durationMs`**（CL:16；类型 `dist/core/extensions/types.d.ts:848-855`；pi-agent-core 的 `types.d.ts` 亦含 `durationMs`）。
- tool render context 新增 `outputPad`（CL:17，TUI 排版专用）。
- **`--tools` 支持 `+name`/`-name` 增量调整**（CL:9,15；`docs/cli.md:120,128`）。SDK 会话选项同样支持（见下 §4.3）。
- 模型/分类器：Claude Haiku 5.5（CL:8,22）、GPT-6 Luna 分类器 + `models.classify()` 支持图像（CL:10,18,19）、llama.cpp 原生分类模型（CL:11,23）。
- 稳定性修复（随升级免费获得）：`server_busy`/capacity 类错误改为重试而非结束回合（CL:47,147）、Mistral `finish_reason: "error"` 重试（CL:48）、上下文超限估算改为 3.5 字符/token（CL:49）、Windows/WSL 端口占用时 Anthropic 登录回退空闲端口（CL:51）、长 prompt 计费低估修复（CL:52）。

### 1.0.4（2026-10-05）— CL:55-77

- **`--tools`/`--exclude-tools` 支持 `*` 通配模式**（CL:59,64；`docs/cli.md:120`："Entries are tool names or patterns where `*` matches any characters"）。
- **`--no-mcp` 单次运行关闭 MCP**（CL:59,65）——CLI 专用，SDK 会话无对应选项。
- codemode `tools.read()` 可读取图片为 image block、`image()` 展示（CL:60,70）。
- `ToolLoadout.getPromptGuidelines()`（CL:74）。
- 修复：`--tools` 误删 MCP 工具、MCP OAuth `invalid_redirect_uri`、隐藏工具仍写进 system prompt 等（CL:71-76）。

### 1.0.3（2026-10-05）— CL:78-104

- **Breaking：Azure provider 由 `azure-openai-responses` 更名 `azure`**（CL:87）——`auth.json`/`models.json`/`settings.json` 中旧 key 需迁移，旧会话 resume 时回退模型且不复用 prompt cache。
- Azure Foundry Chat Completions（CL:82,91）。
- codemode `image()` 把生成图片写入临时文件并在结果中给出路径（CL:83,95）；输出文件改为仅属主可读（CL:96）。

### 1.0.2（2026-10-04）— CL:105-113

- **`models.json` 新增 `samplingParamsByThinkingLevel`**：按思考档位（off…max）覆盖 `temperature`/`top_p` 等采样参数（OpenAI 兼容 API）（CL:109,113；文档 `docs/models.md:101-113`）。

### 1.0.1（2026-10-03）— CL:115-157

- **`pi.registerToolRenderer()`**：为"尚未注册的工具"（如 resume 会话里还没连上的 MCP 工具）注册渲染器（CL:122,131；文档 `docs/extensions.md:190`；类型 `types.d.ts:1232`）。
- **项目级 MCP 覆盖**：`.pi/mcp.json` 可对 user 级 server 只改 `enabled`/`exposure`/`toolExposure`（CL:120,129；文档 `docs/mcp.md:30-32`）。
- `oauth.clientRegistration: "cimd"`（CL:121,128）。
- Anthropic 会话中途新增/重定义的工具改为 inline 定义以保住 prompt cache（CL:137）。
- Cloudflare Clef 分类器（CL:123,130）、Nix flake（CL:119,132）。
- 修复：MCP 工具在 resume 会话中渲染成全展开 JSON 的问题（CL:145）、"Selected model is at capacity" 改为重试（CL:147）、brace-expansion 供应链漏洞（CL:141）。

### 1.0.0（2026-10-01，基线）— CL:159-203

- codemode 提示词瘦身约 40%、错误带恢复指引（CL:164,184,185）；**`models.generateImages()`**（扩展可经 `ctx.modelRegistry.generateImages()` 调用，CL:175）。
- TUI 默认全屏（TUI 专用）、MCP OAuth 加固（CL:168）、`quietStartup: "header"`（CL:169,174）、Radius 登录、Anthropic copy-code 登录。

---

## 3. 扩展已经采用的 post-1.0 能力（无需再动）

本仓库 v0.7.0 提交 `ee4ffbb "feat: support native Pi commands and Pi 1.x sidebar features"` 已对齐 Pi 1.x，`docs/native-commands.md:34-57` 明确"targets the installed Pi SDK 1.1.0"。逐项核对：

| post-1.0 能力 | 采用证据 |
|---|---|
| `agent_settled.aborted`（1.1.0） | `src/providers/tab.ts:726` `getRunOutcome(event.aborted === true, ...)`；`src/webview/main.ts:699` 同逻辑；`docs/native-commands.md:55-57`（"Run status distinguishes completion, cancellation and failure"） |
| `tool_execution_end.durationMs`（1.1.0） | `src/webview/main.ts:1644-1646`（工具卡显示耗时）、`src/webview/render/messages.ts:242,645,709`；`docs/native-commands.md:52-53`（"durations, both live and after restoring a session"） |
| `--tools` 模式与 `+name`/`-name`（1.0.4/1.1.0） | `src/shared/i18n.ts:355,763`（设置说明含 `mcp__*`、`+codemode, -write`）；`docs/native-commands.md:54`。SDK 侧 `CreateAgentSessionOptions.tools` 文档确认支持 patterns 与 `+/-`（`dist/core/sdk.d.ts:37-49`） |
| MCP 管理（1.0.1 项目级覆盖所在能力面） | 侧栏 `/mcp` 打开 Pi 原生管理组件，`docs/native-commands.md:43-46` |
| MCP/codemode/tool-search 内置扩展 | `src/pi/native-extensions.ts:6-13`（`createMcpExtension`/`createCodemodeExtension`/`createToolSearchExtension`，`builtin+replaceable`），与 `docs/sdk.md:116` 的指引一致 |
| `AgentSessionRuntime`/`createAgentSessionServices`/`ProjectTrustStore`（1.0.0 世代 API） | `src/pi/session.ts:423-437`、`src/pi/native-commands.ts:167`；`scripts/check-pi-api.mjs:99-109` 的 ≥1.0.0 审计门 |
| Azure 更名（1.0.3 breaking） | 全仓 grep `azure|azure-openai` 无代码引用 → **无需改动**（仅影响用户 `auth.json`/`models.json` 旧 key，Pi 自身会回退） |
| 重试类修复（1.0.1/1.1.0） | 随 1.1.0 安装自动生效，无需代码改动 |
| `usesCallbackServer`（唯一 `@deprecated` 标记） | 扩展未使用（`dist/core/provider-composer.d.ts:8`、`dist/core/extensions/types.d.ts:1431`）——**无弃用 API 遗留** |

结论：**不存在"扩展还在用已弃用 API"的问题**；差距集中在"有但没用"的新能力。

---

## 4. 差距 / 机会清单

> 工作量：S ≈ 半天内，M ≈ 1–3 天，L ≈ 一周级。

### 4.1 （已实测验证）默认工具集不含 codemode —— 建议提供 `+codemode` 入口 【M】

- **Pi 侧事实**：`codemode`/`tool_search` 由内置扩展**注册但默认 inactive**，须经 `defaultTools`（如 `["+codemode"]`）启用（`docs/sdk.md:116`；`docs/settings.md:40` `defaultTools` 默认值仅 `read, bash, edit, write`）。1.0 起 codemode 大幅瘦身（1.0.0，CL:164,184），并新增图片读写（1.0.3/1.0.4，CL:60,83），价值比 0.84 时代更高。
- **本扩展现状（实测）**：只在 `allowedTools` 非空时才向 `createAgentSession` 传 `tools`（`src/pi/session.ts:414-421`、重启路径 `:426-435`），设置里没有任何 `defaultTools`/codemode 开关（全仓 grep `defaultTools` 仅命中 native-extensions）。用安装的 1.1.0 SDK 按扩展同样的工厂加载 codemode/tool-search/MCP 后实测：
  ```
  ACTIVE: ["read","bash","powershell","edit","write"]   ← 无 codemode、无 tool_search
  ```
  （探针脚本在系统临时目录，未写入仓库；在本机 `~/.pi` 无 `defaultTools` 覆盖的默认条件下测得。）
- **建议**：在设置里加"启用 codemode"开关（或把 `allowedTools` 文档升级为推荐值 `+codemode`），通过 `tools: ["+codemode"]`（仅 `+/-` 列表语义，`dist/core/sdk.d.ts:45-46`）传入；同时决定是否启用 `tool_search`。涉及：`package.json`（contributes.configuration）、`src/shared/protocol.ts:41`、`src/providers/settings-panel.ts:223`、`src/webview/settings.ts:124`、`src/shared/i18n.ts:355`、`src/pi/session.ts:415/431`。

### 4.2 `excludeTools`（拒绝名单）SDK 支持但扩展未暴露 【S–M】

- **SDK 事实**：`CreateAgentSessionOptions.excludeTools` —— "Optional denylist of tool names or patterns to disable. Applies after `tools` when both are provided, MCP tools included"（`dist/core/sdk.d.ts:51-54`）；`docs/sdk.md:106` 把 `tools, noTools, excludeTools, customTools` 并列为会话级工具控制。与 allowlist 相比，`-name`/模式拒绝名单对"默认集 + 个别禁用"更自然。
- **建议**：新增 `pi-agent.excludeTools` 设置，与 `allowedTools` 同路径传入（`src/pi/session.ts:415,431`），设置页与 i18n 同步（`settings-panel.ts`、`settings.ts`、`i18n.ts`）。注意 `+/-` 条目**不能与普通名混用**（`docs/cli.md:128`），校验文案要写清。

### 4.3 把 1.1.0 的 Program status 状态机映射到 VS Code 状态栏 【S–M】

- **Pi 事实**：Pi 用 OSC 7501 报告 `working / blocked / done / error / idle` 五态，其中 `blocked` = "An extension dialog or login waits for you"（`docs/terminal-setup.md:221` 起的状态表；CL:7,20,21）。扩展进程内跑 SDK，**不经过终端，OSC 本身用不上**，但状态语义可直接复用。
- **本扩展现状**：状态栏只有 spinner + 模型 + token/费用/上下文/思考档（`src/providers/status-bar.ts:35-81`），对话框阻塞态（`ExtensionUiBridge` 正在显示 dialog/login，`src/pi/extension-ui.ts:19-60`）与"运行失败 vs 取消"未在状态栏区分。
- **建议**：由 `TabManager` 聚合 `agent_settled.aborted`、extension-UI dialog 占用、`compaction_start/end` 推导同名五态，状态栏/侧栏图标分别呈现 `working/blocked/done/error/idle`。涉及 `status-bar.ts`、`src/providers/tab.ts`（事件汇聚点，见 `:725`）、`src/shared/protocol.ts`。

### 4.4 暴露/说明 `samplingParamsByThinkingLevel`（1.0.2） 【S】

- **Pi 事实**：`models.json` 支持按思考档位覆盖采样参数（CL:109,113；`docs/models.md:101-113`）。
- **本扩展现状**：已完整暴露思考档位切换（`session.ts:270-278`、状态栏 `status-bar.ts:76-78`），但不编辑 `models.json`，设置页也未提示该能力。
- **建议**：最低成本是在设置页"模型/思考"分组加一段说明 + 打开 `~/.pi/agent/models.json` 的按钮；不建议自造编辑器。涉及 `settings-panel.ts`、`i18n.ts`。

### 4.5 API 审计脚本补强：把 `emitToolCall` 猴补丁纳入审计，并预留 ≥1.1.0 门 【S】

- **现状**：工具审批靠 monkey-patch `ExtensionRunner.emitToolCall`（`src/pi/session.ts:591-620`），方法仍存在于 1.1.0（`dist/core/extensions/runner.d.ts:184`），且上游同时存在官方 `tool_call` 拦截钩子（`types.d.ts:1200` `on(event: "tool_call", ...)`、`ToolCallEventResult.block`；`runner.d.ts` `emitToolCall` 会合并 handler 返回值）。猴补丁本身有 try/catch 兜底（`session.ts:617-619`）。
- **风险**：`scripts/check-pi-api.mjs` 的导出/原型清单（`:77-118`）**没有检查 `ExtensionRunner.emitToolCall`**——若上游改名，审批钩子会静默失效（patch 赋值到不存在的方法不会抛错，审批直接旁路）。
- **建议**：在 `check-pi-api.mjs` 增加 `checkProto('ExtensionRunner', 'emitToolCall')`（与既有 ≥1.0.0/≥0.86.0 版本门风格一致，`:99-118`），并新增 ≥1.1.0 版本门，为后续使用 `aborted`/`durationMs`/`excludeTools` 的 API 审计留位。工作量 S。

### 4.6 文档/文案类修正（低成本） 【S】

1. **README 仓库链接 404**：`README.md:5` 与 `README.zh-CN.md:5` 指向 `https://github.com/earendil-works/pi-coding-agent`，该路径经 GitHub API 核实返回 **404**（`api.github.com/repos/earendil-works/pi-coding-agent` → 404 Not Found）；正确地址为 `https://github.com/earendil-works/pi`（npm `repository.url = git+https://github.com/earendil-works/pi.git`, `directory: packages/coding-agent`）。
2. **About 文案过期**：`ui/ui_settings.html:136,174,204` 仍写 "Pi SDK … 0.84.x"（实际 1.1.0）。该目录是 UI mock（`ui/PRD-ui*.html` 等），若不随包发布可只改 mock；同时 `README`/设置页如有版本展示建议从 SDK `VERSION` 导出动态读取（`dist/index.d.ts` 导出 `VERSION`，见 `export { … VERSION, } from "./config.ts"`）。
3. **`RESEARCH.md:13,35` 的 0.84.x 结论**为 2026-09-01 的历史记录，可不动，但建议在顶部补一行"SDK 已升级至 1.1.0，现状见 `docs/native-commands.md`"。

### 4.7 可选/低优先级机会

| 机会 | 来源 | 说明 | 工作量 |
|---|---|---|---|
| 项目级 MCP 覆盖入口（`.pi/mcp.json` 只改 enabled/exposure） | 1.0.1 CL:120,129；`docs/mcp.md:30-32` | `/mcp` 原生管理组件已能在侧栏完成绝大多数操作（`docs/native-commands.md:43-46`），设置页重复暴露价值有限；可在设置页加"编辑项目 mcp.json"入口即可 | S |
| `pi.registerToolRenderer` | 1.0.1 CL:122,131；`docs/extensions.md:190` | 扩展在 webview 自绘工具卡（`render/messages.ts`），未注册工具走通用卡片渲染；仅当需要 Pi 官方 `renderCall/renderResult` 语义（如未连接 MCP 工具的占位渲染）时才需要 | M，优先级低 |
| `models.generateImages()` 图像生成 | 1.0.0 CL:165,175 | 扩展侧可用 `ctx.modelRegistry.generateImages()`（供 Pi 扩展/bridge 调用），可做"生成配图/头像"类命令；属新产品功能而非集成优化 | M–L，按需 |
| codemode 图片链路（read→image block、image() 落临时文件） | 1.0.3 CL:83、1.0.4 CL:60,70 | webview 已能渲染 codemode `details.calls` 与 image block（`render/messages.ts:686-710`、`src/test/unit/webview/main-native-ui.test.ts:49-53`）；建议补一条"图片持久化路径"渲染回归测试即可 | S |
| `getPromptGuidelines()` / `getAllTools()` 工具检视面板 | 1.0.4 CL:74；`agent-session.d.ts` `getAllTools()` | 侧栏目前只列 active tools（`session.ts:750-761`，用于发给协议）；完整工具检视（描述/来源/prompt 指引）可做成设置页"工具"标签 | M |
| `--no-mcp` | 1.0.4 CL:59,65 | **CLI 专用**，`CreateAgentSessionOptions` 无对应字段（`sdk.d.ts:29-56` 只有 `noTools`/`tools`/`excludeTools`/`customTools`），SDK 宿主不可直接采用 | N/A |

---

## 5. 验证方法与可信度

- 版本与时间线：`npm view`（registry 元数据）+ 安装包内 `CHANGELOG.md`，二者交叉一致。
- Release 内容：`api.github.com/repos/earendil-works/pi/releases` 返回的 `v1.1.0` release body 与本地 CHANGELOG 1.1.0 节一致。
- API 面：以安装包 `dist/**/*.d.ts`（`index.d.ts`、`core/sdk.d.ts`、`core/agent-session.d.ts`、`core/extensions/types.d.ts`、`core/extensions/runner.d.ts`）为准。
- 扩展现状：仓库 `src/` 全量 grep + 关键文件通读；codemode 激活状态用临时目录探针脚本对安装的 1.1.0 SDK 实测（结果见 §4.1）。
- 弃用项：对 `dist` 下主要 `.d.ts` grep `@deprecated`，仅命中 `usesCallbackServer`，扩展未使用。

## 6. 未能访问的来源（诚实声明）

1. **`github.com` 的 HTML 页面**（`/releases`、仓库页）经 webfetch 返回 transport error，无法直接抓取；改用 `api.github.com` REST（release 列表/正文）完成核对。**issue/PR 链接**（如 #10549、#10607、#9776）未逐个打开，其结论均以 CHANGELOG/Release 正文为准。
2. **pi.dev 官网文档站**未抓取；所有文档引用来自安装包内 `docs/*.md`（与 `packages/coding-agent/docs/` 同源），并以 GitHub blob 形式可在 `https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/...` 复核。
3. **历史版本的 `.d.ts` 未做逐版本 diff**（npm 只装了 1.1.0；未下载 1.0.0 tarball）。因此"某字段是哪个 minor 引入"完全依赖 CHANGELOG 文字；对 `excludeTools` 等 CHANGELOG 未明确记录加入时间的能力，已标注为"存量但未使用"而非"post-1.0 新增"。
4. `docs/native-commands.md` 表述"24 个内置命令"与共享命令镜像的上游 parity 测试未独立复核（属既有文档声明）。
