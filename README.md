# pi Agent By js

> [English](README.md) | [简体中文](README.zh-CN.md)

**pi Agent By js** (extension ID `jiangsheng666.piByue`) puts the [Pi coding agent](https://github.com/earendil-works/pi) into a native VS Code panel. It is not another model/agent protocol: the panel runs Pi's own SDK, so authentication, the model registry, sessions, skills, tools, event streaming, follow-up queueing, and context compaction all behave exactly like the Pi CLI — because they *are* Pi.

The panel opens in VS Code's secondary side bar from the Pi icon and can be dragged anywhere. UI derived from [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension); IDE bridge derived from [pithings/pi-vscode](https://github.com/pithings/pi-vscode). Both upstreams are MIT licensed — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features

### Chat

- **Sidebar chat** with streamed answers, collapsible thinking blocks, and expandable tool-call cards.
- **Multiple sessions in tabs** — every tab is an independent Pi session with its own model, history, diffs, and checkpoints.
- **Model picker and thinking levels** straight from Pi's registry — no key setup per provider beyond your existing Pi login.
- **Talk to a busy agent**: steer the current turn, or queue follow-ups while Pi is still streaming; queue state comes from Pi's native events.
- **Slash commands**: `/compact`, `/new`, `/model`, `/thinking`, `/name`, `/resume`, `/copy`, `/session`, `/export`, `/settings`, `/login` work in the prompt; `/skill:name` skills and prompt templates expand through the SDK. CLI-only builtins (e.g. `/tree`, `/fork`) say so instead of leaking into the model.
- **`@`-mention** files and symbols with fuzzy completion; drag files into the prompt; attach images for vision-capable models.
- **Edit history**: hover any earlier turn to edit and resend (the conversation rolls back to that point), or regenerate a turn with its original prompt and images.
- **Session management**: history, load, naming, `/export` to Markdown (thinking, tool output, and images rendered), custom session directories.
- **Completion notifications** when the panel is in the background and the turn took at least 5 seconds.
- **English & 简体中文** UI — follows VS Code by default, pinnable via `pi-agent.displayLanguage`.

### Code changes and review

- Every file change is a **native VS Code diff view** with per-file undo.
- **Checkpoints**: per-turn file snapshots let you roll a turn's changes back or forward.
- **Inline chat** from a quick-input prompt, with per-turn change highlighting and an accept/discard review flow in the status bar.
- **Selection awareness**: select code in the editor and the next message carries it automatically (Copilot-style, one-shot, dismissible).

### Editor and SCM integration

- **Send selection to Pi** from the editor context menu; **send files** to the active tab from Explorer.
- **Commit message generation** from the working-tree diff, written straight into the SCM input box.

### Trust and control

- **Tool approval cards** before Pi executes a tool call; optionally auto-approve or restrict with `pi-agent.autoApproveTools` / `pi-agent.allowedTools`.
- **Secrets stay local**: credentials come from Pi's own config (`~/.pi/agent`), with optional VS Code SecretStorage overrides — never `settings.json`.
- **Context awareness**: live context meter in the composer plus a warning threshold (`pi-agent.contextUsageWarningThreshold`) and one-click `/compact`.
- **Background task panel** with per-tab activity, occupancy banners, a single-writer session lock, and tool cancellation.

### What the agent can see in your workspace

An IDE bridge (localhost + random token) exposes VS Code editor knowledge to the agent as Pi tools: current selection, diagnostics, open editors, symbol lookup, definitions, type definitions, implementations, declarations, hover info, references, workspace symbols, Code Actions, formatting, saves, WorkspaceEdits, and notifications.

## Getting started

1. Click the Pi icon in the secondary side bar (right) to open the panel.
2. Sign in with `/login` in the chat input, or set a provider API key in the extension's settings panel.
3. Pick a model and prompt. Existing Pi configuration (`~/.pi/agent`), skills, and sessions are picked up automatically.

## Requirements

- VS Code 1.100 or newer.
- Node.js 22.19 or newer.
- A provider configured for Pi.

The extension prefers your system-wide Pi installation: at startup it detects the global install (the `pi` binary on PATH, `npm root -g`, or common global locations), validates its API surface, and uses it when compatible. If no system Pi is found — or an upgrade makes it incompatible — the extension automatically falls back to its bundled SDK copy and logs the reason, so it keeps working either way. Installing the CLI is still the easiest way to log in and manage the same native configuration used by the extension (set `PI_VSCODE_SDK_PATH` to force a specific SDK copy):

```powershell
npm install -g @earendil-works/pi-coding-agent
pi
```

## Architecture

```text
VS Code Webview
    │ typed postMessage protocol
    ▼
SidebarProvider ── TabManager (per-tab state) ── PiSessionManager ── Pi SDK
                                                       ▲
    │ diff/checkpoint (per tab)                        ├─ ModelRuntime / ModelRegistry
    │                                                   ├─ SessionManager / skills / compaction
    │                                                   └─ native agent + tool event stream
    ▼
VS Code IDE bridge (127.0.0.1 + random token)
    └─ Pi extension tools backed by VS Code language/editor APIs
```

Pi remains the backend. VS Code supplies presentation, approvals, editor state, language-service actions, and review UI.

## Develop and test

```powershell
npm install
npm run compile
npm run test:unit
npm run test:integration
```

`test:integration` uses the locally installed `code.cmd`; it does not download a second VS Code. It launches an isolated local Extension Host under `.vscode-test-local/` and leaves the user's normal VS Code profile untouched.

For manual testing, press `F5` and choose **Run Extension**, or run:

```powershell
code --new-window --extensionDevelopmentPath="$PWD" "$PWD"
```

## Package

```powershell
npm run package
```

The generated VSIX excludes sources, tests, planning documents (`prd/`), design prototypes (`ui/`, `docs/`), dev scripts, local scratch space (`.cache/`), and the local test profiles.

## Source research

See [RESEARCH.md](RESEARCH.md) for the evaluated projects, the selection rationale, exact upstream commits, and the parts reused from each implementation.
