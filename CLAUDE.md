# CLAUDE.md (browser-automation-mcp)

Browser automation MCP server powered by Playwright. Provides structured accessibility-tree-based page interaction for AI agents without requiring vision models. Forked from Microsoft Playwright MCP. Update this file when conventions or design principles change. Update `README.md` when the codebase changes. See `README.md` for tools, parameters, architecture, and setup.

## Design Principles

### Agent-First Tool Design

This server is consumed by AI agents, not humans. Every design decision flows from that:

- **Accessibility tree over screenshots.** `browser_snapshot` returns a structured accessibility tree that agents can parse and act on directly. Screenshots exist as a fallback (`browser_take_screenshot`) but the snapshot is the primary observation mechanism. The snapshot description itself says "this is better than screenshot."
- **Structured data for LLM consumption.** All tool responses return text-based structured data (accessibility trees, console logs, network request lists) rather than images. No vision model needed for the core workflow.
- **Ref-based element targeting.** Elements are referenced by `ref` values from the snapshot, not by fragile CSS selectors or coordinates. The `elementSchema` pattern (`ref` + optional `selector` fallback + human-readable `element` description) is used consistently across all interaction tools.
- **Deterministic tool execution.** Tools use Playwright's built-in waiting and auto-retry (via `waitForCompletion`) rather than arbitrary timeouts. Actions wait for navigation and network idle before returning.
- **Auto-snapshot after mutations.** Action tools call `response.setIncludeSnapshot()` to automatically return an updated page snapshot, so the agent always sees the result of its action without a separate snapshot call.
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
9. **Extension is passive** — the extension never proactively activates tabs or steals user focus. `_connectTab` takes an `activateTab` parameter (default `false`). Only user-initiated connections pass `true`.
10. **Smart reconnect on SW restart** — `_handleExtensionConnection` queries the reconnected extension for surviving tabs before deciding to flush client state. SW restart (tabs alive) skips flush; browser restart (tabs dead) flushes.
11. **Transparent backend reconnect** — `BrowserBackend` holds a `reconnectFactory` closure (captured in `program.ts` at `create()`). `callTool` checks `browser.isConnected()` pre-dispatch and regex-detects disconnect-shaped tool errors (`/Target.*closed|Connection closed|browser has been closed|Session closed|No debugger attached/i`). On detection: dispose stale context → invoke factory with 3-attempt exponential backoff (1s, 2s) → rebuild Context with same config + sessionLog → retry tool call once. Concurrent disconnect observations are coalesced via `_reconnectInFlight`. The MCP SDK never sees a dispose from a transient WS death. **Daemon cooperates by force-closing client WSs on terminal extension loss** — `ClientConnection.onExtensionLost` calls `drainAndClose` after sending `Target.detachedFromTarget` frames, so Playwright's `Browser.isConnected()` flips to false immediately and the pre-dispatch path (not the tool-error regex) triggers the next reconnect. This is the elegant path vs. letting tools fail on disposed-page state.
12. **CDP session id routing is three-way** — `sendToExtensionForClient` resolves session ids via virtual id (`_virtualSession.get`) → real child session id (`_extSession.get`) → fallback. `attachToTab` returns `sessionId: undefined` for page-level attachment (the debuggee IS the page session — no child page target exists); iframe/worker child sessions ARE captured via `Target.setAutoAttach({flatten:true})` and stored in `_tabChildSessions` for sub-frame targeting.
13. **Auto-connect on SW startup** — extension kicks off `_startAutoConnect()` immediately on service-worker startup (no connect.html, no user-clicked tab required). Daemon launches Chrome to `about:blank`; the extension's SW auto-connects via `/discover`. The connect.html UI was removed during the April 18 cleanup.

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

- **`.runtime/debug/daemon.jsonl`** — written by the daemon (`cdpRelay.ts`). Extension WS open/close, per-client connect/disconnect, tab lease ops, `cdp.out` commands, `cdp.response.{in,delivered,orphan}`, session routing (with `resolvedVia: 'virtual'|'real'|'unknown'|'none'`), grace timer events.
- **`.runtime/debug/extension.jsonl`** — written by the daemon on behalf of the extension. Extension SW posts batches (50 entries or 500ms) to daemon's `/debug/extension` endpoint; flushes on `chrome.runtime.onSuspend`. Logs: `autoConnect.*`, `debuggee.attach/detach`, `debugger.event.sessionCaptured`, `tab.switch/close/focus`, `ws.relay.*`.
- **`.runtime/debug/mcp.jsonl`** — written by each MCP process. Logs: `mcp.connectOverCDP.{start,success,fail}`, `mcp.browser.disconnected`, `mcp.backend.{create,disposed}`, `mcp.backend.reconnect.{start,success,fail}`. Append-only; multiple MCP processes share the file safely.

Correlate a single tool call across all three files by filtering on `clientId` (`mcp-<pid>`) or `tabId`.

## Testing

- **Concurrent multi-client smoke test:** `npm run smoke-concurrent` (or `npx tsx scripts/concurrent-smoke.ts`). Spawns the daemon, opens two independent `chromium.connectOverCDP` connections with distinct clientIds, drives each through parallel navigate + evaluate loops, and asserts no URL cross-contamination. `ITERATIONS=N` overrides iteration count; `BROWSER_CHANNEL=chrome` / `msedge` selects the browser channel (defaults to `msedge`).

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

