# VS Code AI coding extension research

Research date: 2026-09-01.

## Decision

Use a Pi-specific UI implementation as the base and keep Pi as the agent backend. Do not retrofit Cline, Continue, or Roo Code's provider/agent loops, because that would duplicate the model interaction, tool loop, session format, skills, and compaction already supplied by Pi.

The implemented combination is:

1. **Zetaphor/pi-vscode-extension** for the first-class sidebar UX.
2. **pithings/pi-vscode** for the VS Code language/editor bridge.
3. **@earendil-works/pi-coding-agent 0.84.x** for the complete backend.

## Projects evaluated

| Project | Architecture and useful parts | Decision |
|---|---|---|
| [Zetaphor/pi-vscode-extension](https://github.com/Zetaphor/pi-vscode-extension) | Pi SDK embedded in a TypeScript extension host; vanilla TypeScript webview; multi-tab sessions; tool cards; approvals; diffs; checkpoints; settings. MIT. | Selected as the UI base. It already models the product the user requested and avoids replacing Pi's agent loop. |
| [pithings/pi-vscode](https://github.com/pithings/pi-vscode) | Pi-native terminal and RPC chat plus a token-authenticated localhost bridge exposing VS Code selections, diagnostics, language-service queries, Code Actions, formatting, and WorkspaceEdit. MIT. | Selected as the IDE integration layer. The bridge extension is loaded by Pi's native resource loader. |
| [Cline](https://github.com/cline/cline) | Large React webview and its own controller/task/provider/tool runtime. Apache-2.0. Excellent UX reference, but its backend substantially duplicates Pi. | Not used as a code base. Porting Pi into it would mean replacing the core agent runtime rather than adapting a thin host. |
| [Continue](https://github.com/continuedev/continue) | VS Code client plus a separate IDE protocol/core and React GUI; supports chat/edit/autocomplete. Apache-2.0. The upstream repository is now read-only. | Not selected. Broader than the target, and its own server/core protocol conflicts with the requirement to retain Pi's native behavior. |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Feature-rich Cline fork with modes, MCP, approvals, and a React webview. Apache-2.0. Archived on 2026-05-15. | Not selected because it is archived and also owns a complete non-Pi agent loop. |

## Downloaded source snapshots

- `.upstream/pi-vscode-extension` at commit `526df5ead8e0104ea5d176bb5e6fa25e6d75844a` (2026-05-07).
- `.upstream/pithings-pi-vscode` at commit `8761b3ccf99bf5b7bc7e3631c508e1dd164b0e2c` (2026-04-24).
- The previous local RPC prototype is preserved in `legacy-rpc-prototype/`.

These directories are research/reference material and are excluded from the VSIX.

## Changes made to the selected base

- Replaced the old `@mariozechner/pi-* 0.70.2` dependency with `@earendil-works/pi-coding-agent 0.84.4`.
- Migrated authentication/model setup from the removed `AuthStorage + ModelRegistry.create()` path to Pi's native `ModelRuntime` and compatible `ModelRegistry` wrapper.
- Reused Pi's normal `~/.pi/agent` configuration, resource discovery, skills, sessions, model catalog, and provider credentials.
- Replaced the webview's manual follow-up dispatcher with Pi's native `followUp`, `queue_update`, `getFollowUpMessages`, and `clearQueue` APIs.
- Added Pi-native context compaction.
- Added configurable persisted/in-memory `SessionManager` creation and custom session directories.
- Loaded the pithings VS Code bridge as an additional Pi extension through `DefaultResourceLoader`.
- Fixed the upstream integration test build and Mocha UI mismatch.
- Changed integration tests to use the machine's installed VS Code instead of downloading a test build.
- Made live provider/tool unit tests opt-in with `PI_VSCODE_LIVE_TESTS=1` so the normal test suite never spends model tokens.

## Verification result

- TypeScript typecheck: passed.
- Extension and webview bundle: passed.
- Unit tests: 20 passed, 5 opt-in live tests skipped.
- Local VS Code 1.135 Extension Host: 2 integration tests passed.
- Actual SDK activation selected the configured Pi model `zhipu/glm-5.3-flash` and initialized the IDE bridge.
