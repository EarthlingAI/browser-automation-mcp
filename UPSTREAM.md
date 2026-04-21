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

Rationale: `outputs/issue-reports/2026-04-21_browser-automation-mcp-stress-test.md` + Phase 1 plan.
