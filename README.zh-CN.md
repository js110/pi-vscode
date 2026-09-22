# Pi for VS Code

> [English](README.md) | [简体中文](README.zh-CN.md)

面向 Pi 编码代理（coding agent）的一等公民 VS Code 面板。本扩展直接复用 Pi 的 SDK、模型注册表、认证、会话、技能、工具、事件流、消息队列与上下文压缩，而不是重新实现一套模型/代理协议。

面板通过 Pi 图标在 VS Code 的**右侧辅助栏**（Secondary Side Bar）打开，也可拖拽到其他位置。UI 派生自 [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension)，IDE 桥接派生自 [pithings/pi-vscode](https://github.com/pithings/pi-vscode)。两个上游项目均为 MIT 协议，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 已支持的功能

- 侧边栏聊天：流式文本、思考块、可展开的工具调用。
- 状态栏入口可从任意位置打开面板，与右侧辅助栏的 Pi 图标并列。
- 多个相互独立的 Pi 会话，以标签页管理。
- Pi 原生的模型选择与思考级别（thinking level）。
- Pi 原生的 `steer`、`followUp`、队列事件、会话持久化、技能与上下文压缩。
- 工具执行前的审批卡片。
- 内联文件变更、原生 VS Code diff 视图、逐文件撤销与检查点（checkpoint）。
- 会话历史、加载、命名、上下文占用显示与自定义会话目录。
- 凭据来自 Pi 常规配置（`~/.pi/agent`），并可用 VS Code SecretStorage 覆盖。
- IDE 桥接工具：选区、诊断、打开的编辑器、符号、定义、类型定义、实现、声明、悬停信息、引用、工作区符号、Code Action、格式化、保存、WorkspaceEdit 与通知。
- 编辑器集成：右键菜单把当前选区发送到活动标签页，`@` 提及文件与符号（带模糊补全），拖放文件到输入框，可为支持视觉的模型附加图片。
- 选区感知：在编辑器中选中代码后，输入框上方出现一个选区芯片，下一条消息会自动携带该选区（类 Copilot，一次性，可关闭）。
- 输入框内建斜杠命令——`/compact`、`/new`、`/model`、`/thinking`、`/name`、`/resume`、`/copy`、`/session`、`/export`、`/settings`、`/login` 均路由到各自的面板实现；其余仅 CLI 可用的内建命令（如 `/tree`、`/fork`）会提示面板中不可用，而不会漏给模型；`/skill:name` 技能与提示词模板照常通过 SDK 展开。
- 悬停消息操作：可从任意更早的轮次编辑并重发（会话回滚到该处），或按原提示词与图片重新生成该轮。
- `/export` 将会话导出为 Markdown——思考块、工具输出与图片附件都会渲染，带保存对话框与一键打开。
- 轮次完成通知：面板在后台运行时且该轮耗时至少 5 秒，会收到通知（`pi-agent.notifyOnCompletion`）。
- 内联聊天（quick-input 提示），逐轮变更高亮，状态栏提供接受/丢弃的审查流程。
- 从工作树 diff 生成提交信息，直接写入 SCM 输入框。
- 后台任务面板：每个标签页的实时活动、占用横幅、单写者会话锁与工具取消。
- 中英文界面——`pi-agent.displayLanguage` 默认跟随 VS Code（`auto`），也可固定为其中一种语言。

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

Pi 仍是后端。VS Code 负责呈现、审批、编辑器状态、语言服务动作与审查 UI。Pi SDK 在运行时加载：优先使用系统级 Pi 安装（兼容时），否则回退到扩展内置副本（见「环境要求」）。

## 快速开始

1. 点击右侧辅助栏中的 Pi 图标开始对话。
2. 在输入框用 `/login` 登录，或在扩展设置面板中配置提供商 API Key。
3. 在模型选择器中选择模型，开始提问。已有的 Pi 配置（`~/.pi/agent`）、技能与会话会自动加载。

## 环境要求

- Node.js 22.19 或更高。
- VS Code 1.100 或更高。
- 为 Pi 配置了某个提供商。

扩展优先使用系统级 Pi 安装：启动时探测全局安装（PATH 中的 `pi` 可执行文件、`npm root -g` 或常见全局目录），验证其 API 面后兼容即用；若未找到系统 Pi——或升级后不兼容——扩展会自动回退到内置 SDK 副本并记录原因，保证两种情况下都能正常使用。安装 CLI 依然是登录并管理这套原生配置的最简单方式（设置 `PI_VSCODE_SDK_PATH` 可强制指定 SDK 副本）：

```powershell
npm install -g @earendil-works/pi-coding-agent
pi
```

在 Pi 中使用 `/login`，或用扩展设置配置提供商 API Key。Pi 的常规环境变量与 `~/.pi/agent` 文件继续生效。

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