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
│   ├── mcp/               # MCP server wiring (config, browser factory, connection)
│   └── utils/             # Shared MCP server utilities
├── skill/                 # Skill definitions for agent workflows
packages/
├── playwright-mcp/        # Published npm package (@playwright/mcp) + tests
├── extension/             # Chrome extension build output
earthling-extension/       # Earthling Browser Bridge extension source
scripts/                   # Build tooling (esbuild)
```

The tool layer (`backend/`) is pure Playwright logic with no MCP awareness. The MCP layer (`mcp/`) wires tools to the MCP SDK server. `earthlingTabs.ts` in `backend/` is the only Earthling-custom addition — it communicates with the browser extension via `cdpRelay.ts` for cross-tab automation.

## Key Invariants

1. **Two tool definition patterns:** `defineTool` for context-level tools (navigate, tabs, wait, close) and `defineTabTool` for tab-scoped tools that require an active page. `defineTabTool` auto-enforces modal state checks.
2. **`ref` is the primary element identifier** — `selector` is a fallback. The `filteredTools` function in `tools.ts` strips `selector`/`startSelector`/`endSelector` from exposed schemas to steer agents toward ref-based targeting.
3. **`skillOnly: true` tools are hidden from MCP** — they exist in the codebase but are filtered out by `filteredTools` for normal MCP usage. Only exposed in skill mode.
4. **Response always includes code** — every tool handler calls `response.addCode()` with equivalent Playwright code, enabling test code generation alongside execution.
5. **Extension tools bypass `ensureTab()`** — `earthlingTabs.ts` tools communicate directly with the extension WebSocket, not through Playwright pages. They must not call `context.ensureTab()`.

## Conventions

- **2-space indentation** for upstream code, **tabs** for Earthling-custom files (`earthlingTabs.ts`)
- **TypeScript strict mode**, target ES2022, Node16 module resolution
- **Zod schemas** for all tool input validation (imported via `mcpBundle.ts`)
- **One file per tool group** in `backend/` — each exports a default array of `Tool` objects
- **`defineTool`/`defineTabTool` helpers** for all tool definitions — never construct `Tool` objects directly
- **Tool schema fields:** `name` (snake_case with `browser_` prefix), `title`, `description`, `inputSchema`, `type` (input/action/readOnly/assertion)
- **Capability annotation** on every tool — determines visibility based on server config
- **Apache 2.0 license header** on all upstream files

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

