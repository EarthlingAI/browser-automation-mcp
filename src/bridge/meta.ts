/**
 * Server-level metadata surfaced to the host agent via MCP `instructions`.
 *
 * `BUILD_STAMP` is replaced at bundle time by esbuild's `define` option
 * (`scripts/build.js`). When the module is consumed without a build step
 * (rare — only direct ts-node-style execution), it falls back to "dev".
 */

declare const __BUILD_STAMP__: string;
export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ === "undefined" ? "dev" : __BUILD_STAMP__;

export const SERVER_INSTRUCTIONS = `Cross-tab control of the user's real Chrome session via a passive MV3 extension.
Tabs operate in the background — no focus theft, no window raise.

Observe-act loop: browser_snapshot returns a pruned a11y tree with stable numeric refs.
Use refs in browser_click / browser_type / etc. Action tools auto-snapshot after.

Settle protocol: action tools observe the page for a state delta (DOM mutation, network
request, or named selector) before returning, so a same-tick re-fire is safe to skip. Tune
via the wait_for_settle arg (default "dom"); use "none" for pure-UI nudges, "selector:..."
when you know exactly what should appear.

Ref registry: refs are per-session and tied to the most recent snapshot — calling an action
with an unknown or stale ref returns an actionable error naming nearby refs. Re-snapshot
after the page changes (most action tools auto-snapshot for you).

Lease model: claim a tab with browser_switch_tab (or browser_open_tab auto-claims) before
acting. Multiple agents coexist by holding leases on different tabs. browser_release_tab
hands over. If another agent revoked your lease (or the tab closed), the next action returns
lease_required with a hint — re-claim via browser_switch_tab and continue.

Build: ${BUILD_STAMP}`;
