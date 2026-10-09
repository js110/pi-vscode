# Pi native commands in VS Code

The sidebar intercepts all 24 built-in commands from Pi 1.1.0 before calling
`AgentSession.prompt()`. Pi's SDK only dispatches extension commands and expands
skills/templates through `prompt()`; the frontend must implement built-ins.
The command mirror has an upstream parity test to catch new built-ins.

| Commands | Sidebar behavior |
| --- | --- |
| `/reload` | Reload SDK resources in place, refresh command/skill menus, reattach tool approvals |
| `/tree [entry-id]` | Open the searchable sidebar branch tree; edit labels, optionally summarize the abandoned branch, and restore the SDK's draft. An entry ID navigates directly. |
| `/fork [entry-id]`, `/clone` | Use Pi's runtime lifecycle and extension cancellation hooks to create a new session |
| `/import [path]` | Import JSONL using the native runtime, with a file picker when the path is omitted |
| `/export [path]` | Native HTML or JSONL export, with a save dialog when the path is omitted |
| `/model [provider/model]`, `/thinking [level]` | Change the current model/thinking level |
| `/scoped-models` | Pick and persist models available for cycling |
| `/login [provider]` | Native browser/device OAuth or API key entry stored in VS Code SecretStorage |
| `/logout [provider]` | Remove native credentials and VS Code API key overrides |
| `/trust` | Save/forget a Pi project trust decision and reload resources |
| `/share` | Export HTML and upload a secret gist using an installed, authenticated `gh` CLI; show and copy the link |
| `/bug [description]` | Open the upstream issue creation page |
| `/changelog` | Preview the loaded SDK's changelog, falling back to the upstream page |
| `/hotkeys` | Open VS Code keybindings filtered to Pi commands |
| `/settings`, `/resume` | Open the extension settings/session picker |
| `/new`, `/compact [instructions]` | Start a session or compact using existing sidebar flows |
| `/name name`, `/session`, `/copy` | Rename, show statistics, copy the last response |
| `/quit` | Abort and close the current tab; with one tab, hide the auxiliary sidebar while preserving the session |

Commands that switch or reload state are blocked during generation, compaction,
or a read-only session lock. They also stay out of the native follow-up/steering
queues. Extension commands, skills and prompt templates continue through Pi's
normal dispatch.

## Pi 1.x features

The implementation targets the installed Pi SDK 1.1.0:

1. `AgentSessionRuntime` owns new/resume/fork/clone/import flows, preserving
   extension cancellation hooks, shutdown and session rebinding.
2. The extension UI bridge supports selectors, confirmation, input, multiline
   editors, notifications, status, widgets and composer updates. Requests are
   isolated per tab and canceled on reload or disposal.
3. `/mcp` opens Pi's native management component through the generic extension UI inside
   the sidebar. Its menus expose server status and native connection, enable,
   reconnect and authentication actions. Arrow keys, Enter, Escape and text
   input are forwarded to Pi; Back returns through native menus.
4. The Sessions header button opens one browser for session history and branches.
   Search, pin, rename and delete sessions in the list; use a session's branch
   button to open it and inspect its tree. The branch view returns to the list
   with All sessions. `/tree` opens the current session's branch view directly,
   with labels, current-position highlighting and optional summary instructions.
5. Tool cards show separate text/image output items, nested tool executions,
   full-output links and durations, both live and after restoring a session.
   Tool settings accept Pi's patterns and `+name`/`-name` selections.
6. Run status distinguishes completion, cancellation and failure using native
   settlement events and the final assistant result. Earlier recovered errors
   do not incorrectly mark a successful run as failed.

Custom TUI components use a text-and-key adapter, not a complete terminal emulator.
Terminal startup headers are ignored silently to preserve chat space. Extensions that replace
Pi's terminal footer, editor or autocomplete
provider receive an explicit unsupported warning. The sidebar follows the VS Code
theme. MCP server/network authentication still requires the server's normal setup.

Validation includes a real native MCP manager with a disabled fixture server,
DOM interaction tests, cross-tab dialog isolation, SDK API audit and VS Code
Extension Host integration tests. External MCP servers and live OAuth sign-in
are not exercised by automated tests.

References: [Pi 1.1.0 changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md)
and the installed SDK declarations for `AgentSessionRuntime` and `ExtensionUIContext`.
