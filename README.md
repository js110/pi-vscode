# Pi for VS Code

A first-class VS Code sidebar for the Pi coding agent. The extension reuses Pi's SDK, model registry, authentication, sessions, skills, tools, event stream, message queues, and context compaction instead of implementing another model/agent protocol.

The UI is derived from [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension). The IDE bridge is derived from [pithings/pi-vscode](https://github.com/pithings/pi-vscode). Both upstream projects are MIT licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

![Pi for VS Code](screenshot.png)

## What works

- Sidebar chat with streamed text, thinking blocks, and expandable tool calls.
- Status bar entry that opens the panel from anywhere, alongside the activity bar icon.
- Multiple independent Pi sessions in tabs.
- Pi-native model selection and thinking levels.
- Pi-native `steer`, `followUp`, queue events, session persistence, skills, and context compaction.
- Tool approval cards before Pi executes a tool call.
- Inline file changes, native VS Code diff views, per-file undo, and checkpoints.
- Session history, loading, naming, context usage, and custom session directories.
- Credentials from the normal Pi config (`~/.pi/agent`) plus optional VS Code SecretStorage overrides.
- IDE bridge tools for selections, diagnostics, open editors, symbols, definitions, type definitions, implementations, declarations, hover information, references, workspace symbols, Code Actions, formatting, saving, WorkspaceEdit, and notifications.
- Editor integration: send the current selection to the active tab from the context menu, `@`-mention files and symbols with fuzzy completion, drag and drop files into the prompt, and attach images for vision-capable models.
- Selection awareness: selecting code in the editor shows a chip above the prompt and the next message automatically carries the selection (Copilot-style, one-shot, dismissible).
- Inline chat from a quick-input prompt, with per-turn change highlighting and an accept/discard review flow in the status bar.
- Commit message generation from the working-tree diff, written straight into the SCM input box.
- Background task panel with live per-tab activity, occupancy banners, a single-writer session lock, and tool cancellation.
- English and 中文 UI — `pi-agent.displayLanguage` follows VS Code by default (`auto`), and can be pinned to either language.

## Architecture

```text
VS Code Webview
    │ typed postMessage protocol
    ▼
SidebarProvider ── PiSessionManager ── @earendil-works/pi-coding-agent 0.84.x
    │                                     │
    │ diff/checkpoint UI                  ├─ ModelRuntime / ModelRegistry
    │                                     ├─ SessionManager / skills / compaction
    │                                     └─ native agent + tool event stream
    ▼
VS Code IDE bridge (127.0.0.1 + random token)
    └─ Pi extension tools backed by VS Code language/editor APIs
```

Pi remains the backend. VS Code supplies presentation, approvals, editor state, language-service actions, and review UI.

## Getting started

1. Open the Pi icon in the activity bar (left side) to start chatting.
2. Sign in with `/login` in the chat input, or store a provider API key from the extension's settings panel.
3. Pick a model from the model picker and prompt away. Existing Pi configuration (`~/.pi/agent`), skills, and sessions are picked up automatically.

## Requirements

- Node.js 22.19 or newer.
- VS Code 1.100 or newer.
- A provider configured for Pi.

The extension prefers your system-wide Pi installation: at startup it detects the global install (via the `pi` binary on PATH, `npm root -g`, or common global locations), validates its API surface, and uses it when compatible. If no system Pi is found — or an upgrade makes it incompatible — the extension automatically falls back to its bundled SDK copy and logs the reason, so it keeps working either way. Installing the CLI is still the easiest way to log in and manage the same native configuration used by the extension (set `PI_VSCODE_SDK_PATH` to force a specific SDK copy):

```powershell
npm install -g @earendil-works/pi-coding-agent
pi
```

Use `/login` in Pi, or configure a provider API key with the extension settings. Pi's normal environment variables and `~/.pi/agent` files continue to work.

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
