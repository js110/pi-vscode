# Context — pi-vscode domain model

This file records the project's canonical vocabulary for seams and concepts. When
deepening a module, name it after the domain terms below and update this file as
the model sharpens.

## Terminology

- **Tab** — one independent Pi conversation. Each tab owns its own session,
  diff tracking, and checkpoints. State is never shared between tabs.

- **TabManager** — the deep module that owns the full lifecycle of every Tab:
  creation (via a injected factory), session replacement, active-tab selection,
  event reduction, streaming state, tool approval, diff/checkpoint coordination,
  and disposal. It exposes a small interface — `dispatch()`, `getState()`,
  `onStateChange()`, and a few queries — and keeps all tab invariants internal.
  See `docs/adr/0001-tab-manager.md`.

- **SidebarProvider** — the thin webview adapter. It forwards `ClientMessage`s
  to the TabManager's `dispatch()`, posts resulting `ServerMessage`s to the
  webview, and handles pure UI side effects. It holds no tab state.

- **Turn** — one prompt-and-response cycle within a Tab. The turn counter is a
  single authoritative sequence per tab that is shared by the checkpoint index
  and the diff `turnIndex`, so restores and redo never go out of domain. It
  increments monotonically for the tab's lifetime and is not reset on
  `loadSession` or `newSession` in a way that would collide with history ordering.

- **Checkpoint** — a per-turn snapshot of file-before/after state used for
  rollback and redo. Owned and coordinated by the TabManager.

- **Tool approval** — interception of a pending tool call, resolved against the
  active tab. Pending approvals live in the TabManager.
