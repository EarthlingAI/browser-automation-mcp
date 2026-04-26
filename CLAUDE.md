# CLAUDE.md (browser-automation-mcp)

Browser automation MCP server powered by Playwright. Provides structured accessibility-tree-based page interaction so agents drive the browser through text, not vision.

Update this file when conventions or design principles change. Update `README.md` when the codebase changes (new tools, parameters, files, telemetry counters). See `README.md` for tools, parameters, architecture, setup, telemetry, and tests.

## Design Principles

This server is consumed by AI agents, not humans. Every design decision flows from that:

- **Accessibility tree over screenshots.** `browser_snapshot` returns a structured a11y tree agents can parse and act on directly. Screenshots exist as a fallback (`browser_take_screenshot`) but the snapshot is the primary observation mechanism — its description literally says "this is better than screenshot."
- **Ref-based element targeting.** Elements are referenced by `ref` values from the snapshot, not by fragile CSS selectors or coordinates. The `elementSchema` shape (`ref` + optional `selector` fallback + human-readable `element` description) is consistent across every interaction tool. `filteredTools` strips `selector`/`startSelector`/`endSelector` from exposed schemas to steer agents toward refs.
- **Deterministic execution with bounded budgets.** Tools use Playwright's built-in waiting and auto-retry rather than ad-hoc timeouts. Every action wrapper has a 30s budget (60s for `browser_fill_form`); on expiry, the tool throws a snapshot-retry hint instead of hanging. Underneath, Playwright's `ProgressController.run` clamps every operation to a 120s hard ceiling — even `timeout=0` callers get a deadline. No tool can hang forever.
- **Opportunistic auto-snapshot after mutations.** Action tools call `response.setIncludeSnapshot()` to return an updated snapshot with the action result. The snapshot is **best-effort**: it races a 3s budget and falls back to a `[snapshot unavailable]` marker rather than blocking the response. Inline snapshots over 100KB are spilled to `.playwright-mcp/snapshots/` as a pointer.
- **Modal state enforcement.** `defineTabTool` enforces that dialog/file-upload modals must be cleared before other tools can run, and that clearing tools can only run when the modal is present. Prevents agents from getting stuck on invisible modal states.

For deeper MCP design guidance applied to new servers, consult the `mcp-builder` skill.

## Architecture

```
src/
├── tools/
│   ├── backend/    # Tool definitions and Playwright logic (one file per tool group, no MCP awareness)
│   ├── mcp/        # MCP server wiring (config, browser factory, connection, CDP relay daemon)
│   └── utils/      # Shared MCP server utilities
├── skill/          # Skill definitions for agent workflows
packages/
├── playwright-mcp/ # Published @playwright/mcp package + tests
└── extension/      # Chrome extension build output
earthling-extension/ # Earthling Browser Bridge extension source
scripts/            # Build tooling (esbuild)
```

The tool layer (`backend/`) is pure Playwright with no MCP awareness; `mcp/` wires tools to the MCP SDK. `earthlingTabs.ts` is the only Earthling-custom backend file — it talks to the browser extension through the CDP relay daemon via pseudo-CDP commands (`Earthling.*`), bypassing Playwright pages.

## Key Invariants

These must remain true across all changes:

1. **Two tool definition patterns:** `defineTool` for context-level tools (navigate, tabs, wait, close) and `defineTabTool` for tab-scoped tools that require an active page. Never construct `Tool` objects directly — `defineTabTool` is also where modal-state enforcement lives.
2. **`ref` is the primary element identifier.** `selector` is a fallback. New element-targeting tools must follow the `elementSchema` shape and remain compatible with `filteredTools` selector-stripping.
3. **`skillOnly: true` tools are filtered from MCP exposure** by `filteredTools` in `tools.ts`. They exist in the codebase but are only visible in skill mode.
4. **Every tool handler calls `response.addCode()`** with equivalent Playwright code. This keeps test-code generation in sync with execution — never short-circuit it.
5. **Extension tools bypass `ensureTab()`.** `earthlingTabs.ts` tools communicate directly with the extension via the daemon, not through Playwright pages. They must not call `context.ensureTab()`.
6. **The relay is a singleton daemon; MCP processes are clients.** Never re-introduce in-process relay binding — no MCP process should bind `:9223` itself. All extension communication goes through the shared daemon over `/cdp/<uuid>`. Per-tab leasing is enforced at the daemon; clients request/release via `browser_switch_tab` (with optional `force`) and `browser_release_tab`.
7. **The extension is passive.** Never activates tabs, steals user focus, mirrors URLs, renders per-tab badges, or maintains a "connected tab" singleton. User focus is owned by the user; per-tab ownership is tracked only at the daemon lease layer. The Chrome action icon is click-noop; block/unblock context menus are the only user surface.
8. **Every await on the teardown path is bounded.** Adding an unbounded await to `Context.dispose()` / `BrowserBackend.dispose()` / `program.ts` `disposed` callbacks / `Response.serialize()` is a regression. Concrete budgets:
   - `safeDetach` 500ms (CDPSession detach)
   - `DISPOSE_BUDGET_MS` 5s (server-level `disposeBackend`)
   - `CLOSE_BUDGET_MS` 3s (`browser.close()` in disposed callbacks)
   - `safeWriteFile` 10s (response-path fs writes)
   - `MAX_TOOL_WAIT_MS` 120s (outermost `response.serialize()` guard)
   - `safeTitle` has no deadline but defuses mid-navigation `Execution context was destroyed` rejections from `page.title()` by falling back to cached title → URL → `<navigating>`.

   Root cause the original teardown hang eliminated: `browser.newBrowserCDPSession()` sessions can have their target swapped out during atomic tab switch, leaving `detach()` to await an invalidated handshake indefinitely — `.catch(() => {})` only traps rejections, not never-settling promises.

## Conventions

- **TypeScript strict mode**, target ES2022, Node16 module resolution.
- **Zod schemas** for all tool input validation, imported via `mcpBundle.ts`.
- **One file per tool group** in `backend/`, each exporting a default array of `Tool` objects.
- **`defineTool` / `defineTabTool` helpers** for every tool — never construct `Tool` objects directly.
- **Tool schema fields:** `name` (snake_case with `browser_` prefix), `title`, `description`, `inputSchema`, `type` (`input` / `action` / `readOnly` / `assertion`).
- **`capability`** annotation on every tool — determines visibility based on server config.
- **Apache 2.0 license header** on all upstream files (the fork keeps upstream's licensing intact).

## Extending the Server

1. Create `src/tools/backend/{name}.ts`.
2. Import `defineTool` or `defineTabTool` from `./tool`, and `z` from `../../mcpBundle`.
3. Define tools with the standard schema shape (`name`, `title`, `description`, `inputSchema`, `type`).
4. Set `capability` to an appropriate `ToolCapability` value.
5. Export a default array of tool objects.
6. Import and spread into `browserTools` in `src/tools/backend/tools.ts`.
7. Run `npm run build` to bundle.
8. Add tests in `packages/playwright-mcp/tests/`.
9. Update `README.md`'s tool table.

See `UPSTREAM.md` for the fork delta and Apache 2.0 conventions on upstream-derived files.
