# browser-automation-mcp

MCP server for browser automation via Playwright accessibility tree snapshots. Agents interact with web pages through structured text (element refs, accessibility roles) rather than screenshots or vision models. Forked from [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp).

## Setup

```bash
npm ci
npm run build
```

Run directly during development (no build step):

```bash
npx tsx dev.ts --extension
```

Run built output:

```bash
node dist/index.js --extension
```

The `--extension` flag enables the Earthling Browser Bridge extension connection for cross-tab automation.

## Tools

### Core

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Capture accessibility tree of the current page (primary observation tool) |
| `browser_click` | Click an element by ref (supports double-click, right-click, modifiers) |
| `browser_hover` | Hover over an element by ref |
| `browser_drag` | Drag and drop between two elements by ref |
| `browser_select_option` | Select option(s) in a dropdown by ref |
| `browser_fill_form` | Fill multiple form fields in one call (textbox, checkbox, radio, combobox, slider) |
| `browser_close` | Close the current page |
| `browser_resize` | Resize the browser window |
| `browser_evaluate` | Execute JavaScript on the page or a specific element |
| `browser_run_code` | Run a Playwright code snippet with full `page` API access. Runs with a 30-second timeout — returns a clear error if the code hangs |
| `browser_take_screenshot` | Capture a PNG/JPEG screenshot of the viewport, full page, or element |
| `browser_wait_for` | Wait for text to appear/disappear or a time delay |
| `browser_console_messages` | Return console messages (filterable by level) |
| `browser_network_requests` | List network requests since page load. The initial page load may not be captured — navigate or reload to see all requests |
| `browser_file_upload` | Upload files to a file chooser dialog |
| `browser_handle_dialog` | Accept or dismiss a browser dialog (alert, confirm, prompt) |

### Navigation

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_navigate_back` | Go back in history. Timeout-tolerant — catches navigation timeout errors gracefully (common with SPAs and bfcache) |

### Tabs

| Tool | Description |
|------|-------------|
| `browser_tabs` | List, create, close, or select Playwright-managed tabs |

### Input

| Tool | Description |
|------|-------------|
| `browser_press_key` | Press a keyboard key |
| `browser_type` | Type text into an editable element by ref (fill or sequential key-by-key) |

### Earthling Cross-Tab (extension required)

| Tool | Description |
|------|-------------|
| `browser_list_all_tabs` | List ALL open browser tabs (not just Playwright-managed) via the extension. Annotates each tab with lease state (`[leased-by-you]`, `[busy: <clientId>]`, or `[free]`) and `[active]` when Chrome has focus on it. Pure read — never silently claims a tab |
| `browser_switch_tab` | Claim a tab lease and switch this client's CDP session to it. Pass `force: true` to revoke another client's lease. Returns the transition it performed: tab `claimed`, prior tab `released` (if any), and `revokedFrom` client id when forced |
| `browser_release_tab` | Release the tab lease held by this client and detach the CDP debugger on that tab. Reports `(CDP debugger detached.)` when detach succeeds |
| `browser_open_tab` | Open a new browser tab, optionally with a URL |
| `browser_close_tab` | Close a browser tab by tab ID |

## Multi-agent architecture

The CDP relay is a **standalone daemon** (`dist/relay-daemon.js`), lazy-spawned by the first MCP process that needs it and shared by all subsequent ones. Multiple agents (MCP clients) can drive different tabs in the same browser concurrently.

- **Port ownership** — the daemon owns `127.0.0.1:9223` via a TCP bind race (no lockfile). Override with `BROWSER_AUTOMATION_MCP_RELAY_PORT`. The default port constant lives in `src/tools/mcp/relay/constants.ts` (`DEFAULT_RELAY_PORT`) and is shared across the daemon, extension-context factory, and CDP relay; the Chrome extension mirrors the literal with a comment pointing back to that file.
- **Endpoints** — HTTP `/discover`, `/health` (returns `extension`, `clients`, `clients_1s_high_water`, `leases`, and a `telemetry` block with `hint_direct_attach` / `hint_missed` / `hint_fallback_blank` / `serialize_retry_timeout` aggregate counters), `/shutdown`, `POST /telemetry/bump?counter=...` (cross-process counter increments from MCP clients); WebSocket `/cdp/<uuid>` (N MCP clients) and `/extension/<uuid>` (single extension).
- **Per-client isolation** — the daemon rewrites CDP `sessionId`s and command `id`s per client so concurrent agents don't collide.
- **Tab leasing** — one agent per tab. `browser_switch_tab` claims the lease; other clients see the tab as `[busy: <clientId>]` and must use `force: true` to revoke. `browser_release_tab` releases voluntarily and detaches the CDP debugger on that tab. Client-WS close also detaches the debugger on every tab it was holding, so orphan attachments do not survive the client.
- **Atomic force-switch** — the daemon uses a two-phase reserve → call-extension → commit flow. During the in-flight window, other clients polling `browser_list_all_tabs` never see the contested tab as `[free]`; it flips from `[busy: A]` straight to `[busy: B]` on commit (or stays with `A` if the extension call fails or times out).
- **Preemption announcement** — when a client is preempted via `force: true`, the daemon sends an `Earthling.tabPreempted` CDP event on the loser's WS. The loser sees a line in its next tool response's `Events` section: `Your lease on tab N was preempted by client <id> (reason: force-switch).`
- **Lifecycle** — daemon lives while the extension is connected, applies a 60s grace period on disconnect (covers MV3 service-worker sleep), then exits cleanly. Runtime artefacts (PID, secret, logs) live in `.runtime/` (gitignored). The extension's auto-reconnect loop rediscovers via `/discover` across daemon restarts.

### CDP Command Routing

The daemon distinguishes between browser-level and tab-scoped CDP commands:

- **Browser-level commands** (no `sessionId`) — handled locally by `_handleTopLevel` or returned as empty success `{}`. Never forwarded to the extension.
- **Tab-scoped commands** (with virtual `sessionId`) — forwarded to the extension via `sendToExtensionForClient` with per-client command-id rewriting.

Tab switching uses **backend disposal + reconnection**: `browser_switch_tab` updates leases and calls the extension, then `response.setClose()` disposes the Playwright backend. The next tool call creates a fresh `connectOverCDP` connection, and `_handleSetAutoAttach` selects the target tab with a three-step chain:
1. `_lastSwitchedTab` hint (server-level Map surviving client reconnections) AND the hint tab is visible in the live `listTabs()` snapshot.
2. Hint present but missing from `listTabs()` — retry via a direct extension `attachToTab` (the live snapshot can be stale mid-navigation).
3. Auto-open a fresh blank tab when no hint exists or direct-attach failed.

There is no silent-claim fallback — listing tabs or connecting does not acquire a tab. The client must call `browser_switch_tab` explicitly.

### Transparent Reconnect

The MCP backend auto-reconnects when the CDP WebSocket dies (daemon respawn, extension disable/enable, browser restart). `BrowserBackend` captures a reconnect factory closure at creation time and checks `browser.isConnected()` before each tool dispatch; if disconnected, or if a tool call fails with a disconnect-shaped error (`Target.*closed`, `Connection closed`, `browser has been closed`, `Session closed`), it disposes the stale context, re-invokes the factory with 3-attempt exponential backoff (1s, 2s), rebuilds the `Context`, and retries the tool call once. The MCP SDK never sees a dispose — agents experience at most a ~30s one-shot latency on the tool call that happened to coincide with the disconnect.

### Action Timeouts

Every action tool (`browser_click`, `browser_type`, `browser_fill_form`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_file_upload`, `browser_press_key`, `browser_mouse_*`) is bounded by a 30s default budget (60s for `browser_fill_form`, which iterates N fields). On expiry the tool throws an error containing `exceeded 30000ms budget` and a hint to call `browser_snapshot` to verify page state. Underneath, Playwright's `ProgressController` applies a 120s hard ceiling to every operation — callers that pass `timeout=0` (nominal "infinite") still get a bounded deadline. No tool call can hang forever regardless of how pathological the page is.

### Known Limitations

- **Multi-agent concurrency is partially validated** — per-tab virtual↔real CDP session binding works for iframes/workers (Phase 2), but page-level `sessionId` is not capturable (`chrome.debugger.attach({tabId})` IS the page session — no child "page" target exists to auto-attach to). Tab-scoped concurrency routes through the daemon by tabId; end-to-end multi-agent stress test remains unvalidated under autonomous conditions.
- **`browser_switch_tab` latency** — tab switch incurs a dispose→reconnect cycle (~2–5s). This is intentional: Playwright's `CRPage`↔`CDPSession` binding is immutable without non-trivial internals patches. Elimination was investigated and deferred (see `memory/topic/browser-mcp-tab-switch-fixes.md`).

### Capability-Gated Tools

These tools require specific capabilities to be enabled in config:

| Capability | Tools |
|------------|-------|
| `vision` | `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_wheel` |
| `storage` | `browser_storage_state`, `browser_set_storage_state`, `browser_cookie_*` (get/list/set/delete/clear), `browser_localstorage_*`, `browser_sessionstorage_*` |
| `network` | `browser_network_state_set`, `browser_route`, `browser_route_list`, `browser_unroute` |
| `testing` | `browser_verify_text_visible`, `browser_verify_element_visible`, `browser_verify_list_visible`, `browser_verify_value`, `browser_generate_locator` |
| `devtools` | `browser_start_tracing`, `browser_stop_tracing`, `browser_start_video`, `browser_stop_video` |
| `pdf` | `browser_pdf_save` |
| `config` | `browser_get_config` |

## Architecture

```
browser-automation-mcp/
├── src/
│   ├── tools/
│   │   ├── backend/                # Tool definitions (pure Playwright logic)
│   │   │   ├── tool.ts             # Tool type, defineTool/defineTabTool helpers
│   │   │   ├── tools.ts            # Tool registry (imports all tool files)
│   │   │   ├── context.ts          # Browser context wrapper (tabs, secrets, URL filtering)
│   │   │   ├── tab.ts              # Tab abstraction (ref resolution, snapshot, wait)
│   │   │   ├── response.ts         # Response builder (text, code, files, images)
│   │   │   ├── snapshot.ts         # Snapshot + click/hover/drag/select tools
│   │   │   ├── navigate.ts         # URL navigation, back, forward, reload
│   │   │   ├── keyboard.ts         # Key press, type, sequential typing
│   │   │   ├── form.ts             # Multi-field form filling
│   │   │   ├── tabs.ts             # Playwright tab management
│   │   │   ├── evaluate.ts         # JavaScript evaluation
│   │   │   ├── runCode.ts          # Playwright code snippet execution
│   │   │   ├── screenshot.ts       # Screenshot capture and scaling
│   │   │   ├── console.ts          # Console message retrieval
│   │   │   ├── network.ts          # Network request listing, offline mode
│   │   │   ├── files.ts            # File upload handling
│   │   │   ├── dialogs.ts          # Dialog accept/dismiss
│   │   │   ├── common.ts           # Close, resize
│   │   │   ├── mouse.ts            # Coordinate-based mouse tools (vision capability)
│   │   │   ├── cookies.ts          # Cookie CRUD (storage capability)
│   │   │   ├── webstorage.ts       # localStorage/sessionStorage CRUD (storage capability)
│   │   │   ├── storage.ts          # Storage state save/restore (storage capability)
│   │   │   ├── route.ts            # Request interception (network capability)
│   │   │   ├── verify.ts           # Assertion tools (testing capability)
│   │   │   ├── tracing.ts          # Trace recording (devtools capability)
│   │   │   ├── video.ts            # Video recording (devtools capability)
│   │   │   ├── pdf.ts              # PDF save (pdf capability)
│   │   │   ├── config.ts           # Config display (config capability)
│   │   │   ├── wait.ts             # Wait for text/time
│   │   │   ├── earthlingTabs.ts    # Earthling cross-tab tools (via extension WebSocket)
│   │   │   └── utils.ts            # Shared backend utilities
│   │   ├── mcp/                    # MCP server layer
│   │   │   ├── index.ts            # createConnection — wires config + tools + browser → server
│   │   │   ├── config.ts           # Config resolution (CLI, env vars, config file, defaults)
│   │   │   ├── relay/              # Standalone CDP relay daemon (lazy-spawned, shared by all MCP clients)
│   │   │   │   ├── daemon.ts       # Daemon entry — owns :9223 via bind race, HTTP + WS endpoints
│   │   │   │   └── cdpRelay.ts     # Relay core — per-client session/command-id rewriting, tab leasing
│   │   │   ├── browserFactory.ts   # Browser launch strategies (headed, headless, CDP, extension)
│   │   │   ├── extensionContextFactory.ts  # Extension mode browser context (stableClientId, disposed callback)
│   │   │   ├── protocol.ts         # Extension command/event types
│   │   │   ├── program.ts          # CLI argument parsing
│   │   │   └── watchdog.ts         # Connection health monitoring
│   │   └── utils/                  # MCP server utilities
│   ├── mcpBundle.ts                # Zod + MCP SDK re-exports
│   ├── utilsBundle.ts              # Third-party utility re-exports
│   └── skill/                      # Skill definitions
├── earthling-extension/            # Earthling Browser Bridge Chrome extension
│   ├── manifest.json
│   ├── background.js               # Extension service worker (auto-connects on SW startup)
│   └── status.html / status.js     # Status UI
├── packages/
│   ├── playwright-mcp/             # Published @playwright/mcp package
│   │   ├── tests/                  # Playwright Test specs
│   │   └── playwright.config.ts
│   ├── extension/                  # Chrome extension build output
│   └── playwright-cli-stub/        # CLI wrapper
├── scripts/
│   └── build.js                    # esbuild bundler
├── dev.ts                          # Development entry point (tsx)
├── tsconfig.json                   # TypeScript config (strict, ES2022, Node16)
└── package.json                    # Workspaces: packages/*
```

## Configuration

The server accepts configuration via CLI flags, environment variables (`PLAYWRIGHT_MCP_*`), or a JSON/INI config file (`--config`). Key options:

| Option | CLI Flag | Env Var | Default |
|--------|----------|---------|---------|
| Browser | `--browser` | `PLAYWRIGHT_MCP_BROWSER` | `chrome` |
| Extension mode | `--extension` | `PLAYWRIGHT_MCP_EXTENSION` | `false` |
| Headless | `--headless` | `PLAYWRIGHT_MCP_HEADLESS` | auto (Linux without DISPLAY) |
| Capabilities | `--caps` | `PLAYWRIGHT_MCP_CAPS` | core only |
| CDP endpoint | `--cdp-endpoint` | `PLAYWRIGHT_MCP_CDP_ENDPOINT` | none |
| Port (SSE) | `--port` | `PLAYWRIGHT_MCP_PORT` | none (stdio) |
| Viewport | `--viewport-size` | `PLAYWRIGHT_MCP_VIEWPORT_SIZE` | null (full window) |

See `src/tools/mcp/config.ts` for the complete list of options and their environment variable equivalents.

## Requirements

- Node.js 18+
- Playwright browsers (`npx playwright install chromium`)
- For extension mode: Earthling Browser Bridge Chrome extension loaded

## Tests

```bash
# All browsers
npm test

# Chrome only
npm run ctest

# Firefox only
npm run ftest

# WebKit only
npm run wtest
```

Tests live in `packages/playwright-mcp/tests/` and use Playwright Test.

## Troubleshooting

### Debug Logs

Three structured JSONL files in `.runtime/debug/` (gitignored) capture cross-layer events for end-to-end correlation. Every line is a single JSON object with shared fields (`ts`, `layer`, `event`, optional `clientId`, `tabId`, `virtualSessionId`, `realSessionId`, `detail`).

| File | Layer | What's captured |
|------|-------|-----------------|
| `daemon.jsonl` | CDP relay daemon | Extension WS open/close, per-client connect/disconnect, tab lease ops, `cdp.out` commands forwarded to extension, `cdp.response.{in,delivered,orphan}`, session routing (virtual↔real), grace timer |
| `extension.jsonl` | Chrome extension service worker | Auto-connect lifecycle, debuggee attach/detach, `Target.attachedToTarget` child-session captures, tab open/switch/close, WS relay open/close/message. Batched POST to daemon's `/debug/extension` endpoint |
| `mcp.jsonl` | MCP process(es) | `mcp.connectOverCDP.{start,success,fail}`, `mcp.browser.disconnected`, `mcp.backend.{create,disposed}`, `mcp.backend.reconnect.{start,success,fail}` |

Correlate a single tool call across all three files by filtering on `clientId` (mcp-<pid>) or `tabId`. To tail live:

```bash
tail -f tools/browser-automation-mcp/.runtime/debug/{daemon,extension,mcp}.jsonl
```

### Other

- **Daemon text log** — `.runtime/relay-daemon.log` via the `debug` module (`pw:mcp:relay` namespace). Redundant with `daemon.jsonl` for most purposes but preserves the upstream Playwright MCP logging format.
- **Extension debug ring buffer** — the extension's `background.js` maintains a 200-entry in-memory ring buffer. Query it via the `Earthling.getDebugLog` pseudo-CDP command through the daemon if the SW has flushed its JSONL batches but you need the latest in-flight entries.
