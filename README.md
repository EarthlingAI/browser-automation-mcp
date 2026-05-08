# browser-automation-mcp

MCP server for browser automation via Playwright accessibility-tree snapshots. Agents interact with web pages through structured text (element refs, accessibility roles) rather than screenshots or vision models. Forked from [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp); see `UPSTREAM.md` for the fork delta.

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

### Requirements

- Node.js 18+
- Playwright browsers (`npx playwright install chromium`)
- For extension mode: Earthling Browser Bridge Chrome extension loaded

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
| `browser_run_code` | Run a Playwright code snippet with full `page` API access. 30s timeout |
| `browser_take_screenshot` | Capture a PNG/JPEG screenshot of the viewport, full page, or element |
| `browser_wait_for` | Wait for text to appear/disappear or a time delay |
| `browser_console_messages` | Return console messages (filterable by level) |
| `browser_network_requests` | List network requests since page load. Initial page load may not be captured — navigate or reload to see all requests |
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
| `browser_list_all_tabs` | List ALL open browser tabs (not just Playwright-managed) via the extension. Annotates each tab with lease state (`[leased-by-you]`, `[busy: <clientId>]`, `[free]`) and `[active]` when Chrome has focus. Pure read — never silently claims a tab |
| `browser_switch_tab` | Claim a tab lease and route this client to it. Pass `force: true` to revoke another client's lease. Returns the transition: `claimed`, prior `released`, `revokedFrom` (when forced) |
| `browser_release_tab` | Release the tab lease held by this client and detach the CDP debugger on that tab. Reports `(CDP debugger detached.)` on success |
| `browser_open_tab` | Open a new browser tab, optionally with a URL |
| `browser_close_tab` | Close a browser tab by tab ID |

### Capability-Gated Tools

Tools below are exposed only when the matching capability is enabled in config. `core` capabilities are always on.

| Capability | Tools |
|------------|-------|
| `vision` | `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_wheel` |
| `storage` | `browser_storage_state`, `browser_set_storage_state`, `browser_cookie_*`, `browser_localstorage_*`, `browser_sessionstorage_*` |
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
│   │   ├── backend/                # Tool definitions (pure Playwright logic, no MCP awareness)
│   │   │   ├── tool.ts             # Tool type, defineTool/defineTabTool helpers
│   │   │   ├── tools.ts            # Tool registry (imports all tool files)
│   │   │   ├── context.ts          # Browser context wrapper (tabs, secrets, URL filtering)
│   │   │   ├── tab.ts              # Tab abstraction (ref resolution, snapshot, wait)
│   │   │   ├── browserBackend.ts   # BrowserBackend dispatcher (mutex, transparent reconnect)
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
│   │   ├── mcp/                    # MCP server wiring
│   │   │   ├── index.ts            # createConnection — wires config + tools + browser → server
│   │   │   ├── config.ts           # Config resolution (CLI, env vars, config file, defaults)
│   │   │   ├── relay/              # Standalone CDP relay daemon (lazy-spawned, shared by all MCP clients)
│   │   │   │   ├── daemon.ts       # Daemon entry — owns :9223 via bind race, HTTP + WS endpoints
│   │   │   │   └── cdpRelay.ts     # Relay core — per-client session/command-id rewriting, tab leasing
│   │   │   ├── browserFactory.ts   # Browser launch strategies (headed, headless, CDP, extension)
│   │   │   ├── extensionContextFactory.ts  # Extension mode context (stableClientId, disposed callback)
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
│   ├── build.js                    # esbuild bundler
│   ├── concurrent-smoke.ts         # 2-client + lease-churn baseline (smoke gate)
│   ├── wedge-detector.ts           # 4-client raw-WS abort cascade harness (wedge-stab Layer A)
│   ├── layer-b-driver.ts           # Isolated-Chrome + alt-port-daemon scenarios (wedge-stab Layer B)
│   ├── sync-broadcast.ts           # TCP barrier broadcaster for cross-process release skew
│   └── soak.ts                     # Wall-clock soak orchestrator across all of the above
├── dev.ts                          # Development entry point (tsx)
├── tsconfig.json                   # TypeScript config (strict, ES2022, Node16)
└── package.json                    # Workspaces: packages/*
```

## Multi-Agent Architecture

The CDP relay is a **standalone singleton daemon** (`mcp/relay/daemon.ts`, built to `dist/relay-daemon.js`), lazy-spawned by the first MCP process that needs it and shared by all subsequent ones. Multiple agents (MCP clients) drive different tabs in the same browser concurrently.

### Daemon Endpoints & Port Ownership

The daemon owns `127.0.0.1:9223` via a TCP bind race (no lockfile). Override with `BROWSER_AUTOMATION_MCP_RELAY_PORT`. The default lives in `src/tools/mcp/relay/constants.ts` (`DEFAULT_RELAY_PORT`) and is shared across daemon, extension-context factory, and CDP relay; the Chrome extension mirrors the literal with a comment pointing back.

- HTTP `/discover`, `/health`, `/shutdown`, `POST /telemetry/bump?counter=...`
- WebSocket `/cdp/<uuid>` (N MCP clients) and `/extension/<uuid>` (single extension)

### Lifecycle

The daemon lives while the extension is connected, applies a 60s grace period on extension disconnect (covers MV3 service-worker sleep), then exits cleanly. Runtime state in `.runtime/` (PID, secret, logs — gitignored). The extension auto-connects on service-worker startup via `/discover`, no user-clicked tab required, and rediscovers across daemon restarts.

### Per-Client Isolation & CDP Routing

The daemon rewrites CDP `sessionId`s and command `id`s per client so concurrent agents don't collide. CDP commands are routed by scope:

- **Browser-level commands** (no `sessionId`) — handled locally by `_handleTopLevel` or returned as empty success `{}`. Never forwarded to the extension. The extension's `chrome.debugger` is tab-scoped and cannot service browser-level commands like `Target.setDiscoverTargets`.
- **Tab-scoped commands** (with virtual `sessionId`) — forwarded via `sendToExtensionForClient` with per-client command-id rewriting.

Session-id resolution in `sendToExtensionForClient` is three-way: virtual id (`_virtualSession.get`) → real child session id (`_extSession.get`) → fallback. `attachToTab` returns `sessionId: undefined` for page-level attachment (the debuggee IS the page session — no child page target exists). Iframe/worker child sessions ARE captured via `Target.setAutoAttach({flatten:true})` and stored in `_tabChildSessions` for sub-frame targeting.

### Tab Leasing

One agent per tab. `browser_switch_tab` claims the lease; other clients see the tab as `[busy: <clientId>]` and must use `force: true` to revoke. `browser_release_tab` releases voluntarily and detaches the CDP debugger on that tab. Client-WS close also detaches the debugger on every tab the client was holding (`releaseTabWithDetach` bundles lease release + `_cleanupTabSessions` + `extension.send('detachFromTab', {tabId}, 2_000)`), so orphan attachments don't survive the client.

### Atomic Force-Switch (Two-Phase Commit)

`LeaseTable._pendingByTab` holds reservations during `Earthling.switchToTab`; `ownerOf()` and `all()` deliberately hide pending state so a third client polling `browser_list_all_tabs` never observes the contested tab as `[free]` mid-transition. Flow:

1. `reservePending(tabId, newOwner, oldOwner)`
2. extension `switchToTab` call (5s timeout via `ExtensionConnection.send`)
3. `commitPending` on success (atomic swap of `_byTab[tabId]`, release of old owner + old primary) **OR** `cancelPending` on failure

`PENDING_EXPIRY_MS = 10_000` guards against extension flake (swept lazily on next `reservePending` for the same tab). The handler returns `{claimed, released, revokedFrom, force}`. The tab flips from `[busy: A]` straight to `[busy: B]` on commit, or stays with `A` on failure.

### Preemption Announcement

Before the force-switch commit revokes the loser's subscription, the daemon sends `Earthling.tabPreempted` (params: `{tabId, revokedBy, reason: 'force-switch'}`) on the loser's CDP WS. The MCP backend opens a persistent `browser.newBrowserCDPSession()` inside `_initializeBrowserContext` and listens for this event, pushing a human-readable line onto `_pendingEvents`. `Response._build` drains the buffer into the `Events` section of the loser's next tool response: *"Your lease on tab N was preempted by client <id> (reason: force-switch)."* CDP session is detached on `Context.dispose`. `_pendingEvents` caps at 50; oldest drops on overflow with a `… N earlier events dropped` sentinel prepended on the next drain.

### Tab Switch via Per-Tab Page Pool

Each Earthling tab has its own Playwright `Page` for the tab's lifetime, kept in the MCP backend's `Context._tabsByTabId`. `browser_switch_tab` is JS routing — the WebSocket stays alive, no `connectOverCDP` re-handshake, no Playwright dispose:

1. `browser_switch_tab(tabId)` → MCP backend calls `Earthling.switchToTab` (lease claim at the daemon → preemption notification to any displaced client).
2. If the backend already has a `Page` for that tabId in `_tabsByTabId`, route to it (`_currentTabId = tabId`, return — no daemon round-trip at the page layer).
3. Otherwise, the backend calls `Earthling.bindTab` → daemon emits `Target.attachedToTarget` → Playwright fires `BrowserContext.on('page')` → `Tab` is constructed and pooled.

`Earthling.bindTab` is **idempotent**: if `(clientId, tabId)` is already mapped in `CdpRelayServer._clientTabTargetIds`, it returns `{alreadyBound: true, targetId}` without re-emitting — re-emitting would trip Playwright's `assert(!this._crPages.has(...))` in `crBrowser`. The MCP backend calls `bindTab` only when `_tabsByTabId` does not yet have a `Page` for the requested tabId; lease ownership is a precondition the daemon enforces. `Earthling.switchToTab` does the lease claim + preemption notification only — no attach side-effect.

The pool is evicted lazily on Playwright's `Page.on('close')`. Preemption (daemon-emitted `Target.detachedFromTarget`), agent `browser_close_tab`, and user-initiated tab close all converge on the same eviction path. `Target.detachedFromTarget` carries the **real Chromium targetId**: `revokeTab` and `onExtensionLost` look the real targetId up from `_clientTabTargetIds` (recorded at attach time — both the `_handleSetAutoAttach` initial-connect path and the `Earthling.bindTab` path populate the map). The synthetic `tab-${tabId}` is preserved as a fallback for the rare case where attach predates the recording; without the fallback Playwright would silently ignore the detach and leak a `CRPage`.

### Hint Chain (Initial Connect & Reconnect Only)

The hint chain in `_handleSetAutoAttach` (`cdpRelay.ts`) is load-bearing for **initial connect** and **WS-death-recovery reconnect** only — it is NOT consulted on a normal `browser_switch_tab` (the pool routes those without a daemon-attach round-trip). Three-step priority:

1. **Direct attach** — hint (`_lastSwitchedTab`) present and visible in `listTabs()` → attach.
2. **Direct extension attach** — hint present but missing from `listTabs()` → retry via direct extension `attachToTab` (closes the `switch_tab` target-creation race where a stale `listTabs()` mid-navigation caused the client to silently land on a freshly-spawned `about:blank`).
3. **Auto-open blank** — no hint available → open a daemon-owned `about:blank`.

Lease re-reservation is **free-target-only**: each step calls `leases().claim(hintTab, this.id, false)` (non-force). If the hinted tab is already owned by another client, the claim fails and the hint is skipped, falling through to Priority 3. This prevents a reconnecting client from silently transferring an active holder's lease — the correct failure mode is "land on a fresh blank and make the user call `browser_switch_tab(force:true)` explicitly". `_lastSwitchedTab` is NOT cleared on claim failure, so subsequent reconnects retry once the target is released.

`_lastSwitchedTab` and `_declaredSwitchTarget` are explicitly NOT cleared on client-disconnect — they survive WS-close → reconnect cycles and are cleared only on actual tab-gone events (`_forgetTab`, `releaseTab`, `revokeTab`, `onExtensionLost`).

### Daemon-Owned Auto-Blanks Auto-Close

Priority-3 fallback tabs are tracked in `CdpRelayServer._autoOpenedBlanks` keyed by clientId and closed automatically on three paths: (a) `switchToTab` when the client switches off, (b) `releaseTab` when the client releases, (c) client-WS close. Without this tracking, every `connectOverCDP` handshake leaks one blank into the user's browser.

### Smart Reconnect on SW Restart

`_handleExtensionConnection` queries the reconnected extension for surviving tabs before deciding to flush client state. Service-worker restart (tabs alive) skips flush; browser restart (tabs dead) flushes.

### Transparent Backend Reconnect

`BrowserBackend` holds a `reconnectFactory` closure (captured in `program.ts` at `create()`). `callTool` checks `browser.isConnected()` pre-dispatch and regex-detects disconnect-shaped tool errors (`/Target.*closed|Connection closed|browser has been closed|Session closed|No debugger attached/i`). On detection: dispose stale context → invoke factory with 3-attempt exponential backoff (1s, 2s) → rebuild Context with same config + sessionLog → retry tool call once. Concurrent disconnect observations are coalesced via `_reconnectInFlight`. The MCP SDK never sees a dispose from a transient WS death.

The daemon **cooperates** by force-closing client WSs on terminal extension loss — `ClientConnection.onExtensionLost` calls `drainAndClose` after sending `Target.detachedFromTarget` frames, so Playwright's `Browser.isConnected()` flips to false immediately and the pre-dispatch path (not the tool-error regex) triggers the next reconnect.

Agents experience at most a ~30s one-shot latency on the tool call that happened to coincide with the disconnect.

### Per-Client Dispatch Serialization

`BrowserBackend.callTool` holds a per-instance mutex (`_dispatchMutex`) across the whole body — pre-dispatch `isConnected` check, `tool.handle`, and `response.serialize`. This prevents parallel `tool_use` blocks from racing over the shared `Browser`/CDP-session state. When the mutex actually queues a call, the MCP process bumps `concurrent_dispatch_serialized` via `POST /telemetry/bump`. `_reconnectInFlight` is redundant under the mutex but kept as defence in depth.

### Action Timeouts

Every action tool (`browser_click`, `browser_type`, `browser_fill_form`, `browser_hover`, `browser_drag`, `browser_select_option`, `browser_file_upload`, `browser_press_key`, `browser_mouse_*`) is bounded by a 30s default budget (60s for `browser_fill_form`, which iterates N fields). On expiry the tool throws an error containing `exceeded 30000ms budget` and a hint to call `browser_snapshot`. Underneath, Playwright's `ProgressController` clamps every operation to a 120s hard ceiling — even callers that pass `timeout=0` get a bounded deadline. `tab.actionTimeoutOptions.timeout` and `navigationTimeoutOptions.timeout` default to 30s when config is unset.

### Opportunistic Auto-Snapshot

Action tools call `response.setIncludeSnapshot()` to automatically return an updated page snapshot. The snapshot is **best-effort**: it races against a 3s budget (`SNAPSHOT_TIMEOUT_MS` in `response.ts`); if the page is wedged the tool still returns its primary result with a visible `[snapshot unavailable — page unresponsive, call browser_snapshot to retry]` marker. Inline snapshots larger than 100KB are auto-saved under `.playwright-mcp/snapshots/` and replaced with a pointer. Per-iframe capture is capped at 5s (`IFRAME_SNAPSHOT_TIMEOUT_MS` in `page.ts`) — one wedged iframe becomes an inline marker, not a hung response.

## Telemetry

`GET /health` exposes a `telemetry` block with monotonic counters. MCP processes contribute via `POST /telemetry/bump?counter=<name>`; the daemon updates the rest internally.

| Counter | What it counts | Bumped at |
|---|---|---|
| `hint_direct_attach` | Priority-1 hint chain wins (hint present and visible in `listTabs()`) | `_handleSetAutoAttach` in `cdpRelay.ts` |
| `hint_missed` | Priority-2 transitions (hint visible only via direct extension `attachToTab`) | `_handleSetAutoAttach` in `cdpRelay.ts` |
| `hint_fallback_blank` | Priority-3 fallback blanks opened | `_handleSetAutoAttach` in `cdpRelay.ts` |
| `serialize_retry_timeout` | `response.serialize.retry` fallback count | MCP process via `POST /telemetry/bump` |
| `concurrent_dispatch_serialized` | Calls actually queued by `_dispatchMutex` (parallel dispatch in production) | MCP process via `POST /telemetry/bump` |
| `switch_tab_target_mismatch` | Declared switch target (in `_declaredSwitchTarget`) disagrees with where the client landed | `_handleSetAutoAttach` exit |
| `lifetime_clients_high_water` | Peak concurrent clients ever observed | `_handlePlaywrightConnection` (max-of) |
| `client_disconnect_count` | Total `ws.on('close')` observations (orderly + daemon-initiated `drainAndClose`) | client WS close handler |
| `clients_1s_high_water` | Rolling 1s window peak | sub-second sampler |

`switch_tab_target_mismatch` is a regression signal for the Scenario-1 hint-chain bypass class. `lifetime_clients_high_water` and `client_disconnect_count` capture sub-second churn that the rolling 1s window misses.

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

See `src/tools/mcp/config.ts` for the complete list.

## Response Format

Tool responses are text-based with Markdown-style sections. Action tools include the equivalent Playwright code (via `response.addCode()`) so agents can generate test code from execution traces.

**`browser_snapshot`** — accessibility tree + page metadata:

```
### Page state
- Page URL: https://example.com/
- Page Title: Example Domain
- Page Snapshot:
  - heading "Example Domain" [ref=e1]
  - paragraph [ref=e2]: "This domain is for use in illustrative examples..."
  - link "More information..." [ref=e3]
```

**`browser_click`** (action tool) — code block + auto-snapshot:

```
### Code
await page.getByRole('link', { name: 'More information...' }).click();

### Page state
(updated snapshot here)
```

If the auto-snapshot is wedged the response contains a marker instead:

```
### Page state
[snapshot unavailable — page unresponsive, call browser_snapshot to retry]
```

**Errors** — thrown as MCP `isError: true` responses with the `why` and `what to do` inline:

```
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "browser_click exceeded 30000ms budget — page may be wedged. Call browser_snapshot to verify state."
  }]
}
```

**Events section** — preempted clients see a line in the next tool response:

```
### Events
- Your lease on tab 1234 was preempted by client mcp-5678 (reason: force-switch).
```

## Tests

```bash
npm test                        # All browsers
npm run ctest                   # Chrome only — primary suite, 44 specs
npm run ftest                   # Firefox only
npm run wtest                   # WebKit only
npm run smoke-concurrent        # Two-client parallel navigate + evaluate smoke (default 30 iterations, BROWSER_CHANNEL=msedge)
MODE=lease-churn npm run smoke-concurrent  # 30 iterations of interleaved list → switch → list → release; asserts lease table self-consistency
```

Tests live in `packages/playwright-mcp/tests/` and use Playwright Test.

`npm run smoke-concurrent` (or `npx tsx scripts/concurrent-smoke.ts`) spawns the daemon, opens two independent `chromium.connectOverCDP` connections with distinct clientIds, and asserts no URL cross-contamination. `ITERATIONS=N` overrides iteration count; `BROWSER_CHANNEL=chrome|msedge` selects the channel.

### Wedge-stab regression gates

Three layered harnesses target the multi-client race surface that earlier production wedges (`switch_tab` "no targetId" stalls, `relay-wedge` recovery failures) exposed:

| Layer | Script | Surface |
|---|---|---|
| A | `scripts/wedge-detector.ts` (MODE=`wedge-probe` default) | 4 raw-WS clients × N iterations with mid-cycle victim aborts; daemon + extension WS lifecycle. |
| A | `scripts/concurrent-smoke.ts` MODE=`lease-churn` | 2-client interleaved switch/release; lease-table self-consistency. |
| B | `scripts/layer-b-driver.ts` SCENARIO=`preemption-staleness` \| `grace-race` | Isolated Chromium + alt-port daemon (no impact on the live 9223 daemon); full extension/Chrome stack; production-fidelity. |

`scripts/soak.ts` cycles all of the above for `SOAK_HOURS` (default 0.5, hard cap 8). Output goes to `outputs/wedge-stab/soak-<ts>/` (round NDJSON + per-failure logs + summary.md).

The Layer-B harness picks a free port (9224+), copies the extension to a tmpdir with the default `relayConfig.port` patched, and launches Playwright's bundled chromium with `--load-extension`. It's safe to run alongside the user's primary daemon. See script-head doc for SCENARIO list.

### Daemon-side instrumentation

`src/tools/mcp/relay/cdpRelay.ts` emits a 100ms `daemon.snapshot` JSONL line covering every per-tab map, the extension callback table, lease counts, and grace-timer state. Cadence is tunable via `EARTHLING_RELAY_SNAPSHOT_MS` (default 100, set 0 to disable for timing-sensitive tests). Per-call `callExtensionDirect.start/.response/.timeout/.error` events with latency are also emitted. `LeaseTable.sweepExpiredPending()` emits `lease.pending.sweep.fired` when expired entries are dropped. These were added in 2026-05-08's Stage A pass and are the foundation for any future investigation of unbounded daemon resources.

### Chrome ctest spec inventory (44 specs)

- `action-budget.spec.ts` — pathological-click page asserts `browser_click` rejects within ~30s with the budget-exceeded hint; verifies hard ceiling + 30s wrapper.
- `lease-atomic.spec.ts` — three-client force-switch atomicity: a polling client never observes the contested tab as `[free]` mid-transition.
- `preemption-events.spec.ts` — loser's next tool response contains the `Earthling.tabPreempted` event string in its `Events` section.
- `release-detaches-cdp.spec.ts` — after `browser_release_tab` (and after abrupt client-WS close), the released tab has no lingering debugger attachment.
- `auto-attach-pure-read.spec.ts` — `browser_list_all_tabs` is a pure read; no tab silently acquires a `[leased-by-you]` flag from listing.
- `no-singleton-badge.spec.ts` — `listBrowserTabs` no longer emits `CONNECTED`/`HIGHLIGHTED` strings; `chrome.action` badge text stays empty.
- `no-focus-theft.spec.ts` — `browser_open_tab` + `browser_switch_tab` leave the user's active tab unchanged.
- `safe-title.spec.ts` / `title-race.spec.ts` — `safeTitle` unit coverage + integration race asserting `Earthling.listTabsAnnotated` never throws when a peer tab is mid-navigation (defuses the `page.title()` "Execution context was destroyed" serializer hang).
- `rapid-switch.spec.ts` — `browser_open_tab(url=X) + browser_switch_tab` lands the lease on the requested target, not a racing `about:blank`. Asserts `client_disconnect_count` Δ === 0 across rapid switches.
- `tab-pool-routing.spec.ts` — open 3 tabs, switch between them, assert `Page` references stable across switch-back, `BrowserContext.pages().length` matches pool size, `client_disconnect_count` Δ === 0.
- `tab-pool-eviction.spec.ts` — `browser_close_tab` evicts the closed tab's pool entry via `Page.on('close')`; siblings unaffected; `client_disconnect_count` Δ === 0.
- `tab-pool-preemption.spec.ts` — two-client scenario: B preempts A via `force:true`; A's `Page` for the contested tab transitions to `isClosed() === true` and is evicted from A's pool; B's `Page` is healthy; A's `client_disconnect_count` Δ === 0.
- `tab-pool-survives-thinkgap.spec.ts` — single client opens + switches to T, sleeps 30s, then `browser.isConnected() === true`, lease still held, `Page` reference unchanged, `client_disconnect_count` Δ === 0. The H1 lease-persistence win.
- `pending-buffer-cap.spec.ts` — `Context._pendingEvents` caps at 50, oldest drops on overflow, `drainPendingEvents` prepends a `… N earlier events dropped` sentinel.
- `hint-fallback-telemetry.spec.ts` — `/health` exposes the `telemetry` block and counters advance monotonically across a client connect/disconnect cycle.
- `reconnect-preserves-switch-hint.spec.ts` — backend-dispose → reconnect preserves `_lastSwitchedTab` (the `_forgetTab` / `_cleanupTabSessions` split fix).
- `parallel-dispatch.spec.ts` — 10 parallel `Earthling.listTabsAnnotated` sends resolve without `-32000`; `/health.telemetry.concurrent_dispatch_serialized` field is wired.
- `switch-tab-target-mismatch-counter.spec.ts` — `/health.telemetry.switch_tab_target_mismatch` field is wired and monotonic.
- `orphan-sweep.spec.ts` — `Earthling.queryOrphanBlanks` extension command returns the documented shape; dev-only sweep helper is reachable through the protocol seam.
- `snapshot-mkdir.spec.ts` — `safeWriteFile` mirrors the mkdir-then-write pattern needed for nested target paths; regression-guards `browser_snapshot(filename:…)` against the silent-success-with-no-file bug.
- `open-tab-response-shape.spec.ts` — N parallel `Earthling.openTab` sends return tabId objects with consistent shape; Response-layer `setIncludePage(false)` in the `openTab` handler guarantees no `### Page` block across concurrent callers.
- `lifetime-counters.spec.ts` — `/health.telemetry.{lifetime_clients_high_water,client_disconnect_count}` fields are wired and advance correctly across sequential connect/disconnect cycles.

(Remaining specs cover upstream Playwright-MCP coverage carried over from the fork — see `packages/playwright-mcp/tests/` for the full set.)

**Test tab cleanup:** the daemon auto-closes Priority-3 auto-opened blanks on client disconnect / switch-off / release. Test specs only need to close their explicitly-opened tabs via `Earthling.closeTab`; they do NOT need to track the auto-attach blank the daemon spawned during `connectOverCDP` — that cleanup is free.

### Dev-only env flags

| Flag | Default | Effect |
|---|---|---|
| `EARTHLING_MCP_SWEEP_ORPHANS=1` | off | On daemon startup (after extension pair), close accumulated `about:blank` tabs older than 5 min with no history and no lease. Fire-and-forget; failure never blocks startup. |

## Known Limitations

- **Multi-agent concurrency is partially validated** — per-tab virtual↔real CDP session binding works for iframes/workers, but page-level `sessionId` is not capturable (`chrome.debugger.attach({tabId})` IS the page session — no child "page" target exists to auto-attach to). Tab-scoped concurrency routes through the daemon by tabId.
- **Force-reclaim of a wedged page-handle** — *resolved by the per-tab pool*. A preempted client's `Page` is closed via Playwright's standard `_onDetachedFromTarget` cleanup, and the next `browser_switch_tab(tabId, force:true)` re-binds a fresh `Page`.
- **Stale pool entry on cross-client preemption** — *resolved by the `Earthling.tabPreempted` pool eviction in `Context.cdp.on('Earthling.tabPreempted')` at `src/tools/backend/context.ts`.* Previously, when client B force-switched a tab held by A and then navigated it, A's pool entry kept the orphan `Page` reference; subsequent `browser_snapshot` / `browser_navigate` from A failed with `No frame with given id` until session reload. The handler now also calls `_evictTab(tabId)` so the next `acquireTab` flows through a fresh `Earthling.bindTab` and a new `Page` bound to the live frame. Side benefit: cosmetic stale `Page.url()` on auto-blank-repointed entries goes away with the eviction (the orphan reference is no longer addressable).

## Troubleshooting

### Debug Logs

Three structured JSONL files in `.runtime/debug/` (gitignored) capture cross-layer events for end-to-end correlation. Every line is a single JSON object with shared fields (`ts`, `layer`, `event`, optional `clientId`, `tabId`, `virtualSessionId`, `realSessionId`, `detail`). Helpers in `src/tools/mcp/relay/debugJsonl.ts` (`daemonJsonl()`, `mcpJsonl()`, `appendExtensionJsonl()`) write fire-and-forget.

| File | Layer | What's captured |
|------|-------|-----------------|
| `daemon.jsonl` | CDP relay daemon (`cdpRelay.ts`) | Extension WS open/close, per-client connect/disconnect, tab lease ops, `cdp.out` commands, `cdp.response.{in,delivered,orphan}`, session routing (`resolvedVia: 'virtual'\|'real'\|'unknown'\|'none'`), grace timer events, `lease.pending.{reserve,commit,cancel}`, `lease.takeover.notified`, `ext.detach.on-release`, `session.autoAttach.hint.{directAttach,missed,fallbackBlank}`, `session.autoAttach.target.mismatch`, `daemon.orphan_sweep.{skipped,closed,close_fail,complete,fail}` |
| `extension.jsonl` | Chrome extension SW (batched POST to daemon's `/debug/extension`, 50 entries or 500ms; flushes on `chrome.runtime.onSuspend`) | `autoConnect.*`, `debuggee.attach/detach`, `debugger.event.sessionCaptured`, `tab.switch/close/focus`, `ws.relay.*`, `tab.userActivated` (observation-only) |
| `mcp.jsonl` | MCP process(es), append-only — multiple processes share the file safely | `mcp.connectOverCDP.{start,success,fail}`, `mcp.browser.disconnected`, `mcp.backend.{create,disposed}`, `mcp.backend.reconnect.{start,success,fail}` |

Correlate a single tool call across all three files by filtering on `clientId` (`mcp-<pid>`) or `tabId`. To tail live:

```bash
tail -f tools/browser-automation-mcp/.runtime/debug/{daemon,extension,mcp}.jsonl
```

### Other logs

- **Daemon text log** — `.runtime/relay-daemon.log` via the `debug` module (`pw:mcp:relay` namespace). Mostly redundant with `daemon.jsonl`; preserves the upstream Playwright MCP logging format.
- **Extension debug ring buffer** — 200-entry in-memory buffer (`_debugRingBuffer`) in `background.js`. Query via the `Earthling.getDebugLog` pseudo-CDP command for in-flight entries not yet flushed to `extension.jsonl`.
- **Response timing** — `response.ts` logs `captureSnapshot` start/completion with duration via `requestDebug`.
