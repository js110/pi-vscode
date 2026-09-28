# pi Agent By js

> [English](README.md) | [简体中文](README.zh-CN.md)

**pi Agent By js**（扩展 ID `jiangsheng666.piByue`）把 [Pi 编码代理](https://github.com/earendil-works/pi-coding-agent)装进一个原生的 VS Code 面板。它没有另起炉灶实现一套模型/代理协议：面板直接运行 Pi 官方 SDK，因此认证、模型注册表、会话、技能、工具、事件流、追问队列与上下文压缩的行为和 Pi CLI 完全一致——因为它们本来就是 Pi 本身。

面板通过 Pi 图标在 VS Code 的**右侧辅助栏**（Secondary Side Bar）打开，也可拖拽到其他位置。UI 派生自 [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension)，IDE 桥接派生自 [pithings/pi-vscode](https://github.com/pithings/pi-vscode)。两个上游项目均为 MIT 协议，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 功能

### 对话

- **侧边栏聊天**：流式回答、可折叠思考块、可展开的工具调用卡片。
- **多标签页会话**——每个标签页都是独立的 Pi 会话，拥有各自的模型、历史、diff 与检查点。
- **模型选择与思考级别**直接来自 Pi 的注册表——除了已有的 Pi 登录态，无需为各提供商单独配钥匙。
- **与忙碌的代理对话**：可以转向（steer）当前轮次，或在 Pi 还在流式输出时排队追问；队列状态来自 Pi 原生事件。
- **斜杠命令**：`/compact`、`/new`、`/model`、`/thinking`、`/name`、`/resume`、`/copy`、`/session`、`/export`、`/settings`、`/login` 都能在输入框使用；`/skill:name` 技能与提示词模板通过 SDK 展开。仅 CLI 可用的内建命令（如 `/tree`、`/fork`）会明确提示面板中不可用，不会漏给模型。
- **`@` 提及**文件与符号（带模糊补全）；拖文件进输入框；为支持视觉的模型附加图片。
- **编辑历史**：悬停任意更早的轮次即可编辑重发（会话回滚到该处），或按原提示词与图片重新生成该轮。
- **会话管理**：历史、加载、命名、`/export` 导出 Markdown（渲染思考块、工具输出与图片）、自定义会话目录。
- **完成通知**：面板在后台且该轮耗时至少 5 秒时提醒。
- **中英文界面**——默认跟随 VS Code，也可通过 `pi-agent.displayLanguage` 固定。

### 代码变更与审查

- 每个文件变更都是**原生 VS Code diff 视图**，支持逐文件撤销。
- **检查点（checkpoint）**：按轮次快照文件，可回滚或重做某一轮的改动。
- **内联聊天**：从 quick-input 发起，逐轮变更高亮，状态栏提供接受/丢弃的审查流程。
- **选区感知**：在编辑器中选中代码后，下一条消息自动携带该选区（类 Copilot，一次性，可关闭）。

### 编辑器与 SCM 集成

- 右键菜单**把选区发送给 Pi**；从资源管理器**把文件发送**到活动标签页。
- 从工作树 diff **生成提交信息**，直接写入 SCM 输入框。

### 信任与控制

- **工具审批卡片**：Pi 执行工具前先过目；可用 `pi-agent.autoApproveTools` / `pi-agent.allowedTools` 自动批准或设置白名单。
- **密钥留在本地**：凭据来自 Pi 自己的配置（`~/.pi/agent`），可选 VS Code SecretStorage 覆盖——绝不写入 `settings.json`。
- **上下文可见**：输入框上方的实时上下文仪表、告警阈值（`pi-agent.contextUsageWarningThreshold`）与一键 `/compact`。
- **后台任务面板**：每标签页实时活动、占用横幅、单写者会话锁与工具取消。

### 代理能看到你工作区的什么

一个 IDE 桥接（localhost + 随机令牌）把 VS Code 的编辑器知识以 Pi 工具的形式暴露给代理：当前选区、诊断、打开的编辑器、符号查找、定义、类型定义、实现、声明、悬停信息、引用、工作区符号、Code Action、格式化、保存、WorkspaceEdit 与通知。

## 快速开始

1. 点击右侧辅助栏中的 Pi 图标打开面板。
2. 在输入框用 `/login` 登录，或在扩展设置面板中配置提供商 API Key。
3. 选个模型开始提问。已有的 Pi 配置（`~/.pi/agent`）、技能与会话会自动加载。

## 环境要求

- VS Code 1.100 或更高。
- Node.js 22.19 或更高。
- 为 Pi 配置了某个提供商。

扩展优先使用系统级 Pi 安装：启动时探测全局安装（PATH 中的 `pi` 可执行文件、`npm root -g` 或常见全局目录），验证其 API 面后兼容即用；若未找到系统 Pi——或升级后不兼容——扩展会自动回退到内置 SDK 副本并记录原因，保证两种情况下都能正常使用。安装 CLI 依然是登录并管理这套原生配置的最简单方式（设置 `PI_VSCODE_SDK_PATH` 可强制指定 SDK 副本）：

```powershell
npm install -g @earendil-works/pi-coding-agent
pi
```

## 架构

```text
VS Code Webview
    │ typed postMessage 协议
    ▼
SidebarProvider ── TabManager（每标签页状态）── PiSessionManager ── Pi SDK
                                                       ▲
    │ diff/checkpoint（每标签页）                      ├─ ModelRuntime / ModelRegistry
    │                                                   ├─ SessionManager / 技能 / 压缩
    │                                                   └─ 原生 agent + 工具事件流
    ▼
VS Code IDE 桥接（127.0.0.1 + 随机令牌）
    └─ 以 VS Code 语言/编辑器 API 支撑的 Pi 扩展工具
```

Pi 仍是后端。VS Code 负责呈现、审批、编辑器状态、语言服务动作与审查 UI。

## 开发与测试

```powershell
npm install
npm run compile
npm run test:unit
npm run test:integration
```

`test:integration` 使用本机安装的 `code.cmd`，不会下载第二个 VS Code。它在 `.vscode-test-local/` 下启动隔离的本地扩展宿主，不改动用户日常的 VS Code 配置。

手动测试：按 `F5` 选择 **Run Extension**，或运行：

```powershell
code --new-window --extensionDevelopmentPath="$PWD" "$PWD"
```

## 打包

```powershell
npm run package
```

生成的 VSIX 已排除源码、测试、规划文档（`prd/`）、设计原型（`ui/`、`docs/`）、开发脚本、本地临时目录（`.cache/`）与本地测试配置。

## 源码研究

被评估的项目、选择依据、上游确切提交以及各自被复用的部分，见 [RESEARCH.md](RESEARCH.md)。
