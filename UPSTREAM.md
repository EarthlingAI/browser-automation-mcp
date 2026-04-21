# Upstream Source

- **Source:** microsoft/playwright @ commit `ef45dd4be704a2f161c63fcf0dedbf2b6913d823`
- **Version:** 1.59.0-alpha-1773608981000
- **Date:** 2026-04-10
- **Files:** `packages/playwright-core/src/` → `src/`
- **Third-party:** `packages/playwright-core/bundles/*/src/third_party/` → `src/third_party/`

## Sync Procedure

1. Clone upstream at a newer commit
2. Diff `packages/playwright-core/src/tools/` against our `src/tools/`
3. Apply upstream changes selectively (avoid overwriting Earthling modifications)
4. Update this file with the new commit hash and date

## Earthling divergence from upstream Playwright internals

The following files under `src/server/` carry Earthling-specific patches on top of vendored Playwright code. Re-apply these on any upstream sync.

- `src/server/page.ts` — `snapshotFrameForAI()`:
  - Per-iframe 5s timeout around `snapshotFrameRefForAI` (replaces the unbounded `Promise.all`). A timed-out iframe becomes an inline `[iframe ref=… unavailable: …]` marker instead of blocking the whole snapshot.
  - Inner progress steps (`frame._utilityContext()`, `context.injectedScript()`, `injectedScript.evaluate(...)`) race against `frame._detachedScope` via `LongStandingScope.raceMultiple` so a frame detaching mid-snapshot rejects promptly.
- `src/server/frames.ts` — `retryWithProgressAndTimeouts()`:
  - Hard `MAX_RETRY_ATTEMPTS = 20` cap. Bounds the `while (true)` loop when the outer `ProgressController` deadline is 0 (debug mode).
- `src/server/progress.ts` — `ProgressController.run()` (Phase 2+3, `zesty-meandering-island`):
  - `HARD_CEILING_MS = 120_000` clamp. `timeout && timeout > 0 ? min(timeout, 120s) : 120s`. The `if (deadline)` guard around timer setup is removed since `deadline` is now always truthy. Error message uses the effective timeout (the clamped value) so agents see the real deadline that fired.
  - Rationale: MCP tool calls must complete in bounded time — the upstream "0 means infinite" contract is incompatible with agent tool-call semantics, and Phase 1 only fixed the snapshot path. This closes the action-tool hang vector (Finding #15) at the Playwright layer, retroactively protecting every `locator.click` / `locator.fill` / `page.goto` etc.

## Earthling-only code outside `src/server/`

Not part of the upstream sync surface, but documented here for completeness:

- `src/tools/backend/utils.ts` — `withActionBudget(label, fn, budgetMs = 30_000)` helper. Applied in `snapshot.ts` / `keyboard.ts` / `files.ts` / `mouse.ts` / `form.ts` around `tab.waitForCompletion(...)`. `form.ts` uses a 60s budget because it iterates N fields. Defence-in-depth on top of the `ProgressController` hard ceiling — throws a snapshot-retry hint on expiry.
- `src/tools/backend/tab.ts` — `actionTimeoutOptions.timeout` / `navigationTimeoutOptions.timeout` default to 30s when the caller's config leaves them unset.
- `earthling-extension/background.js` (Phase 2) — single-focus singleton model deleted. No `_connectedTabId` / `_preSelectedTabId` / `_setConnectedTabId` / `_hotSwapTab` / `_onActionClicked` / `bridgeState` persistence / per-tab badges / URL mirror / pending-tab-activation timers / `highlighted:` / `connected:` fields on `listBrowserTabs`. The extension never activates tabs or changes window focus; block/unblock context menus are the only user-facing surface. File shrunk 990 → 723 lines.
- `src/tools/mcp/relay/leases.ts` (Phase 3) — `_pendingByTab` map + `reservePending` / `commitPending` / `cancelPending` helpers. `ownerOf()` and `all()` deliberately hide pending state so readers see atomic transitions. `PENDING_EXPIRY_MS = 10_000`, swept lazily on the next `reservePending` for the same tab.
- `src/tools/mcp/relay/cdpRelay.ts` (Phase 3) — `_handleSetAutoAttach` priority chain collapsed to hint → auto-open-blank (priorities 2 + 3 deleted). `ClientConnection.releaseTabWithDetach` bundles lease release + `_cleanupTabSessions` + `extension.send('detachFromTab', ..., 2_000)`; invoked from `Earthling.releaseTab` and from the client-WS `close` path. `Earthling.switchToTab` rewritten as three-phase reserve → extension call → commit, sending `Earthling.tabPreempted` to the loser before the revoke detach.
- `src/tools/backend/context.ts` + `response.ts` (Phase 3) — `Context` opens a persistent browser-CDP session for `Earthling.tabPreempted` events; `addPendingEvent` / `drainPendingEvents` feed human-readable lines into the `Events` section of the next tool response.

Rationale: `outputs/issue-reports/2026-04-21_browser-automation-mcp-stress-test.md` + Phase 1 plan + `~/.claude/plans/zesty-meandering-island.md` (Phase 2+3).

## Teardown reliability

Driven by a real hang observed during Phase 2+3 E2E: `browser_switch_tab` completed daemon-side but the MCP tool call never returned. Root cause was `await this._preemptionCdp?.detach().catch(() => {})` inside `Context.dispose()` — the browser-level CDP session's underlying target was swapped out during the Phase-3 atomic tab switch, so Playwright-core awaited an invalidated handshake that neither resolved nor rejected. `.catch(() => {})` catches rejections, not never-settling promises; an unbounded await on any external resource during teardown can therefore lock the tool response downstream.

Fix is layered budgets rather than a single chokepoint, so a future regression of the same shape cannot refreeze an agent:

- **Inner (`safeDetach`, 500ms)** in `src/tools/backend/utils.ts` — races `cdp.detach()` against a timer. Used by `Context.dispose` (fire-and-forget after nulling `_preemptionCdp`) and `earthlingTabs.ts::relaySend` finally-block. We chose fire-and-forget over await-with-timeout in `Context.dispose` because once the backend is being disposed and the MCP server has dropped its reference, the underlying `connectOverCDP` WS closes on drop and kills child CDP sessions regardless of whether their `detach()` ever settled — awaiting adds risk without function.
- **Middle (`DISPOSE_BUDGET_MS` 5s, `CLOSE_BUDGET_MS` 3s)** in `src/tools/utils/mcp/server.ts` and `src/tools/mcp/program.ts` — wrap `backendManager.disposeBackend` and the `disposed`-callback `browser.close()` calls. On timeout we log and continue; the backend may leak but the tool response is always unblocked.
- **Outer (`safeWriteFile` 10s, `withTimeoutMarker` `MAX_TOOL_WAIT_MS` 120s)** in `src/tools/backend/response.ts` and `src/tools/backend/browserBackend.ts` — bound every fs write on the response-build path and the entire `response.serialize()` call. The 120s outer guard is defensive — it should never fire in practice, but it makes "the MCP tool call ALWAYS returns within 120s" a structural invariant rather than a hope.

A `browser.on('disconnected')` listener in `_initializeBrowserContext` eagerly nulls `_preemptionCdp` on extension-lost / browser-killed paths where the client WS actually closes — covers the adjacent failure class even though the `switch_tab` path does not trigger disconnect.

**Follow-up (2026-04-22):** Phase F Terra E2E confirmed the primary goal (no more `switch_tab` hangs). Two orthogonal bugs were found and fixed in the same layer:

- **`page.title()` serializer race.** During navigation, `page.title()` throws "Execution context was destroyed" synchronously; the raw rejection poisoned the whole tool response for ~25s of subsequent calls. Introduced `safeTitle(page, cachedTitle)` in `utils.ts` and wired through `tab.ts::headerSnapshot`. Fallback chain: cached title → `page.url()` → `'<navigating>'`. Listed as an additional helper under invariant #17.
- **`switch_tab` target-creation race.** `_handleSetAutoAttach` fell back to opening a fresh `about:blank` whenever a hint tab was absent from `listTabs()`, even when `listTabs()` returned a stale snapshot mid-navigation. Added a Priority-2 direct extension `attachToTab` step that recovers the hint tab before falling through to the blank fallback. Diagnostics surfaced via `session.autoAttach.hint.directAttach` / `session.autoAttach.hint.missed` / `session.autoAttach.hint.fallbackBlank` JSONL entries.
