# browser-automation-mcp

Cross-tab Chrome control via a passive MV3 extension. **Never steals focus** — every action runs in the background.

## Installation

Stdio MCP server. Build, then wire into the host agent's MCP config:

```bash
npm install
npm run build
```

```jsonc
// .mcp.json (or equivalent MCP client config)
"browser-automation-mcp": {
  "command": "node",
  "args": ["tools/browser-automation-mcp/dist/index.js"]
}
```

Optional args/env:

- `--agent <label>` — human-readable label surfaced in lease records (useful when multiple agent sessions share one browser).
- `BROWSER_AUTOMATION_MCP_RUNTIME_DIR` — override the runtime-files location (`daemon.port`, `daemon.log`, `subscribe.token`). Defaults to a standard OS state dir (`%LOCALAPPDATA%\earthling\browser-automation-mcp` on Windows, `$XDG_STATE_HOME/earthling/...` on Linux, `~/Library/Application Support/earthling/...` on macOS); `.runtime/` next to the bundle is a last-resort fallback for smoke tests.
- `BROWSER_AUTOMATION_MCP_RELAY_PORT` — override the daemon ↔ extension WebSocket port. Defaults to `9223` (loopback only, origin-gated to the pinned extension ID — see Architecture). Invalid values log a warning and fall back to the default. **If you override this, you must also update `DAEMON_URL` in `earthling-extension/background.js` (and the probe URL in `status.js`/`status.html`) to match — the unpacked extension cannot read process env vars.**

### Load the Chrome extension

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `earthling-extension/` directory from this package. The extension's options page (`status.html`) shows live daemon-connection state.

## Architecture

```
Earthling agent ──MCP/stdio──▶ bridge process ──TCP loopback──▶ daemon ──WebSocket :9223──▶ MV3 extension ──chrome.tabs/.scripting/.debugger──▶ user's tabs
                  (one per                                       (singleton,                   ("Earthling Browser Bridge",
                  agent session)                                  owns leases)                  loaded into the user's Chrome)
```

Three processes for two reasons:

1. **Multi-agent.** Each agent session spawns its own bridge MCP process. Bridges share one daemon → one extension. Per-tab leases at the daemon layer keep agents from clobbering each other.
2. **Background by default.** The MV3 extension calls `chrome.tabs.create({active:false})` and `chrome.debugger Page.captureScreenshot` — never `tabs.update({active:true})`, never `captureVisibleTab`. The user keeps focus.

The daemon is auto-spawned by the first bridge process that finds the port unbound. Subsequent bridges connect to the existing daemon. **Auth:** the daemon checks every WebSocket upgrade's `Origin` header against `chrome-extension://<id>` (extension ID is pinned by the CRX `key` in `manifest.json`). Browsers set `Origin` from the executing context and JS cannot override it, so web pages cannot impersonate the extension — no user-visible token paste is required.

Runtime files (`daemon.port`, `daemon.log`, `subscribe.token`) live in a standard OS state location regardless of launch mode: `%LOCALAPPDATA%\earthling\browser-automation-mcp\` on Windows, `$XDG_STATE_HOME/earthling/browser-automation-mcp/` (or `~/.local/state/...`) on Linux, `~/Library/Application Support/earthling/browser-automation-mcp/` on macOS. The fallback chain in `resolveRuntimeDir()` (`src/index.ts`) is the contract; `.runtime/` next to the bundle is the last-resort fallback for smoke tests. `$BROWSER_AUTOMATION_MCP_RUNTIME_DIR` overrides the default — used only by tests that need an isolated runtime dir.

### Daemon recovery

The bridge holds the daemon endpoint in memory but lazily re-resolves it on socket close — the next MCP tool call respawns the daemon via the same `daemon.lock`-protected path used at startup. Multiple concurrent bridges that observe the death simultaneously race-share the spawn; exactly one new daemon process results.

Daemon re-exec auto-selects between two modes (`src/daemon/spawn.ts`):

- **Entry on disk** (dev / standalone, `node dist/index.js`): re-exec `process.execPath <entry> --daemon` directly.
- **Entry not on disk** (compiled host mode — source runs from memory, so `process.argv[1]` is synthetic): re-enter via the host dispatcher as `<MCP_HOST_DISPATCHER> run-mcp browser-automation-mcp --daemon`. `MCP_HOST_DISPATCHER` is injected by the host on every spawned MCP child; its absence here is fatal (nothing on disk to re-exec).

Lease state is lost on respawn (it lives only in the dead daemon's memory). Any subsequent tool call on a previously-leased tab returns `lease_required` — the agent re-claims via `browser_switch_tab`, the same recovery path as a forced lease revocation.

In-flight requests at the moment the daemon dies fail fast with `daemon connection lost` rather than hanging. Recovery is otherwise silent — no agent-visible signal beyond a slightly slower first call after death (~100–300 ms of respawn).

### Extension recovery

When the extension service worker sleeps (which MV3 does aggressively after idle), the bridge's first call after the wake races the reconnect. The bridge transparently retries once after ~200ms on `extension not connected` errors. If that retry also fails, the error propagates to the agent with a recovery hint pointing at the engine's reconnect endpoint:

```
POST http://127.0.0.1:42042/api/mcp/browser-automation-mcp/reconnect
```

The same hint covers user-initiated states (extension manually disabled at `chrome://extensions`).

## Tool surface (v1, 20 tools)

All tools prefixed `browser_*`. All action tools default `snapshot:true` (auto-snapshot after) and `wait_for_settle:"dom"` (return only after the page shows a state delta). Action tools operate on the most-recently-leased tab unless `tabId` is given.

**Tabs & sessions** — `list_tabs`, `open_tab`, `close_tab`, `switch_tab`, `release_tab`
**Navigation** — `navigate` (omit `url` to reload), `navigate_back`
**Observation** — `snapshot`, `screenshot`, `console_messages`, `network_requests`
**Interaction** — `click`, `type`, `select_option`, `hover`, `scroll`, `upload`, `press_key`, `evaluate`, `wait_for`

Semantic cross-tab search (`browser_search_tabs`) is intentionally out of v1 — adding it back means bundling Transformers.js + ONNX WASM into the extension, which we'll only do once a real workflow needs it.

### Settle protocol

Action tools take `wait_for_settle` to control how settled the page must be before the call returns:

| value | meaning |
|---|---|
| `"dom"` (default) | Wait for the first DOM mutation, or `settle_timeout` ms |
| `"network"` | Wait for the first network request, or timeout |
| `"selector:<css>"` | Wait until the named CSS selector appears, or timeout |
| `"none"` | Return immediately; no settle wait |

The response payload includes `settled: { via, elapsedMs }` so the agent can reason about which signal fired. This is what prevents the "click looked like a no-op so I fired it again" failure mode (the original Issue #1 cause of a real Suno double-submit).

### Ref registry

Refs returned by `browser_snapshot` are tracked per bridge session in a `lastSnapshotRefs` map. Targeting an unknown or stale ref fails fast at the bridge layer with an actionable error message — naming nearby refs by numeric proximity if the snapshot is fresh, or explaining the staleness if the agent has fired actions since the last snapshot. Action tools flip the registry to stale after firing; the auto-snapshot that follows flips it back to fresh.

### Network filters and pagination

`browser_network_requests` accepts `urlPattern`, `type`, `methodIn`, `statusGte`, `statusLt` filters. The `type` filter defaults to `["xmlhttprequest","fetch","document"]` for API-discovery use cases — pass `type: ["image","script","stylesheet","document","xmlhttprequest","fetch"]` to include everything.

Both `browser_network_requests` and `browser_console_messages` support cursor pagination. Each entry carries a per-tab monotonic `seq`; pass the response's `next_cursor` back to page through older entries. The extension buffers the last 500 network entries per tab.

## Snapshot model

`browser_snapshot` returns a pruned accessibility tree with sequential numeric `ref` IDs. Action tools target elements by `ref` from the most recent snapshot. The pruner (`src/snapshot/prune.ts`) is a port of `windows-native-mcp`'s tree scorer + data-collapse pass:

- **Score-and-rank** by area, named-ness, viewport bounds, depth, navigation-role bonus, form-field-in-form boost, and modal-subtree boost.
- **Cap at `limit`** (default 500) with reserved slots for nav-role items (tab/menuitem/treeitem) AND for form-field roles inside a `<form>` ancestor — so a deep listbox can't crowd out the page's primary interactive form.
- **Cookie-banner collapse** — OneTrust / Cookiebot / Quantcast-style consent banners (position:fixed + name matching `/cookie|consent|gdpr|privacy preference/i`) collapse to a single placeholder node. The agent can still dismiss it by clicking the placeholder.
- **Sidebar penalty** — lists with ≥8 same-role children get `-10 per sibling above 6` (capped at -80). Off-axis items (outside the central horizontal third) get an additional -20.
- **Data-collapse** for `listitem`/`row`/`treeitem` parents with ≥2 text-only children — they emit a `values: [...]` array instead of nested children, cutting context 40–60% on data-heavy pages.
- **Full-mode floor** — `detail:"full"` at `limit < 1000` raises the effective limit to 1000 and surfaces `meta.limit_adjusted` in the response. Below the floor, depth-first traversal returns nothing but generic ancestor divs.
- **A11y-hidden filtering** — subtrees with `aria-hidden="true"` or `inert` are pruned entirely.

## Lease model

```
A: browser_open_tab https://example.com   → lease auto-claimed by A
B: browser_list_tabs                       → sees A's lease on the tab
B: browser_switch_tab tabId=42             → error: tab_leased by A
B: browser_switch_tab tabId=42 force=true reason="needed for urgent task"
                                           → claim succeeds; A gets a lease_revoked notification
```

`browser_release_tab` (no `tabId`) releases all of this session's leases — fastest way to hand over.

`browser_list_tabs` annotates each tab's `leasedBy` with `byCurrentSession: boolean` so the agent doesn't have to parse the `agentLabel` string to know which leases belong to it.

`browser_switch_tab` and `browser_open_tab` both return `previousActiveTab: { id, title, url } | null` — the user's foreground tab at the moment of the call. This is purely informational (we never activate the new tab); it lets the agent reason about whether their work is currently visible to the user.

`browser_open_tab` also returns `navigated: boolean` plus the actually-loaded URL/title — so the agent can detect when a `/c/<chat-id>` URL was caught by a SPA root and dropped to the index.

## Response envelope

Tool responses are lean single-line JSON. List-style tools (`browser_list_tabs`, `browser_console_messages`, `browser_network_requests`) wrap their results as `{ count, items, ... }` so the agent doesn't have to count the array itself. Errors carry structured fields (`error`, `leasedBy`, `since`, `hint`, `recovery`, `kind`) — null/undefined keys are stripped.

## Repo layout

```
src/
├── index.ts              # entry — dispatches --daemon vs bridge mode
├── protocol.ts           # wire types shared by daemon, bridge, extension
├── test-exports.ts       # subset re-exported for the test harness only
├── daemon/
│   ├── server.ts         # WebSocket + bridge TCP server, command router
│   ├── spawn.ts          # race-safe daemon spawn (shared by startup + recovery)
│   └── leases.ts         # TabLeaseManager
├── bridge/
│   ├── mcp.ts            # stdio MCP server entry
│   ├── client.ts         # daemon client over loopback (with single-shot extension-disconnect retry)
│   ├── registry.ts       # tool registration + per-session ref registry + settle plumbing + envelope
│   ├── session.ts        # per-bridge session state + lastSnapshotRefs
│   └── tools/
│       ├── tabs.ts       # 5 tab/lease tools
│       ├── observe.ts    # 4 observation tools
│       └── interact.ts   # 11 action tools (auto-snapshot + auto-settle wrapped)
└── snapshot/
    └── prune.ts          # a11y tree pruner

earthling-extension/
├── manifest.json         # MV3, CRX key pinned for stable ID
├── background.js         # service worker — WS client, chrome.* glue, settle observers, screenshot resize
├── inject/helpers.js     # in-page a11y walker + interaction primitives (versioned)
└── status.html / .js     # options page (live daemon-connection probe)

scripts/
├── build.js              # esbuild → dist/index.js + dist/test-exports.mjs
└── tests/*.test.mjs      # node --test against test-exports.mjs
```

## Development

```bash
npm install
npm run build              # esbuild → dist/index.js + dist/test-exports.mjs
npm run dev                # esbuild watch mode (main bundle only)
npm test                   # node --test scripts/tests/*.test.mjs
```

The bundle is launched as an MCP (`node dist/index.js` standalone, or compiled into and run in memory by a host binary). The daemon spawns lazily from the first bridge process; see [Daemon recovery](#daemon-recovery) for how re-exec adapts to each launch mode.

See [CLAUDE.md](./CLAUDE.md) for design principles, key invariants, and conventions to follow when modifying this package.

## License

MIT. Most of the codebase is from-scratch; the in-DOM accessibility walker (`earthling-extension/inject/helpers.js`) is conceptually based on `hangwin/mcp-chrome`'s `accessibility-tree-helper.js` (MIT).
