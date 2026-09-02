# ADR-0001: TabManager owns the tab execution life cycle

## Status

Accepted

## Context

The `SidebarProvider` was both the webview adapter and the sole owner of tab
bookkeeping. A single `TabState` object with 19 fields lived inside it, along
with the event reducer, streaming state, tool-approval pending map, turn
counter, and tab ordering. `DiffManager` and `CheckpointManager` were
orchestrated from the provider, and `StatusBarManager` was bound to a single
initial session — so switching tabs left the status bar subscribed to the wrong
session, and disposing a tab did not clean up every resource it owned.

Three different index schemes (a `turnCounter` in the provider, a
`messageIndex` key in the checkpoint manager, and a `turnIndex` in the diff
manager) had to stay aligned for restores to work, and `loadSession` reset the
counter to `0`, putting the next checkpoint in a different domain than existing
history.

## Decision

Introduce `TabManager` (`src/providers/tab.ts`) as the deep module that owns tab
execution. It absorbs:

- tab creation, session replacement, active-tab selection, event reduction,
  streaming state, and disposal;
- full ownership and coordination of `DiffManager` / `CheckpointManager` and
  their shared turn sequence;
- `SerializedAgentState` assembly and the checkpoint-rollback index mapping.

The `SidebarProvider` is reduced to a thin forwarding layer: it forwards
`ClientMessage`s to `TabManager.dispatch()`, posts `ServerMessage`s from a
`post` callback, and performs pure UI side effects.

`TabManager` exposes only a small interface:

- `dispatch(msg: ClientMessage)` — single entry point that understands every
  message type,
- `getState(): SerializedAgentState`,
- `onStateChange(listener)` — fired only when state actually changes,
- `activeTab`, `isStreaming`, and the command helpers.

`StatusBarManager` now depends on `TabManager` via `onStateChange` and reads the
active tab, instead of subscribing to the initial session.

### Injection boundary

`TabManager` never constructs concrete collaborators. It accepts:

- a `TabFactory` (`() => Promise<Tab>`), so tests can inject mock sessions and
  the extension owns creation of the real `PiSessionManager` / `DiffManager` /
  `CheckpointManager`;
- a `TabManagerHooks` object for the capabilities it drives decisions with:
  `post`, `setContext`, `openFile`, `showMessage`, `confirmDialog`,
  `openSettings`.

Pure UI side effects (opening diffs, file dialogs, status messages) stay out of
the module; the module requests them through the hooks.

## Consequences

- **Locality** — tab lifecycle, streaming state, turn sequence, approval, and
  diff/checkpoint coordination now live in one authoritative place.
- **Leverage** — every tab shares the same lifecycle; the thin provider and the
  status bar both drive off the single `TabManager`.
- **Testability** — the TabManager interface is the test surface; a mock
  `TabFactory` / hooks let sessions and tabs be exercised without a live SDK or
  webview.
- **Correctness** — the status bar no longer leaks to a stale session, tab
  disposal cleans up all owned resources, and the unified turn sequence removes
  the cross-module index mismatch that `loadSession` triggered.
