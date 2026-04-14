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
| `browser_run_code` | Run a Playwright code snippet with full `page` API access |
| `browser_take_screenshot` | Capture a PNG/JPEG screenshot of the viewport, full page, or element |
| `browser_wait_for` | Wait for text to appear/disappear or a time delay |
| `browser_console_messages` | Return console messages (filterable by level) |
| `browser_network_requests` | List network requests since page load |
| `browser_file_upload` | Upload files to a file chooser dialog |
| `browser_handle_dialog` | Accept or dismiss a browser dialog (alert, confirm, prompt) |

### Navigation

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_navigate_back` | Go back in history |

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
| `browser_list_all_tabs` | List ALL open browser tabs (not just Playwright-managed) via the extension. Annotates each tab with lease state: `[leased-by-you]`, `[busy: <clientId>]`, or `[free]` |
| `browser_switch_tab` | Claim a tab lease and switch this client's CDP session to it. Pass `force: true` to revoke another client's lease |
| `browser_release_tab` | Release the tab lease held by this client |
| `browser_open_tab` | Open a new browser tab, optionally with a URL |
| `browser_close_tab` | Close a browser tab by tab ID |

## Multi-agent architecture

The CDP relay is a **standalone daemon** (`dist/relay-daemon.js`), lazy-spawned by the first MCP process that needs it and shared by all subsequent ones. Multiple agents (MCP clients) can drive different tabs in the same browser concurrently.

- **Port ownership** — the daemon owns `127.0.0.1:9223` via a TCP bind race (no lockfile). Override with `BROWSER_AUTOMATION_MCP_RELAY_PORT`.
- **Endpoints** — HTTP `/discover`, `/health`, `/shutdown`; WebSocket `/cdp/<uuid>` (N MCP clients) and `/extension/<uuid>` (single extension).
- **Per-client isolation** — the daemon rewrites CDP `sessionId`s and command `id`s per client so concurrent agents don't collide.
- **Tab leasing** — one agent per tab. `browser_switch_tab` claims the lease; other clients see the tab as `[busy: <clientId>]` and must use `force: true` to revoke. `browser_release_tab` releases voluntarily.
- **Lifecycle** — daemon lives while the extension is connected, applies a 60s grace period on disconnect (covers MV3 service-worker sleep), then exits cleanly. Runtime artefacts (PID, secret, logs) live in `.runtime/` (gitignored). The extension's auto-reconnect loop rediscovers via `/discover` across daemon restarts.

### CDP Command Routing

The daemon distinguishes between browser-level and tab-scoped CDP commands:

- **Browser-level commands** (no `sessionId`) — handled locally by `_handleTopLevel` or returned as empty success `{}`. Never forwarded to the extension.
- **Tab-scoped commands** (with virtual `sessionId`) — forwarded to the extension via `sendToExtensionForClient` with per-client command-id rewriting.

Tab switching uses **backend disposal + reconnection**: `browser_switch_tab` updates leases and calls the extension, then `response.setClose()` disposes the Playwright backend. The next tool call creates a fresh `connectOverCDP` connection, and `_handleSetAutoAttach` selects the target tab with 3-priority selection:
1. `_lastSwitchedTab` hint (server-level Map surviving client reconnections)
2. Extension's currently-connected tab
3. First free non-internal tab (filters `chrome://`, `edge://`, `chrome-extension://` URLs)

### Known Limitations

- **Cooperative-sequential multi-agent** — both agents can be connected simultaneously, but only one can actively use browser tools at a time (Bug 2: virtual-to-real CDP session binding is deferred)
- **Extension lifecycle requires session reload** — extension disable/re-enable or browser restart recovers the daemon but the MCP process's Playwright connection goes stale
- **`chrome-extension://` connect page** doesn't survive browser restart or extension disable — must be manually reopened

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
│   ├── background.js               # Extension service worker
│   ├── connect.html / connect.js   # Connection UI
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
