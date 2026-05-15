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

## Tool surface (v1, 20 tools)

All tools prefixed `browser_*`. All action tools default `snapshot:true` (auto-snapshot after) and operate on the most-recently-leased tab unless `tabId` is given.

**Tabs & sessions** — `list_tabs`, `open_tab`, `close_tab`, `switch_tab`, `release_tab`
**Navigation** — `navigate`, `navigate_back`
**Observation** — `snapshot`, `screenshot`, `console_messages`, `network_requests`
**Interaction** — `click`, `type`, `select_option`, `hover`, `scroll`, `upload`, `press_key`, `evaluate`, `wait_for`

Semantic cross-tab search (`browser_search_tabs`) is intentionally out of v1 — adding it back means bundling Transformers.js + ONNX WASM into the extension, which we'll only do once a real workflow needs it.

## Snapshot model

`browser_snapshot` returns a pruned accessibility tree with sequential numeric `ref` IDs. Action tools target elements by `ref` from the most recent snapshot. The pruner (`src/snapshot/prune.ts`) is a port of `windows-native-mcp`'s tree scorer + data-collapse pass:

- **Score-and-rank** by area, named-ness, viewport bounds, depth, and navigation-role bonus.
- **Cap at `limit`** (default 500) with reserved slots for nav-role items (tab/menuitem/treeitem) so a deep listbox can't crowd them out.
- **Data-collapse** for `listitem`/`row`/`treeitem` parents with ≥2 text-only children — they emit a `values: [...]` array instead of nested children, cutting context 40–60% on data-heavy pages.

## Lease model

```
A: browser_open_tab https://example.com   → lease auto-claimed by A
B: browser_list_tabs                       → sees A's lease on the tab
B: browser_switch_tab tabId=42             → error: tab_leased by A
B: browser_switch_tab tabId=42 force=true reason="needed for urgent task"
                                           → claim succeeds; A gets a lease_revoked notification
```

`browser_release_tab` (no `tabId`) releases all of this session's leases — fastest way to hand over.

## Repo layout

```
src/
├── index.ts              # entry — dispatches --daemon vs bridge mode
├── protocol.ts           # wire types shared by daemon, bridge, extension
├── daemon/
│   ├── server.ts         # WebSocket + bridge TCP server, command router
│   └── leases.ts         # TabLeaseManager
├── bridge/
│   ├── mcp.ts            # stdio MCP server entry
│   ├── client.ts         # daemon client over loopback
│   ├── registry.ts       # tool registration + auto-snapshot wrapper
│   ├── session.ts        # per-bridge session state
│   └── tools/
│       ├── tabs.ts       # 5 tab/lease tools
│       ├── observe.ts    # 4 observation tools
│       └── interact.ts   # 10 action tools (auto-snapshot wrapped)
└── snapshot/
    └── prune.ts          # a11y tree pruner

earthling-extension/
├── manifest.json         # MV3, CRX key pinned for stable ID
├── background.js         # service worker — WebSocket client, chrome.* glue
├── inject/helpers.js     # in-page a11y walker + interaction primitives
└── status.html / .js     # options page (live daemon-connection probe)
```

## Development

```bash
npm install
npm run build              # esbuild → dist/index.js
npm run dev                # esbuild watch mode
```

The bundle is launched as a stdio MCP (`node dist/index.js`). The daemon spawns lazily from the first bridge process.

## License

MIT. Most of the codebase is from-scratch; the in-DOM accessibility walker (`earthling-extension/inject/helpers.js`) is conceptually based on `hangwin/mcp-chrome`'s `accessibility-tree-helper.js` (MIT).
