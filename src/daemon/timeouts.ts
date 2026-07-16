/**
 * Daemon-side watchdog inference for outgoing extension RPCs.
 *
 * The daemon owns a per-request watchdog timer over every command it dispatches
 * to the MV3 extension. The base 30s default is a safety net that catches a
 * wedged `chrome.debugger` attach or a hung CDP call on the slower commands
 * (page loads, screenshots, user-supplied evaluate expressions).
 *
 * Synthetic-event action kinds (`click`/`type`/`hover`/`scroll`/`press_key`/
 * `select_option`/`drag`/`drop`/`resolve_ref`) complete in milliseconds plus
 * the wrapper's settle (default 1.5s); they get a tighter 10s budget so a
 * wedged action surfaces as `extension_timeout` in ~10s instead of 30s. This
 * complements the page-side safe-default `Page.handleJavaScriptDialog` auto-
 * answer for native dialogs (invariant #35) — even if an edge case slips past
 * it, the agent only waits 10s for an action to give up rather than 30s.
 *
 * `wait_for` is the slow exception in the other direction — the agent-facing
 * schema advertises a max timeout of 5 minutes, and the extension's
 * `runWaitForCondition` polls until that deadline before returning a polite
 * "predicate did not become truthy" response. So `wait_for` gets a
 * command-aware budget: the caller's `timeout` plus a 5s buffer for WS framing
 * and JSON round-trip on a saturated service worker.
 *
 * Lives in its own module so `test-exports.ts` can re-export the pure function
 * without dragging the WS/TCP boot code from `server.ts` into the test bundle.
 */

import type { ExtCommand } from "../protocol";

const DEFAULT_TIMEOUT_MS = 30_000;
const FAST_ACTION_TIMEOUT_MS = 10_000;
const WAIT_FOR_BUFFER_MS = 5_000;
/**
 * Mirrors the extension's own default at `runWaitForCondition` in
 * `browser-extension/background.js`. Defensive — the bridge schema always
 * sets `timeout` for `wait_for`, but the daemon shouldn't assume.
 */
const WAIT_FOR_DEFAULT_MS = 10_000;

/**
 * Synthetic-event action kinds that should complete in milliseconds plus the
 * wrapper's settle. A 10s budget is plenty (settle defaults to 1.5s, leaving
 * ~8.5s for the action proper) and bounds the worst-case agent wait if the
 * safe-default dialog dismiss (#35) ever misses an edge case. Kept narrow —
 * `evaluate` stays on the 30s default because the agent supplies the
 * expression and may include long awaits; `upload` stays on 30s because the
 * 25 MB file payload + base64 round-trip can take seconds on a saturated SW;
 * `navigate` family stays on 30s for slow first-load pages.
 */
const FAST_ACTION_KINDS = new Set<ExtCommand["kind"]>([
  "click",
  "click_xy",
  "draw",
  "type",
  "select_option",
  "hover",
  "scroll",
  "press_key",
  "drag",
  "drop",
  "resolve_ref",
]);

export function inferExtTimeout(command: ExtCommand): number {
  if (command.kind === "wait_for") {
    return (command.timeout ?? WAIT_FOR_DEFAULT_MS) + WAIT_FOR_BUFFER_MS;
  }
  // `evaluate` with an explicit positive timeout: widen the daemon watchdog to
  // match the in-page deadline (+buffer) so the watchdog never fires before CDP
  // aborts the promise. `timeout:0`/undefined means "no CDP abort" (matching
  // runEvaluate's `timeout > 0` guard) → stays on the 30s default below.
  if (command.kind === "evaluate" && command.timeout && command.timeout > 0) {
    return command.timeout + WAIT_FOR_BUFFER_MS;
  }
  if (FAST_ACTION_KINDS.has(command.kind)) {
    return FAST_ACTION_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}
