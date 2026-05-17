/**
 * Daemon-side watchdog inference for outgoing extension RPCs.
 *
 * The daemon owns a per-request watchdog timer over every command it dispatches
 * to the MV3 extension. Most commands resolve in milliseconds; the 30s default
 * is a safety net that catches a wedged `chrome.debugger` attach or a hung CDP
 * call.
 *
 * `wait_for` is the exception — the agent-facing schema advertises a max
 * timeout of 5 minutes, and the extension's `runWaitForCondition` polls until
 * that deadline before returning a polite "predicate did not become truthy"
 * response. A 30s daemon watchdog would cut that short. So `wait_for` gets a
 * command-aware budget: the caller's `timeout` plus a 5s buffer for WS framing
 * and JSON round-trip on a saturated service worker.
 *
 * Lives in its own module so `test-exports.ts` can re-export the pure function
 * without dragging the WS/TCP boot code from `server.ts` into the test bundle.
 */

import type { ExtCommand } from "../protocol";

const DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_FOR_BUFFER_MS = 5_000;
/**
 * Mirrors the extension's own default at `runWaitForCondition` in
 * `browser-extension/background.js`. Defensive — the bridge schema always
 * sets `timeout` for `wait_for`, but the daemon shouldn't assume.
 */
const WAIT_FOR_DEFAULT_MS = 10_000;

export function inferExtTimeout(command: ExtCommand): number {
  if (command.kind === "wait_for") {
    return (command.timeout ?? WAIT_FOR_DEFAULT_MS) + WAIT_FOR_BUFFER_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}
