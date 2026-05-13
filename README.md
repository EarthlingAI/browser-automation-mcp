# browser-automation-mcp

Cross-tab Chrome control for the Earthling agent via a passive MV3 extension. **Never steals focus** — every action runs in the background.

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

Runtime files (`daemon.port`, `daemon.log`, `subscribe.token`) live under `$BROWSER_AUTOMATION_MCP_RUNTIME_DIR` (the engine sets this to `<workspace>/data/mcp/browser-automation-mcp/runtime/`). When the bridge runs outside the engine, the dir resolves to a standard OS state location (`%LOCALAPPDATA%`, `$XDG_STATE_HOME`, `~/Library/Application Support`); `.runtime/` next to the bundle is the last-resort fallback for smoke tests.

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

The engine launches the bundle as `engine run-mcp browser-automation-mcp` (stdio MCP). The daemon spawns lazily from the first bridge process.

## License

MIT. Most of the codebase is from-scratch; the in-DOM accessibility walker (`earthling-extension/inject/helpers.js`) is conceptually based on `hangwin/mcp-chrome`'s `accessibility-tree-helper.js` (MIT).
