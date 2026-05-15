# browser-automation-mcp

Cross-tab control of the user's real authenticated Chrome session via a passive MV3 extension. 20 tools across tabs, observation, and interaction — every action runs in the background, never raising the window or stealing focus.

## Setup

```bash
npm install
npm run build              # esbuild → dist/index.js + dist/test-exports.mjs
```

Wire into the host agent's MCP config:

```jsonc
// .mcp.json (or equivalent MCP client config)
"browser-automation-mcp": {
  "command": "node",
  "args": ["tools/browser-automation-mcp/dist/index.js"]
}
```

### Load the Chrome extension

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `earthling-extension/` directory. The extension's options page (`status.html`) shows live daemon-connection state.

If a Reload doesn't take after rebuilding the extension, do a full Remove + Load unpacked — Chrome's Reload button sometimes leaves the MV3 service worker on stale handlers.

### CLI flags

| Flag             | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `--agent <label>` | Human-readable label surfaced in lease records. Useful when multiple agent sessions share one browser. |
| `--daemon`       | Internal — run as the singleton daemon. Bridges spawn this automatically.   |

## Tools

All tools are prefixed `browser_*`. Action tools (any tool that mutates the page) take four extra parameters injected by the action-tool wrapper — listed once below to avoid repetition in every table.

### Auto-snapshot + settle (every action tool)

| Parameter          | Type    | Default | Description                                                                                  |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------------------------- |
| `snapshot`         | boolean | `true`  | Auto-refresh the a11y tree after the action. Set `false` to skip for back-to-back actions.   |
| `delay`            | number  | `0.1`   | Seconds to wait before the auto-snapshot fires. Increase for slow transitions (0.5 menus, 1.0 dialogs, 2.0+ page nav). |
| `wait_for_settle`  | string  | `"dom"` | Settle signal: `"dom"` (first DOM mutation), `"network"` (first request), `"selector:<css>"` (named selector), or `"none"` (return immediately). |
| `settle_timeout`   | int     | `1500`  | Max ms to wait for the settle signal before returning anyway.                                |

### Tabs & sessions

#### `browser_list_tabs` (read-only)

List all open tabs across all browser windows. Returns `id`, `url`, `title`, `leasedBy`. Lease-free.

| Parameter | Type   | Default | Description                                       |
| --------- | ------ | ------- | ------------------------------------------------- |
| `query`   | string | —       | Substring filter on title/URL (case-insensitive). |

#### `browser_open_tab`

Open a URL in a new tab and auto-claim the lease. Defaults to background — never raises the window or activates the tab.

| Parameter    | Type    | Default | Description                                              |
| ------------ | ------- | ------- | -------------------------------------------------------- |
| `url`        | string  | —       | URL to open (validated).                                 |
| `background` | boolean | `true`  | Open without raising the browser window or activating the tab. |

Returns `{ id, url, title, navigated, settledAt, previousActiveTab }` — `navigated:false` signals the SPA dropped the requested URL to its root.

#### `browser_close_tab`

Close a tab by id and release its lease.

| Parameter | Type | Default | Description                       |
| --------- | ---- | ------- | --------------------------------- |
| `tabId`   | int  | —       | Tab id from `browser_list_tabs`.  |

#### `browser_switch_tab`

Claim the lease on an existing tab so this session can act on it. Errors with `leasedBy` if held; pass `force:true` with a `reason` to revoke.

| Parameter | Type    | Default | Description                                              |
| --------- | ------- | ------- | -------------------------------------------------------- |
| `tabId`   | int     | —       | Tab id from `browser_list_tabs`.                         |
| `force`   | boolean | `false` | Revoke another session's lease. Requires `reason`.       |
| `reason`  | string  | —       | Why you are revoking. Required when `force:true`.        |

Returns `{ claimed, previousActiveTab, previousActiveTabError? }` — `previousActiveTab` is explicit `null` when no foreground tab was found.

#### `browser_release_tab`

Release the lease on a tab so another session can claim it. Omit `tabId` to release all leases held by this session.

| Parameter | Type | Default | Description                              |
| --------- | ---- | ------- | ---------------------------------------- |
| `tabId`   | int  | —       | Tab id to release. Omit to release all.  |

### Observation

#### `browser_snapshot` (read-only)

Pruned accessibility-tree snapshot of the leased tab. Returns nodes with stable numeric `ref` IDs to target in interaction tools. Prefer this over `browser_screenshot`.

| Parameter      | Type    | Default      | Description                                                              |
| -------------- | ------- | ------------ | ------------------------------------------------------------------------ |
| `tabId`        | int     | last leased  | Tab to snapshot.                                                         |
| `detail`       | enum    | `"standard"` | `"standard"` = interactive elements only; `"full"` = entire a11y tree.   |
| `limit`        | int     | `500`        | Max nodes returned (ranked). Range 1-5000.                               |
| `viewportOnly` | boolean | `true`       | Exclude nodes outside the visible viewport.                              |

`detail:"full"` at `limit < 1000` raises the effective limit to 1000 and surfaces `meta.limit_adjusted` in the response.

#### `browser_screenshot` (read-only)

Background-tab screenshot via CDP `Page.captureScreenshot` — never raises the window. Defaults to JPEG quality 70 (~30-50 KB encoded). Use only when the snapshot tree alone is insufficient.

| Parameter  | Type    | Default      | Description                                                                                  |
| ---------- | ------- | ------------ | -------------------------------------------------------------------------------------------- |
| `tabId`    | int     | last leased  | Tab to capture.                                                                              |
| `format`   | enum    | `"jpeg"`     | `"png"` or `"jpeg"`.                                                                         |
| `quality`  | int     | `70`         | JPEG quality (1-100). Ignored for PNG.                                                       |
| `maxWidth` | int     | —            | Downscale the captured image to at most this width (preserves aspect ratio). Range 64-4096.  |

#### `browser_console_messages` (read-only)

Recent console output from the leased tab (log, warn, error). Supports cursor pagination.

| Parameter | Type   | Default      | Description                                                  |
| --------- | ------ | ------------ | ------------------------------------------------------------ |
| `tabId`   | int    | last leased  | Tab to read from.                                            |
| `limit`   | int    | `50`         | Max entries returned. Range 1-500.                           |
| `cursor`  | string | —            | Opaque cursor from a prior call's `next_cursor`.             |

#### `browser_network_requests` (read-only)

Recent network requests from the leased tab. For unfamiliar SPAs, call this first to discover real backend endpoints from xhr/fetch traffic before guessing endpoint paths.

| Parameter    | Type   | Default                                | Description                                                                                |
| ------------ | ------ | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tabId`      | int    | last leased                            | Tab to read from.                                                                          |
| `limit`      | int    | `50`                                   | Max entries returned. Range 1-500.                                                         |
| `cursor`     | string | —                                      | Opaque cursor from a prior call's `next_cursor`.                                           |
| `urlPattern` | string | —                                      | URL filter. Plain string = substring match. Wrap in `/.../` for regex (e.g. `/\/api\//`).  |
| `type`       | enum[] | `["xmlhttprequest","fetch","document"]` | Resource types: `xmlhttprequest`, `fetch`, `image`, `script`, `document`, `stylesheet`, `other`. |
| `methodIn`   | enum[] | all                                    | HTTP methods: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD`.                  |
| `statusGte`  | int    | —                                      | Include only responses with status >= this.                                                |
| `statusLt`   | int    | —                                      | Include only responses with status < this.                                                 |

### Navigation

#### `browser_navigate`

Navigate the leased tab to a URL. Omit `url` to reload the current page.

| Parameter   | Type   | Default              | Description                                       |
| ----------- | ------ | -------------------- | ------------------------------------------------- |
| `url`       | string | —                    | URL to navigate to. Omit to reload.               |
| `tabId`     | int    | last leased          | Tab to navigate.                                  |
| `waitUntil` | enum   | `"domcontentloaded"` | `"load"` or `"domcontentloaded"`.                 |

#### `browser_navigate_back`

Go back one entry in the leased tab's history.

| Parameter | Type | Default      | Description     |
| --------- | ---- | ------------ | --------------- |
| `tabId`   | int  | last leased  | Tab to act on.  |

### Interaction

#### `browser_click`

Click an element by `ref` from a recent snapshot. Supports modifiers, double/right click.

| Parameter    | Type     | Default  | Description                                              |
| ------------ | -------- | -------- | -------------------------------------------------------- |
| `ref`        | string   | —        | Element ref from `browser_snapshot` (e.g. `"5"`).        |
| `tabId`      | int      | last     | Tab to act on.                                           |
| `button`     | enum     | `"left"` | `"left"`, `"right"`, or `"middle"`.                      |
| `clickCount` | 1 \| 2 \| 3 | `1`     | Single, double, or triple click.                         |
| `modifiers`  | string[] | —        | Keys held during click, e.g. `["Control"]`, `["Shift"]`. |

#### `browser_type`

Type text into a textbox by `ref`. Clears existing value unless `append:true`.

| Parameter | Type    | Default | Description                                       |
| --------- | ------- | ------- | ------------------------------------------------- |
| `ref`     | string  | —       | Element ref from `browser_snapshot`.              |
| `text`    | string  | —       | Text to type.                                     |
| `tabId`   | int     | last    | Tab to act on.                                    |
| `append`  | boolean | `false` | Append instead of clearing first.                 |

#### `browser_select_option`

Select an option in a `<select>` element by value or visible label.

| Parameter | Type   | Default | Description                                |
| --------- | ------ | ------- | ------------------------------------------ |
| `ref`     | string | —       | Element ref to a `<select>`.               |
| `value`   | string | —       | Option value or visible label.             |
| `tabId`   | int    | last    | Tab to act on.                             |

#### `browser_hover`

Hover the pointer over an element by `ref`. Useful for revealing hover menus.

| Parameter | Type   | Default | Description           |
| --------- | ------ | ------- | --------------------- |
| `ref`     | string | —       | Element ref to hover. |
| `tabId`   | int    | last    | Tab to act on.        |

#### `browser_scroll`

Scroll the page or a specific scrollable element by deltas (positive = down/right).

| Parameter | Type   | Default | Description                                       |
| --------- | ------ | ------- | ------------------------------------------------- |
| `ref`     | string | —       | Element ref to scroll. Omit to scroll the page.   |
| `tabId`   | int    | last    | Tab to act on.                                    |
| `deltaY`  | number | `400`   | Vertical scroll delta.                            |
| `deltaX`  | number | `0`     | Horizontal scroll delta.                          |

#### `browser_upload`

Upload local files to a file input by `ref`.

| Parameter | Type     | Default | Description                                |
| --------- | -------- | ------- | ------------------------------------------ |
| `ref`     | string   | —       | Element ref to a file input.               |
| `files`   | string[] | —       | Absolute paths to local files (1+).        |
| `tabId`   | int      | last    | Tab to act on.                             |

Max 10 files, 25 MB per file, 50 MB total.

#### `browser_press_key`

Press a keyboard shortcut at page level. Key names follow `KeyboardEvent.key`.

| Parameter   | Type     | Default | Description                                            |
| ----------- | -------- | ------- | ------------------------------------------------------ |
| `key`       | string   | —       | e.g. `"Enter"`, `"Tab"`, `"a"`, `"F5"`.                |
| `tabId`     | int      | last    | Tab to act on.                                         |
| `modifiers` | string[] | —       | e.g. `["Control"]`, `["Shift", "Alt"]`.                |

#### `browser_evaluate`

Run a JS expression in the leased tab and return the JSON-serialisable result. Strings come back as strings (not char-indexed objects). For unfamiliar SPAs, call `browser_network_requests` first to discover real backend endpoints.

| Parameter    | Type   | Default | Description                                                                      |
| ------------ | ------ | ------- | -------------------------------------------------------------------------------- |
| `expression` | string | —       | JS expression; the value of the last expression is returned.                     |
| `tabId`      | int    | last    | Tab to act on.                                                                   |

#### `browser_wait_for` (read-only)

Wait for a CSS selector, a JS predicate, network idle, or a timeout. Exactly one of `selector`, `condition`, or `networkIdle:true` must be set.

| Parameter          | Type    | Default | Description                                                                                  |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------------------------- |
| `selector`         | string  | —       | CSS selector to wait for. Pass raw — JSON layer handles escaping.                            |
| `condition`        | string  | —       | JS expression evaluated in-page on a polling loop. Use for state-machine SPAs (data-status, aria-busy, react state). |
| `networkIdle`      | boolean | `false` | Wait until no network activity for 500ms.                                                    |
| `timeout`          | int     | `10000` | Max wait in ms. Range 0-300000 (5 minutes).                                                  |
| `poll_interval_ms` | int     | `250`   | Polling interval for `condition` mode. Range 50-5000.                                        |
| `tabId`            | int     | last    | Tab to act on.                                                                               |

Condition mode runs through `chrome.debugger Runtime.evaluate` to bypass strict-CSP sites' `unsafe-eval` restrictions (Suno, ChatGPT, banks). The daemon's watchdog matches the command's `timeout` (plus a 5 s safety buffer), so the full schema-max of 5 minutes is honoured end-to-end.

## Annotations

| Tool                       | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| -------------------------- | ------------ | --------------- | -------------- | ------------- |
| `browser_list_tabs`        | ✓            | —               | ✓              | ✓             |
| `browser_open_tab`         | —            | —               | —              | ✓             |
| `browser_close_tab`        | —            | ✓               | ✓              | ✓             |
| `browser_switch_tab`       | —            | —               | ✓              | ✓             |
| `browser_release_tab`      | —            | —               | ✓              | ✓             |
| `browser_snapshot`         | ✓            | —               | ✓              | ✓             |
| `browser_screenshot`       | ✓            | —               | ✓              | ✓             |
| `browser_console_messages` | ✓            | —               | ✓              | ✓             |
| `browser_network_requests` | ✓            | —               | ✓              | ✓             |
| `browser_navigate`         | —            | ✓               | —              | ✓             |
| `browser_navigate_back`    | —            | ✓               | —              | ✓             |
| `browser_click`            | —            | ✓               | —              | ✓             |
| `browser_type`             | —            | ✓               | —              | ✓             |
| `browser_select_option`    | —            | ✓               | —              | ✓             |
| `browser_hover`            | —            | —               | —              | ✓             |
| `browser_scroll`           | —            | —               | —              | ✓             |
| `browser_upload`           | —            | ✓               | —              | ✓             |
| `browser_press_key`        | —            | ✓               | —              | ✓             |
| `browser_evaluate`         | —            | ✓               | —              | ✓             |
| `browser_wait_for`         | ✓            | —               | ✓              | ✓             |

The full policy is sweep-tested in `scripts/tests/annotations.test.mjs`.

## Architecture

```
Earthling agent ──MCP/stdio──▶ bridge process ──TCP loopback──▶ daemon ──WebSocket :9223──▶ MV3 extension ──chrome.tabs/.scripting/.debugger──▶ user's tabs
                  (one per                                       (singleton,                   ("Earthling Browser Bridge",
                  agent session)                                  owns leases)                  loaded into user's Chrome)
```

Three processes for two reasons:

1. **Multi-agent.** Each agent session spawns its own bridge MCP process. Bridges share one daemon, which shares one extension. Per-tab leases at the daemon layer keep concurrent agents from clobbering each other.
2. **Background by default.** The MV3 extension uses `chrome.tabs.create({active:false})` and `chrome.debugger Page.captureScreenshot` — never `tabs.update({active:true})`, never `captureVisibleTab`. The user keeps focus.

The daemon auto-spawns from the first bridge that finds the port unbound. Authentication uses Origin-header gating: the daemon checks every WebSocket upgrade against `chrome-extension://<id>` (extension ID pinned by the CRX `key` in `manifest.json`). Browsers set `Origin` from the executing context and JS cannot override it — web pages cannot impersonate the extension, no user-visible token paste required.

### File tree

```
browser-automation-mcp/
├── src/
│   ├── index.ts              # Entry — dispatches --daemon vs bridge mode based on argv
│   ├── protocol.ts           # Wire types shared by daemon, bridge, extension (BridgeRequest, ExtCommand, etc.)
│   ├── test-exports.ts       # Re-exports a subset of internals for the test harness only
│   ├── daemon/
│   │   ├── server.ts         # WebSocket + bridge TCP server + command router
│   │   ├── spawn.ts          # Race-safe daemon spawn (shared by startup + recovery)
│   │   ├── leases.ts         # TabLeaseManager — per-tab single-holder claim/release
│   │   └── timeouts.ts       # Pure helper inferring per-command extension-RPC watchdog (wait_for honours its own timeout + 5s; everything else gets 30s)
│   ├── bridge/
│   │   ├── mcp.ts            # MCP server entry (stdio + streamable-HTTP transports)
│   │   ├── meta.ts           # SERVER_INSTRUCTIONS string + BUILD_STAMP (injected by esbuild)
│   │   ├── client.ts         # Daemon client over loopback TCP (single-shot disconnect retry)
│   │   ├── registry.ts       # Tool registration + per-session ref registry + settle plumbing + envelope helpers
│   │   ├── session.ts        # Per-bridge session state (lastSnapshotRefs, lastLeasedTab, isStale)
│   │   └── tools/
│   │       ├── tabs.ts       # 5 tab/lease tools
│   │       ├── observe.ts    # 4 observation tools
│   │       ├── interact.ts   # 11 action tools (auto-snapshot + auto-settle wrapped)
│   │       └── coerce.ts     # Schema-input coercion helpers (coerceToArray, coerceBoolean, coerceLiteralNumber)
│   └── snapshot/
│       └── prune.ts          # A11y tree pruner — scoring, cookie-collapse, sidebar penalty, data-collapse, full-mode floor
├── earthling-extension/
│   ├── manifest.json         # MV3 — CRX key pinned for stable ID, alarms permission for keepalive
│   ├── background.js         # Service worker — WS client, chrome.* glue, settle observers, screenshot resize
│   ├── inject/
│   │   ├── helpers.js        # In-page a11y walker + interaction primitives (versioned via HELPERS_VERSION)
│   │   └── indicator.js      # In-page "agent is acting on this tab" indicator
│   ├── status.html           # Options page — live daemon-connection probe
│   └── status.js             # Probe script for status.html
└── scripts/
    ├── build.js              # esbuild → dist/index.js + dist/test-exports.mjs (injects __BUILD_STAMP__)
    ├── dump-session.js       # Dev helper — dumps the test-exports session state
    └── tests/
        ├── annotations.test.mjs   # Sweep test for tool annotation policy
        ├── coerce.test.mjs        # Schema coercion (stringified numbers/booleans/arrays)
        ├── envelope.test.mjs      # toolResult / toolError envelope shape
        ├── evaluate.test.mjs      # browser_evaluate primitive-wrap (Issue #2 regression)
        ├── fingerprint.test.mjs   # Build fingerprint surfaces in SERVER_INSTRUCTIONS
        ├── prune.test.mjs         # Pruner heuristics (cookie collapse, sidebar penalty, full-mode floor, etc.)
        ├── registry.test.mjs      # populateRefs + resolveRef (stale + fresh-state-miss paths)
        └── timeout.test.mjs       # inferExtTimeout — per-command watchdog inference
```

## Snapshot model

`browser_snapshot` returns a pruned accessibility tree with sequential numeric `ref` IDs. Action tools target elements by `ref` from the most recent snapshot. The pruner (`src/snapshot/prune.ts`) is a port of `windows-native-mcp`'s tree scorer + data-collapse pass:

- **Score-and-rank** by area, named-ness, viewport bounds, depth, navigation-role bonus, form-field-in-form boost, and modal-subtree boost.
- **Cap at `limit`** (default 500) with reserved slots for nav-role items (tab/menuitem/treeitem) AND for form-field roles inside a `<form>` ancestor — a deep listbox can't crowd out the primary interactive form.
- **Cookie-banner collapse** — OneTrust / Cookiebot / Quantcast-style consent banners (`position:fixed` + name matching `/cookie|consent|gdpr|privacy preference/i`) collapse to a single placeholder node. The agent can still dismiss the banner by clicking the placeholder.
- **Sidebar penalty** — lists with ≥8 same-role children get -10 per sibling above 6 (capped at -80). Off-axis items (outside the central horizontal third) get an additional -20.
- **Data-collapse** for `listitem`/`row`/`treeitem` parents with ≥2 text-only children — they emit a `values: [...]` array instead of nested children, cutting context 40-60% on data-heavy pages.
- **Full-mode floor** — `detail:"full"` at `limit < 1000` raises the effective limit to 1000 and surfaces `meta.limit_adjusted` in the response.
- **A11y-hidden filtering** — subtrees with `aria-hidden="true"` or `inert` are pruned entirely.

## Settle protocol

Action tools observe the page for a state delta before returning, so same-tick re-fires return only after the page has shown the action took effect. Tune via the `wait_for_settle` arg:

| Value              | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `"dom"` (default)  | Wait for the first DOM mutation, or `settle_timeout` ms          |
| `"network"`        | Wait for the first network request, or timeout                   |
| `"selector:<css>"` | Wait until the named CSS selector appears, or timeout            |
| `"none"`           | Return immediately; no settle wait                               |

Every action response includes `settled: { via, elapsedMs }`. This is what prevents the "click looked like a no-op so I fired it again" failure mode.

## Ref registry

Refs returned by `browser_snapshot` are tracked per bridge session in a `lastSnapshotRefs` map. Targeting an unknown or stale ref fails fast at the bridge layer with an actionable error — naming nearby refs by numeric proximity if the snapshot is fresh, or explaining the staleness if the agent has fired actions since the last snapshot. Action tools flip the registry to stale after firing; the auto-snapshot that follows flips it back to fresh.

## Lease model

```
A: browser_open_tab https://example.com         → lease auto-claimed by A
B: browser_list_tabs                             → sees A's lease on the tab
B: browser_switch_tab tabId=42                   → error: tab_leased by A
B: browser_switch_tab tabId=42 force=true reason="urgent task"
                                                 → claim succeeds; A's next call gets lease_required
```

`browser_release_tab` (no `tabId`) releases all of this session's leases — fastest way to hand over.

`browser_list_tabs` annotates each tab's `leasedBy` with `byCurrentSession: boolean` so the agent doesn't have to parse the `agentLabel` string.

`browser_switch_tab` and `browser_open_tab` both return `previousActiveTab: { id, title, url } | null` — the user's foreground tab at the moment of the call. Purely informational (we never activate the new tab).

`browser_open_tab` also returns `navigated: boolean` plus the actually-loaded URL/title — so the agent can detect when a `/c/<chat-id>` URL was caught by a SPA root and dropped to the index.

## Recovery

### Daemon recovery

The bridge holds the daemon endpoint in memory but lazily re-resolves it on socket close — the next tool call respawns the daemon via the same `daemon.lock`-protected path used at startup. Concurrent bridges race-share the spawn; exactly one new daemon process results.

`src/daemon/spawn.ts` auto-selects between two re-exec modes:

- **Entry on disk** (dev / standalone, `node dist/index.js`) — re-exec `process.execPath <entry> --daemon` directly.
- **Entry not on disk** (compiled host mode, source runs from memory) — re-enter via the host dispatcher as `<MCP_HOST_DISPATCHER> run-mcp browser-automation-mcp --daemon`. `MCP_HOST_DISPATCHER` is injected by the host on every spawned MCP child; its absence here is fatal.

Lease state lives only in the daemon's memory and is lost on respawn. The next tool call on a previously-leased tab returns `lease_required` — the agent re-claims via `browser_switch_tab`. In-flight requests at the moment the daemon dies fail fast with `daemon connection lost` rather than hanging.

### Extension recovery

The MV3 service worker idle-dies after ~30s of inactivity. A `chrome.alarms` keepalive heartbeat fires every 24s to stay under that threshold — without it the first call after even brief idle would return `extension not connected` even though everything is healthy.

If the SW wakes mid-call, the bridge transparently retries once after ~500 ms on `extension not connected` errors. If the retry also fails, the error propagates with `recovery` and `hint` fields carrying `"extension not connected — reload the Earthling Browser Bridge extension at chrome://extensions"`. The same hint covers user-initiated states (extension manually disabled at `chrome://extensions`).

## Response format

Tool responses are lean single-line JSON. List-style tools (`browser_list_tabs`, `browser_console_messages`, `browser_network_requests`) wrap their results as `{ count, items, ... }`. Errors carry structured fields — null/undefined keys are stripped.

**Success (action tool with auto-snapshot):**

```json
{
  "clicked": "5",
  "settled": { "via": "dom", "elapsedMs": 43 },
  "snapshot": { "ref": "1", "role": "WebArea", "name": "...", "children": [...] }
}
```

**Success (list-style tool):**

```json
{
  "count": 20,
  "items": [...],
  "truncated": true,
  "next_cursor": "abc123"
}
```

**Success (primitive from `browser_evaluate`):**

```json
{ "result": "https://example.com/page" }
```

The wrapper detects primitives and arrays and wraps them under `result` rather than spreading (spreading `"abc"` produces `{0:"a",1:"b",2:"c"}`).

**Error (lease):**

```json
{
  "error": "tab_leased",
  "leasedBy": "agent-alice",
  "since": "2026-05-16T11:48:23.000Z",
  "hint": "tab 42 is leased by another session; call browser_switch_tab again with force:true and reason:\"…\" to revoke"
}
```

**Error (extension disconnected):**

```json
{
  "error": "extension not connected",
  "kind": "extension_disconnected",
  "recovery": "extension not connected — reload the Earthling Browser Bridge extension at chrome://extensions",
  "hint": "extension not connected — reload the Earthling Browser Bridge extension at chrome://extensions"
}
```

The hint is a single universal string — the same message covers SW idle-death, user-initiated disable, and any other disconnect state. The bridge's transparent retry handles the cold-wake case; if the retry also fails, the agent surfaces this message and the user reloads the extension at `chrome://extensions`.

## Environment variables

| Variable                              | Default                                                       | Description                                                                                  |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`                       | `stdio`                                                       | `stdio` or `http`. HTTP mode binds a streamable-HTTP server.                                 |
| `MCP_HTTP_HOST`                       | `127.0.0.1`                                                   | Host for HTTP transport.                                                                     |
| `MCP_HTTP_PORT`                       | (required for http)                                           | Port for HTTP transport.                                                                     |
| `BROWSER_AUTOMATION_MCP_RUNTIME_DIR`  | OS state dir (see below)                                      | Override runtime-files location (`daemon.port`, `daemon.log`, `subscribe.token`).            |
| `BROWSER_AUTOMATION_MCP_RELAY_PORT`   | `9223`                                                        | Override the daemon ↔ extension WebSocket port. **Also update `DAEMON_URL` in `earthling-extension/background.js` if you change this** — the unpacked extension cannot read process env vars. |
| `MCP_HOST_DISPATCHER`                 | (injected by host)                                            | Path to the host's MCP dispatcher executable, used for daemon re-exec when the entry isn't on disk. |

Default runtime dir per OS:

- Windows: `%LOCALAPPDATA%\earthling\browser-automation-mcp\`
- Linux: `$XDG_STATE_HOME/earthling/browser-automation-mcp/` (or `~/.local/state/earthling/browser-automation-mcp/`)
- macOS: `~/Library/Application Support/earthling/browser-automation-mcp/`

`.runtime/` next to the bundle is a last-resort fallback for smoke tests.

## Tests

```bash
npm test                   # node --test scripts/tests/*.test.mjs
npm run dev                # esbuild watch mode (main bundle only)
```

The test harness imports from `dist/test-exports.mjs`, so run `npm run build` once before `npm test`. Tests cover pruner heuristics, ref registry, envelope shape, schema coercion, build fingerprint, annotation policy, daemon watchdog inference, and the `browser_evaluate` primitive-wrap regression — 37 cases total. All tests run without standing up the daemon or extension; they exercise pure helpers.

## License

MIT. Most of the codebase is from-scratch; the in-DOM accessibility walker (`earthling-extension/inject/helpers.js`) is conceptually based on `hangwin/mcp-chrome`'s `accessibility-tree-helper.js` (MIT).
