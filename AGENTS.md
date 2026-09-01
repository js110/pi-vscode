# AGENTS.md

## Project Overview

Pi for VS Code is a sidebar client for the Pi coding agent SDK (`@earendil-works/pi-coding-agent`). It keeps Pi's native model runtime, model registry, session persistence, compaction, skills, follow-up queue, and steering behavior, while adding VS Code-native editor context, diffs, approvals, checkpoints, tabs, and settings.

## Build & Test

```bash
npm install          # install dependencies
npm run compile      # build extension + webview bundles (esbuild)
npm run watch        # watch mode
npm run test:unit    # vitest unit tests
npm run test:all     # unit + integration tests
```

Press F5 in VS Code to launch an Extension Development Host for manual testing.

## Architecture

There are two separate bundle targets (configured in `esbuild.js`):

1. **Extension host** (Node.js, CJS) -- `src/extension.ts` entry point, output to `out/extension.js`. Has access to the `vscode` API and the Pi SDK (both externalized, not bundled).
2. **Webview bundles** (browser, IIFE) -- `src/webview/main.ts` and `src/webview/settings.ts`, output to `out/webview/`. These run inside VS Code webview iframes with no Node.js or vscode API access. They communicate with the extension host via `postMessage`.

The Pi SDK package (`@earendil-works/pi-coding-agent`) is externalized in esbuild and loaded at runtime by the extension host.

The local IDE bridge starts with extension activation. `src/bridge/` exposes token-authenticated editor operations on localhost, and `bridge/pi-vscode-bridge.js` is loaded as an additional native Pi extension through `DefaultResourceLoader`.

## Key Conventions

- **Typed message protocol**: All communication between extension host and webviews goes through typed message unions defined in `src/shared/protocol.ts`. Add new message types there before implementing handlers.
- **Tab isolation**: Each chat tab has its own `PiSessionManager`, `DiffManager`, and `CheckpointManager`. State is never shared between tabs.
- **No direct DOM libraries**: The webview UI is built with vanilla TypeScript and DOM APIs. No React, no framework. Rendering uses an `el()` helper for element creation and manual DOM updates.
- **CSS variables**: Webview styles use VS Code's CSS custom properties (e.g. `--vscode-editor-background`) for theme compatibility. Never hardcode colors.
- **SecretStorage for secrets**: API keys are stored via `vscode.SecretStorage`, never in `settings.json` or plaintext.
- **Tool approval hook**: Tool call interception works by wrapping `extensionRunner.emitToolCall` on the Pi SDK's `AgentSession` after creation. This is the only point where tool execution can be blocked before it starts.
- **Native Pi queueing**: While streaming, follow-up messages go through `AgentSession.followUp()` and queue state comes from Pi's `queue_update` events. Steering remains a separate native path via `AgentSession.steer()`.
- **Skills / slash commands**: Skills are loaded from the Pi SDK and surfaced in the webview via a `getSkills` message. The webview renders a slash-command menu triggered by `/` in the input.
- **Responsive composer**: Streaming adds several footer actions. Keep badges and buttons non-wrapping, and use the narrow-sidebar grid breakpoint in `main.css` rather than relying on flex items to compress.

## File Layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Activation, command/provider registration |
| `src/shared/protocol.ts` | Typed message interfaces (ClientMessage, ServerMessage, etc.) |
| `src/pi/session.ts` | Wraps Pi SDK AgentSession lifecycle |
| `src/pi/models.ts` | Model registry helpers |
| `src/pi/auth.ts` | Auth storage singleton |
| `src/pi/events.ts` | EventRouter for agent session events |
| `src/bridge/` | Local authenticated VS Code IDE bridge server and handlers |
| `bridge/pi-vscode-bridge.js` | Native Pi extension that exposes IDE bridge tools to the agent |
| `src/providers/sidebar.ts` | WebviewViewProvider, tab state, tool approval round-trip |
| `src/providers/settings-panel.ts` | WebviewPanel for the settings page |
| `src/providers/diff.ts` | File change tracking, unified diff generation |
| `src/providers/checkpoint.ts` | Per-turn file snapshots, rollback/redo |
| `src/providers/status-bar.ts` | Status bar item |
| `src/utils/diff.ts` | Myers diff algorithm |
| `src/webview/main.ts` | Chat UI (runs in webview) |
| `src/webview/settings.ts` | Settings UI (runs in webview) |
| `src/webview/styles/main.css` | Chat styles |
| `src/webview/styles/settings.css` | Settings page styles |
| `media/icons/` | UI icons (36x36 grayscale PNGs) |

## Common Pitfalls

- Never import the Pi SDK at runtime outside `src/pi/compat.ts` (`loadPiSdk()`); use type-only imports elsewhere. See "Pi SDK Upgrade Compatibility" above.
- The webview bundles (`src/webview/`) cannot import `vscode` or Node.js modules. They are browser-only IIFE bundles.
- `tsconfig.json` excludes `src/webview/**/*` from the main TypeScript compilation. The webview files are compiled by esbuild only.
- The Pi SDK is only reached through `src/pi/compat.ts`: the bundled copy is inlined into `extension.js` by esbuild via the *string-literal* dynamic import in `loadBundledSdk()` (keep it a literal!), while the system-wide Pi copy is imported at runtime by absolute file path. See "Pi SDK Upgrade Compatibility" above.
- `ModelRuntime` is owned by `src/pi/auth.ts`; `ModelRegistry` and sessions must share it so SecretStorage overrides and Pi's native auth/model behavior stay consistent.
- When adding new settings, update both `package.json` (`contributes.configuration`) and `src/shared/protocol.ts` (`SettingsData` interface), then wire them in `settings-panel.ts` and `settings.ts`.

## Pi SDK Upgrade Compatibility

The Pi SDK ships minor releases every 1–2 weeks. The extension must survive (and adopt) upstream changes without manual firefighting:

- **Single gateway**: all *runtime* SDK imports go through `loadPiSdk()` in `src/pi/compat.ts`. Never `await import('@earendil-works/pi-coding-agent')` anywhere else. Type-only imports (`import type`) are allowed anywhere and are erased at compile time.
- **System Pi first, bundled fallback**: `loadPiSdk()` detects the system-wide Pi install (env `PI_VSCODE_SDK_PATH`, the `pi` binary on PATH, `npm root -g`, common global locations), validates its API surface at runtime, and falls back to the bundled copy — with a logged reason — when it is missing or incompatible. Which copy was loaded is logged at session init via `getSdkSource()`.
- **Feature-detect optional APIs**: for non-critical SDK methods, prefer `hasFunction()` from `compat.ts` so a renamed/removed API degrades gracefully (log + skip) instead of crashing the session. Only truly core calls (`prompt`, `abort`, `createAgentSession`) may assume existence.
- **API surface audit**: `scripts/check-pi-api.mjs` asserts that every SDK export/static/prototype method the extension relies on exists in the *installed* SDK. When you start using a new SDK API, add a check for it there.
- **Canary workflow**: `.github/workflows/pi-canary.yml` periodically runs the audit + typecheck + build + unit tests against `pi-coding-agent@latest`. Green → automatic upgrade PR; red → automatic issue.
- **After bumping the SDK** (dependabot PR, canary PR, or manual): run `npm run check` (typecheck + API audit + compile + unit tests) and do an F5 smoke test before merging.
- The `emitToolCall` monkey-patch in `session.ts` is the one deliberate reach into SDK internals; keep it isolated there and defensive (try/catch, already in place).
