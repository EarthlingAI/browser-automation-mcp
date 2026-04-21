# CLAUDE.md (browser-automation-mcp)

Browser automation MCP server powered by Playwright. Provides structured accessibility-tree-based page interaction for AI agents without requiring vision models. Forked from Microsoft Playwright MCP. Update this file when conventions or design principles change. Update `README.md` when the codebase changes. See `README.md` for tools, parameters, architecture, and setup.

## Design Principles

### Agent-First Tool Design

This server is consumed by AI agents, not humans. Every design decision flows from that:

- **Accessibility tree over screenshots.** `browser_snapshot` returns a structured accessibility tree that agents can parse and act on directly. Screenshots exist as a fallback (`browser_take_screenshot`) but the snapshot is the primary observation mechanism. The snapshot description itself says "this is better than screenshot."
- **Structured data for LLM consumption.** All tool responses return text-based structured data (accessibility trees, console logs, network request lists) rather than images. No vision model needed for the core workflow.
- **Ref-based element targeting.** Elements are referenced by `ref` values from the snapshot, not by fragile CSS selectors or coordinates. The `elementSchema` pattern (`ref` + optional `selector` fallback + human-readable `element` description) is used consistently across all interaction tools.
- **Deterministic tool execution.** Tools use Playwright's built-in waiting and auto-retry (via `waitForCompletion`) rather than arbitrary timeouts. Actions wait for navigation and network idle before returning. Every action tool is additionally wrapped in a 30s `withActionBudget` (60s for `browser_fill_form` since it iterates N fields); on budget expiry the tool throws a snapshot-retry hint instead of hanging. Underneath, Playwright's `ProgressController.run` clamps every operation's deadline to a 120s hard ceiling — even callers that pass `timeout=0` ("infinite") get bounded. `tab.actionTimeoutOptions.timeout` and `navigationTimeoutOptions.timeout` default to 30s when config is unset.
- **Opportunistic auto-snapshot after mutations.** Action tools call `response.setIncludeSnapshot()` to automatically return an updated page snapshot. The snapshot is **best-effort**: it races against a 3s budget (`SNAPSHOT_TIMEOUT_MS` in `response.ts`), and if the page is wedged the tool still returns its primary result with a visible `[snapshot unavailable — page unresponsive, call browser_snapshot to retry]` marker. Inline snapshots larger than 100KB are auto-saved under `.playwright-mcp/snapshots/` and replaced with a pointer. Per-iframe snapshot capture is also capped at 5s (`IFRAME_SNAPSHOT_TIMEOUT_MS` in `page.ts`) — one wedged iframe becomes an inline marker, not a hung response.
- **Modal state enforcement.** The `defineTabTool` wrapper enforces that dialog/file-upload modals must be cleared before other tools can be used, and that clearing tools can only run when the modal is present. This prevents agents from getting stuck on invisible modal states.
- **Capability-gated tool exposure.** Tools declare a `capability` (core, vision, network, storage, testing, devtools, pdf) and only tools matching the configured capabilities are exposed. `core*` capabilities are always included.

## Architecture

```
src/
├── tools/
│   ├── backend/           # Tool definitions and browser interaction logic (one file per tool group)
│   ├── mcp/               # MCP server wiring (config, browser factory, connection, CDP relay daemon)
│   └── utils/             # Shared MCP server utilities
├── skill/                 # Skill definitions for agent workflows
packages/
├── playwright-mcp/        # Published npm package (@playwright/mcp) + tests
├── extension/             # Chrome extension build output
earthling-extension/       # Earthling Browser Bridge extension source
scripts/                   # Build tooling (esbuild)
```

The tool layer (`backend/`) is pure Playwright logic with no MCP awareness. The MCP layer (`mcp/`) wires tools to the MCP SDK server. `earthlingTabs.ts` in `backend/` is the only Earthling-custom addition — it communicates with the browser extension through the CDP relay daemon via pseudo-CDP commands (`Earthling.*`). The extension tracks multiple simultaneous debugger attachments via a `_debuggees` Map, and the daemon routes browser-level CDP commands locally while forwarding only tab-scoped commands to the extension.

The **CDP relay is a standalone singleton daemon** (`mcp/relay/daemon.ts`, built to `dist/relay-daemon.js`), not an in-process component. MCP processes are clients: the first one to need it lazy-spawns the daemon (TCP bind race on `127.0.0.1:9223`, no lockfile); subsequent MCP processes connect as additional clients. The daemon multiplexes one browser extension to N MCP clients with per-client CDP `sessionId`/command-`id` rewriting and per-tab leasing, so multiple agents can drive different tabs concurrently. Lifecycle: daemon exits 60s after the extension disconnects (grace covers MV3 service-worker sleep). Runtime state in `.runtime/` (PID, secret, logs — gitignored).

## Key Invariants

1. **Two tool definition patterns:** `defineTool` for context-level tools (navigate, tabs, wait, close) and `defineTabTool` for tab-scoped tools that require an active page. `defineTabTool` auto-enforces modal state checks.
2. **`ref` is the primary element identifier** — `selector` is a fallback. The `filteredTools` function in `tools.ts` strips `selector`/`startSelector`/`endSelector` from exposed schemas to steer agents toward ref-based targeting.
3. **`skillOnly: true` tools are hidden from MCP** — they exist in the codebase but are filtered out by `filteredTools` for normal MCP usage. Only exposed in skill mode.
4. **Response always includes code** — every tool handler calls `response.addCode()` with equivalent Playwright code, enabling test code generation alongside execution.
5. **Extension tools bypass `ensureTab()`** — `earthlingTabs.ts` tools communicate directly with the extension WebSocket, not through Playwright pages. They must not call `context.ensureTab()`.
6. **The relay is a singleton daemon; MCP processes are clients.** Never re-introduce in-process relay bindings — an MCP process must not bind `9223` itself. All extension communication goes through the shared daemon over `/cdp/<uuid>`. Per-tab leasing is enforced at the daemon; clients request/release via `browser_switch_tab` (with optional `force`) and `browser_release_tab`.
7. **Browser-level vs tab-level CDP routing** — the daemon's `_handleMessage` handles all top-level CDP commands (no `sessionId`) locally or returns `{}`. Only tab-scoped commands (with a virtual `sessionId`) are forwarded to the extension via `sendToExtensionForClient`. The extension's `chrome.debugger` is tab-scoped and cannot service browser-level commands like `Target.setDiscoverTargets`.
8. **Dispose→reconnect for tab switch is intentional** — Playwright's CRPage↔CDPSession binding is immutable without invasive internals patches. `browser_switch_tab` disposes the backend via `response.setClose()` and the next tool call creates a fresh backend via `connectOverCDP`. This pattern is architecturally correct for tab switching; bugs from side effects are fixed at the daemon/extension layers. (Elimination was investigated and deferred — see `memory/topic/browser-mcp-tab-switch-fixes.md`.)
9. **Extension is passive** — the extension never activates tabs, steals user focus, mirrors URLs, renders per-tab badges, or tracks a single "connected" tab. The singleton (`_connectedTabId` / `_preSelectedTabId` / `_setConnectedTabId` / `_hotSwapTab` / `_onActionClicked` / `bridgeState` persistence) is deleted. `_connectTab` no longer takes an `activateTab` parameter and never calls `chrome.tabs.update({active:true})` / `chrome.windows.update({focused:true})`. User focus is owned exclusively by the user; per-tab ownership is tracked only at the daemon lease layer. The Chrome action icon is click-noop; block/unblock context menus are the only user surface.
10. **Smart reconnect on SW restart** — `_handleExtensionConnection` queries the reconnected extension for surviving tabs before deciding to flush client state. SW restart (tabs alive) skips flush; browser restart (tabs dead) flushes.
11. **Transparent backend reconnect** — `BrowserBackend` holds a `reconnectFactory` closure (captured in `program.ts` at `create()`). `callTool` checks `browser.isConnected()` pre-dispatch and regex-detects disconnect-shaped tool errors (`/Target.*closed|Connection closed|browser has been closed|Session closed|No debugger attached/i`). On detection: dispose stale context → invoke factory with 3-attempt exponential backoff (1s, 2s) → rebuild Context with same config + sessionLog → retry tool call once. Concurrent disconnect observations are coalesced via `_reconnectInFlight`. The MCP SDK never sees a dispose from a transient WS death. **Daemon cooperates by force-closing client WSs on terminal extension loss** — `ClientConnection.onExtensionLost` calls `drainAndClose` after sending `Target.detachedFromTarget` frames, so Playwright's `Browser.isConnected()` flips to false immediately and the pre-dispatch path (not the tool-error regex) triggers the next reconnect. This is the elegant path vs. letting tools fail on disposed-page state.
12. **CDP session id routing is three-way** — `sendToExtensionForClient` resolves session ids via virtual id (`_virtualSession.get`) → real child session id (`_extSession.get`) → fallback. `attachToTab` returns `sessionId: undefined` for page-level attachment (the debuggee IS the page session — no child page target exists); iframe/worker child sessions ARE captured via `Target.setAutoAttach({flatten:true})` and stored in `_tabChildSessions` for sub-frame targeting. On `_handleSetAutoAttach` the priority chain is hint (`_lastSwitchedTab`) + hint visible in `listTabs()` → hint present but missing from `listTabs()` retried via direct extension `attachToTab` (closes the `switch_tab` target-creation race where a stale `listTabs()` snapshot mid-navigation caused the client to silently land on a freshly-spawned `about:blank`) → auto-open blank tab; the old priorities based on first-connected / first-free-non-internal are gone, so `browser_list_all_tabs` no longer silently claims a tab as a side effect. The direct-attach / fallback-to-blank transitions are logged as `session.autoAttach.hint.directAttach` / `session.autoAttach.hint.missed` / `session.autoAttach.hint.fallbackBlank` in `daemon.jsonl`.
13. **Auto-connect on SW startup** — extension kicks off `_startAutoConnect()` immediately on service-worker startup (no connect.html, no user-clicked tab required). Daemon launches Chrome to `about:blank`; the extension's SW auto-connects via `/discover`. The connect.html UI was removed during the April 18 cleanup.
14. **Force-switch is atomic via two-phase commit.** `LeaseTable._pendingByTab` holds reservations during `Earthling.switchToTab`; `ownerOf()` and `all()` deliberately hide pending state so a third client polling `browser_list_all_tabs` never observes the contested tab as `[free]` mid-transition. Flow: `reservePending(tabId, newOwner, oldOwner)` → extension `switchToTab` call (5s timeout via `ExtensionConnection.send`) → `commitPending` on success (atomic swap of `_byTab[tabId]`, release of old owner + old primary) OR `cancelPending` on failure. `PENDING_EXPIRY_MS = 10_000` guards against extension flake; expiry is swept lazily on the next `reservePending` for the same tab. The daemon handler returns `{claimed, released, revokedFrom, force}` to surface the full transition.
15. **CDP detach on release.** `ClientConnection.releaseTabWithDetach(tabId)` bundles lease release + `_cleanupTabSessions` + best-effort `extension.send('detachFromTab', {tabId}, 2_000)`. Called by `Earthling.releaseTab` and by the client-WS close path (`ws.on('close')` iterates `releaseAllFor` and detaches each released tab). Prevents orphan debugger attachments from surviving past the client that opened them. Response shape is `{released, detached}`.
16. **Preemption is announced, not silent.** Before the force-switch commit revokes the loser's subscription, the daemon sends `Earthling.tabPreempted` (params: `{tabId, revokedBy, reason: 'force-switch'}`) on the loser's CDP WS. On the backend side, `Context` opens a persistent `browser.newBrowserCDPSession()` inside `_initializeBrowserContext` and listens for `Earthling.tabPreempted`, pushing a human-readable line onto `_pendingEvents`. `Response._build` drains the buffer into the `Events` section of the loser's next tool response. CDP session is detached on `Context.dispose`.
17. **Every await on the teardown path is bounded.** Adding a new await to `Context.dispose()` / `BrowserBackend.dispose()` / `program.ts` `disposed` callbacks / `Response.serialize()` without a bounded wrapper is a regression. Concrete budgets: `safeDetach` 500ms (CDPSession detach), `safeTitle` (no deadline; defuses mid-navigation `Execution context was destroyed` rejections from `page.title()` during serialization by falling back to cached title → URL → `<navigating>`), `DISPOSE_BUDGET_MS` 5s (server-level `disposeBackend`), `CLOSE_BUDGET_MS` 3s (`browser.close()` in disposed callbacks), `safeWriteFile` 10s (response-path fs writes), `MAX_TOOL_WAIT_MS` 120s (outermost `response.serialize()` guard). Root cause the original teardown hang eliminated: `browser.newBrowserCDPSession()` sessions can have their target swapped out during Phase-3 atomic tab switch, leaving `detach()` to await an invalidated handshake indefinitely — `.catch(() => {})` only traps rejections, not never-settling promises.

## Conventions

- **2-space indentation** for upstream code, **tabs** for Earthling-custom files (`earthlingTabs.ts`)
- **TypeScript strict mode**, target ES2022, Node16 module resolution
- **Zod schemas** for all tool input validation (imported via `mcpBundle.ts`)
- **One file per tool group** in `backend/` — each exports a default array of `Tool` objects
- **`defineTool`/`defineTabTool` helpers** for all tool definitions — never construct `Tool` objects directly
- **Tool schema fields:** `name` (snake_case with `browser_` prefix), `title`, `description`, `inputSchema`, `type` (input/action/readOnly/assertion)
- **Capability annotation** on every tool — determines visibility based on server config
- **Apache 2.0 license header** on all upstream files

## Debug Logging

Three structured JSONL files in `.runtime/debug/` (gitignored) — shared schema (`ts`, `layer`, `event`, optional `clientId`, `tabId`, `virtualSessionId`, `realSessionId`, `detail`). Helpers in `src/tools/mcp/relay/debugJsonl.ts` (`daemonJsonl()`, `mcpJsonl()`, `appendExtensionJsonl()`) write fire-and-forget.

- **`.runtime/debug/daemon.jsonl`** — written by the daemon (`cdpRelay.ts`). Extension WS open/close, per-client connect/disconnect, tab lease ops, `cdp.out` commands, `cdp.response.{in,delivered,orphan}`, session routing (with `resolvedVia: 'virtual'|'real'|'unknown'|'none'`), grace timer events. Phase 2/3 additions: `lease.pending.reserve`, `lease.pending.commit`, `lease.pending.cancel` (two-phase force-switch); `lease.takeover.notified` (preemption event emitted to loser); `ext.detach.on-release` (CDP debugger detach following lease release or client-WS close). Production-readiness additions: `session.autoAttach.hint.{directAttach,missed,fallbackBlank}` diagnose the three-step hint chain in `_handleSetAutoAttach`; the same events also bump lossy aggregate counters exposed via `GET /health` under `telemetry.{hint_direct_attach,hint_missed,hint_fallback_blank}`. `POST /telemetry/bump?counter=serialize_retry_timeout` lets MCP clients aggregate the cross-process `response.serialize.retry` fallback count into the same `/health.telemetry` block.
- **`.runtime/debug/extension.jsonl`** — written by the daemon on behalf of the extension. Extension SW posts batches (50 entries or 500ms) to daemon's `/debug/extension` endpoint; flushes on `chrome.runtime.onSuspend`. Logs: `autoConnect.*`, `debuggee.attach/detach`, `debugger.event.sessionCaptured`, `tab.switch/close/focus`, `ws.relay.*`, and `tab.userActivated` (observation-only — the extension does not react to tab activation beyond refreshing block/unblock context-menu state).
- **`.runtime/debug/mcp.jsonl`** — written by each MCP process. Logs: `mcp.connectOverCDP.{start,success,fail}`, `mcp.browser.disconnected`, `mcp.backend.{create,disposed}`, `mcp.backend.reconnect.{start,success,fail}`. Append-only; multiple MCP processes share the file safely.

Correlate a single tool call across all three files by filtering on `clientId` (`mcp-<pid>`) or `tabId`.

## Testing

- **Chrome-only unit + integration suite:** `npm run ctest` (in `packages/playwright-mcp/`). Phase 2/3 additions under `packages/playwright-mcp/tests/`:
  - `action-budget.spec.ts` — pathological-click page asserts `browser_click` rejects within ~30s with the budget-exceeded hint; verifies Phase A hard ceiling + Phase B 30s wrapper.
  - `lease-atomic.spec.ts` — three-client force-switch atomicity: a polling client never observes the contested tab as `[free]` mid-transition.
  - `preemption-events.spec.ts` — loser's next tool response contains the `Earthling.tabPreempted` event string in its `Events` section.
  - `release-detaches-cdp.spec.ts` — after `browser_release_tab` (and after an abrupt client-WS close), the released tab has no lingering debugger attachment.
  - `auto-attach-pure-read.spec.ts` — `browser_list_all_tabs` is a pure read; no tab silently acquires a `[leased-by-you]` flag from listing.
  - `no-singleton-badge.spec.ts` — `listBrowserTabs` no longer emits `CONNECTED`/`HIGHLIGHTED` strings; `chrome.action` badge text stays empty.
  - `no-focus-theft.spec.ts` — `browser_open_tab` + `browser_switch_tab` leave the user's active tab unchanged.
  - `safe-title.spec.ts` / `title-race.spec.ts` — `safeTitle` unit coverage + integration race asserting `Earthling.listTabsAnnotated` never throws when a peer tab is mid-navigation (defuses the `page.title()` "Execution context was destroyed" serializer hang).
  - `rapid-switch.spec.ts` — `browser_open_tab(url=X) + browser_switch_tab` lands the lease on the requested target, not a racing `about:blank` (three-step `_handleSetAutoAttach` hint chain).
  - `pending-buffer-cap.spec.ts` — `Context._pendingEvents` caps at 50, oldest drops on overflow, `drainPendingEvents` prepends a `… N earlier events dropped` sentinel on the next drain.
  - `hint-fallback-telemetry.spec.ts` — `GET /health` exposes the `telemetry` block (hint-outcome + serialize-retry counters + `clients_1s_high_water`) and counters advance monotonically across a client connect/disconnect cycle.
- **Concurrent multi-client smoke test:** `npm run smoke-concurrent` (or `npx tsx scripts/concurrent-smoke.ts`). Spawns the daemon, opens two independent `chromium.connectOverCDP` connections with distinct clientIds, drives each through parallel navigate + evaluate loops, and asserts no URL cross-contamination. `ITERATIONS=N` overrides iteration count; `BROWSER_CHANNEL=chrome` / `msedge` selects the browser channel (defaults to `msedge`). `MODE=lease-churn npm run smoke-concurrent` drives two clients through 30 iterations of interleaved list → switch → list → release and asserts the lease table is self-consistent (no `[free]` during a committed ownership transition).

Legacy logs still present:
- **Daemon text log** (`.runtime/relay-daemon.log`) via `debug` module, `pw:mcp:relay` namespace. Mostly redundant with `daemon.jsonl`.
- **Extension ring buffer** — 200-entry in-memory buffer (`_debugRingBuffer`) in `background.js`. Query via `Earthling.getDebugLog` pseudo-CDP command for in-flight entries not yet flushed to `extension.jsonl`.
- **Response timing** — `response.ts` logs `captureSnapshot` start/completion with duration via `requestDebug`.

## Extending the Server

1. Create `src/tools/backend/{name}.ts`
2. Import `defineTool` or `defineTabTool` from `./tool` and `z` from `../../mcpBundle`
3. Define tools with the standard schema shape: `name`, `title`, `description`, `inputSchema`, `type`
4. Set `capability` to an appropriate `ToolCapability` value
5. Export a default array of tool objects
6. Import and spread into `browserTools` in `src/tools/backend/tools.ts`
7. Run `npm run build` to bundle
8. Add tests in `packages/playwright-mcp/tests/`
9. Update `README.md` tool table

