# CLAUDE.md (browser-automation-mcp)

Cross-tab Chrome control via a passive MV3 extension. 20 tools that drive the user's real authenticated browser without ever raising the window or stealing focus.

Update this file when conventions or design principles change. Update `README.md` when the codebase changes (new tools, parameters, files). See `README.md` for tools, parameters, architecture, and setup.

## Design Principles

### Agent-First Tool Design

This server is consumed by AI agents, not humans. Every design decision flows from that:

- **Optimal defaults for zero-config usage.** Action tools auto-snapshot (`snapshot=true`) and auto-settle (`wait_for_settle="dom"`) so the agent can do `snapshot()` → `click(ref:"5")` with no flags. Screenshots default to JPEG quality 70 so the typical capture stays well inside the token budget.
- **Observe-act loop as the core abstraction.** `browser_snapshot` returns a pruned, numbered a11y tree. Action tools consume `ref` IDs from that snapshot and auto-refresh it afterwards. The agent never manages tree state manually.
- **Settle protocol kills the same-tick double-fire.** An action returns only after the page has shown a state delta — DOM mutation, network request, or named selector. The agent's `wait_for_settle` arg picks the signal. This is what stops the "click looked like a no-op so I fired it again" failure mode.
- **Self-explanatory schemas.** Zod `.describe(...)` strings are the primary documentation agents see. If an agent has to read the README to use a tool correctly, the descriptions have failed.
- **Errors that guide recovery.** Extension-disconnect errors carry an actionable manual-reload hint. Stale-ref errors name nearby refs and tell the agent to re-snapshot. Lease-required errors quote the exact next call to make.
- **Background by default.** Tab creation uses `chrome.tabs.create({active:false})`. Screenshots use `chrome.debugger Page.captureScreenshot`. Tab focus is never stolen from the user — period.

## Architecture

```
browser-automation-mcp/
├── src/
│   ├── index.ts           # Entry — dispatches --daemon vs bridge mode
│   ├── protocol.ts        # Wire types shared by daemon, bridge, extension (incl. snapshot_capture + annotate_image ExtCommand kinds)
│   ├── daemon/            # Singleton daemon — owns leases, brokers daemon↔extension WS
│   ├── bridge/            # One-per-agent MCP server (stdio or streamable-HTTP)
│   │   └── tools/         # One file per tool group (tabs / observe / interact) + shared modules (capture / save / visual / coerce)
│   └── snapshot/          # A11y tree pruner
├── earthling-extension/   # Unpacked MV3 extension — service worker + in-page helpers (also: OffscreenCanvas annotate handler)
└── scripts/               # Build (esbuild) + tests (node --test)
```

`bridge/registry.ts` is the single chokepoint where tool registration, the per-session ref registry, the settle policy, and the lean-JSON envelope (text + optional native MCP image block) all live — new tools never reach for `server.registerTool` directly. `bridge/tools/capture.ts::runUnifiedCapture` is the single source of truth for every "look at the page" call — shared by `browser_snapshot`, `browser_screenshot`, and the auto-snapshot replay path — and emits a two-hop sequence (`snapshot_capture` atomic tree+screenshot, then optional `annotate_image` OffscreenCanvas overlay). The daemon outlives bridges, so lease state survives bridge respawn. The MV3 service worker is wiped on every extension reload — its per-tab Maps come back empty and are rebuilt from `chrome.tabs.query` on each fresh WS connect, pushed daemon-ward via the initial `tab_updated` flurry.

## Conventions

- **2-space indentation** for TypeScript and JavaScript. Intentionally different from windows-native-mcp's tabs — this codebase predates the unification, and a mid-stream reformat would obscure every phase's review history.
- **TypeScript strict mode** — `tsc --noEmit` is part of every build.
- **Zod for schemas.** Use `.describe(...)` only when the parameter name + type aren't self-explanatory. Apply `z.coerce.number()` for numerics, `z.preprocess(coerceToArray, ...)` for arrays, `z.preprocess(coerceBoolean, z.boolean())` for booleans. `z.coerce.boolean()` is forbidden — it truthy-coerces any non-empty string.
- **Modern `server.registerTool` API** — never `server.tool()` (deprecated) or `setRequestHandler(ListToolsRequestSchema)` (raw).
- **All 4 annotations explicit on every tool.** No defaults. Read-only tools must declare `readOnlyHint: true` (planning-phase agent runtimes gate on it).
- **Errors carry structured fields** (`leasedBy`, `since`, `hint`, `recovery`, `kind`) through the daemon → bridge → envelope pipeline. `toolError` strips null/undefined keys cleanly.
- **`console.error` for all logging** — stdout is the MCP protocol stream in stdio mode.
- **No new runtime dependencies.** The bundle dep set is `@modelcontextprotocol/sdk` + `ws` + `zod` + `zod-to-json-schema`. Tests use Node's built-in `--test`. Screenshot resize uses MV3 `OffscreenCanvas` + `createImageBitmap` (no `sharp`).
- **One file per tool group** in `src/bridge/tools/` (tabs / observe / interact). Shared schema helpers live in `coerce.ts`.
- **`helpers.js` is versioned** — bump `HELPERS_VERSION` when changing the in-page contract (new act kind, return-shape change). Re-injection becomes a no-op so the page-side `nodeMap` survives action sequences.

## Adding a New Tool

1. Add the wire type to `src/protocol.ts` under `ExtCommand` (if the daemon → extension hop is new).
2. Implement the in-page side in `earthling-extension/inject/helpers.js` (if it touches the DOM) or the service-worker side in `earthling-extension/background.js` (if it's a `chrome.*` glue call). Bump `HELPERS_VERSION` if you changed the in-page contract.
3. Wire the dispatch case in `background.js::dispatchInner`.
4. If your tool mutates the page, add its kind to `ACTION_KINDS` in `background.js` (drives the "acting" indicator) and `SETTLE_KINDS` (drives the settle observer).
5. Register the bridge-side tool in the appropriate `src/bridge/tools/*.ts` file via `registerTool` (read-only) or `registerActionTool` (auto-snapshot + auto-settle wrapper). Both helpers require `title`, `description`, `annotations` (all 4 hints), `schema` (zod), and `handler`. If the tool returns a screenshot, return the `CaptureResult` shape `{payload, image?}` (or call `runUnifiedCapture` directly) — both wrappers auto-detect this shape and emit a mixed image+text MCP content array.
6. Apply the coerce sweep — every numeric/boolean/array param needs `z.coerce.*` or `z.preprocess(...)` (see Conventions).
7. Add the tool's expected annotation policy to `scripts/tests/annotations.test.mjs`'s `EXPECTED` table. This is the sweep test that prevents annotation drift.
8. Update `README.md` — tool table + the full file tree if you added a file.

## Key Invariants

These must remain true across all changes:

1. **Never activate a tab.** `chrome.tabs.create` always passes `active:!background` (default `background=true`). `chrome.tabs.update({active:true})` is forbidden anywhere in the codebase.
2. **Never raise the browser window.** Screenshots use `chrome.debugger Page.captureScreenshot`. `chrome.tabs.captureVisibleTab` is forbidden — it forces the tab active.
3. **Daemon is singleton, race-safe.** First bridge that finds the port unbound spawns it via `daemon.lock`. Concurrent bridges that observe daemon death simultaneously race-share the next spawn; exactly one new daemon results.
4. **Daemon's WebSocket is Origin-gated.** The only accepted Origin is `chrome-extension://<EARTHLING_EXTENSION_ID>` (CRX `key` in `manifest.json` pins the ID). No user-visible token paste required.
5. **Lease state is per-daemon-process and lost on respawn.** Bridges recover transparently: the next action returns `lease_required` and the agent re-claims via `browser_switch_tab`.
6. **All action tools auto-snapshot by default** (`snapshot=true`). Override only when chaining many actions back-to-back to save round-trips.
7. **All action tools auto-settle by default** (`wait_for_settle="dom"`, `settle_timeout=1500`). Same-tick re-fires return only after the page has shown a delta or after 1.5s, whichever fires first.
8. **Auto-snapshot replays `detail`, `limit`, `viewportOnly`, `tabId`, `screenshot`, `format`, `quality`, `maxWidth` from the last explicit `browser_snapshot` call.** Agents that snapshotted full-mode stay in full-mode on auto-refresh; agents that opted into `screenshot:true` keep getting annotated images per action until they explicitly set `screenshot:false`. `save_to_path` is NEVER replayed — saving is a per-call opt-in, never a session mode (avoids silent disk fill-up over long sessions).
9. **All 4 tool annotation hints are declared explicitly.** Read-only tools must declare `readOnlyHint:true` (planning-phase agent runtimes gate on it); write tools must never claim it. The full policy table lives in `scripts/tests/annotations.test.mjs` and is sweep-tested on every CI run.
10. **The per-session ref registry is the source of truth for `ref` validation.** `execOnLeasedTab` calls `resolveRef` BEFORE the daemon hop — bad refs fail fast with an actionable error naming nearby refs. The registry is populated by every `browser_snapshot` and by `replaySnapshot` (auto-snapshot). Action tools flip `isStale=true` after firing; the next action without a fresh snapshot gets the stale-path error message.
11. **Settle policy is set on `ctx.pendingSettle` by the action-tool wrapper and consumed by the first `execOnLeasedTab` call.** Internal multi-hop handlers do NOT pay the settle cost on every hop — `execOnLeasedTab` clears `pendingSettle` after the first injection.
12. **Cookie-banner subtrees collapse to a single placeholder node in the pruner.** The agent can still dismiss the banner by targeting the placeholder's ref; they just don't have to enumerate the banner's 30 internal buttons.
13. **`detail:"full"` at `limit < 1000` raises the effective limit to 1000** and surfaces `meta.limit_adjusted` in the response. Otherwise full-mode at low limits returns nothing but generic ancestor divs.
14. **`browser_evaluate` returning a primitive (string/number/boolean) is wrapped under `result`** in the response envelope, not spread. Spreading a string produces a char-indexed object (Issue #2 root cause); the wrapper detects primitives and arrays explicitly.
15. **MCP host runtimes stringify typed params on the wire** — `tabId=1594871391` arrives as `"1594871391"`, `force=true` as `"true"`, `methodIn=["POST"]` as `'["POST"]'`. Every numeric/boolean/array schema param goes through coercion (see Conventions). `z.coerce.boolean()` is unusable because it truthy-coerces any non-empty string; use `z.preprocess(coerceBoolean, z.boolean())` instead, and let empty strings fall through so the wrapping `.default(...)` still applies.
16. **Strict-CSP sites require `chrome.debugger Runtime.evaluate`, not `new Function()` in an injected script.** Sites like Suno, ChatGPT, GitHub, and banks set `script-src` without `'unsafe-eval'`, so any in-page evaluation of a string-as-JS via `chrome.scripting.executeScript` + `new Function(...)` is rejected. `browser_wait_for condition` mode is intercepted in `background.js::dispatchInner` and routed through `chrome.debugger Runtime.evaluate` (which runs as the debugger and bypasses CSP). The debugger is attached ONCE around the whole poll loop so the "started debugging this browser" infobar matches the wait duration.
17. **Image annotation runs in the extension's privileged context (OffscreenCanvas in the service worker), never in injected page scripts.** This sidesteps CSP entirely and keeps the annotation contract independent of page-side `script-src` restrictions. The `annotate_image` ExtCommand is stateless — bridge sends bitmap + rects + visual constants, extension returns the overlaid PNG/JPEG.
18. **Visual constants (badge color, font, sizing) live ONE-WAY on the bridge in `src/bridge/tools/visual.ts` and travel inside the `annotate_image` ExtCommand payload.** The extension is a dumb renderer — visual tweaks do NOT require an extension reload. Adding a new badge property means updating `VISUAL_CONSTANTS`, the `annotate_image` payload type in `protocol.ts`, and the extension's annotate handler in lockstep.
19. **Mixed-content envelope ordering: image content block at index 0, text at index 1.** Anthropic vision attends to images that precede related text. The text payload NEVER contains `dataBase64` — the bytes live exclusively in the image block. `toolResult` in `bridge/registry.ts` enforces both rules; `runUnifiedCapture` is the only caller that passes a non-undefined `image` argument.
