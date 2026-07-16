/**
 * Server-level metadata surfaced to the host agent via MCP `instructions`.
 *
 * `BUILD_STAMP` is replaced at bundle time by esbuild's `define` option
 * (`scripts/build.js`). When the module is consumed without a build step
 * (rare — only direct ts-node-style execution), it falls back to "dev".
 * It is logged to stderr at bridge startup — deliberately NOT included in
 * SERVER_INSTRUCTIONS: hosts inject instructions into the model's system
 * prefix, and a per-build timestamp there would invalidate the host's
 * prompt cache on every rebuild.
 */

declare const __BUILD_STAMP__: string;
export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ === "undefined" ? "dev" : __BUILD_STAMP__;

export const SERVER_INSTRUCTIONS = `Cross-tab control of the user's real Chrome via a passive MV3 extension. Tabs act in the BACKGROUND by default — no window raise, no focus theft; agents coexist by leasing different tabs.

Lease: claim a tab (browser_switch_tab, or browser_open_tab auto-claims) before acting; release when done. A revoked/closed lease makes the next action return lease_required — re-claim and continue.

Observe-act loop: browser_snapshot returns the accessibility tree as indented '- {role} "{name}" [ref=N]' lines; pass a ref to the action tools (browser_click, browser_type, …), which auto-snapshot the change after acting. Each tool's own description carries its mechanics and output grammar — read it before first use.

Reach for the non-obvious surfaces:
• Drive a logged-in site's own API — browser_network_requests finds endpoints; browser_fetch (authenticated, CORS-free HTTP) and browser_cookies (cookies incl. httpOnly) call it. Lease-free.
• An element ignores an ordinary click, or the target is a <canvas>/cross-origin coordinate — escalate to real CDP input: trusted:true, browser_click_xy, browser_draw (costs a debugger infobar).
• A backgrounded canvas SPA (Sheets/Figma) renders stale in a screenshot — browser_activate_tab level:"render" (faithful, no window raise). level:"foreground" is the sole focus-steal, for OS pickers and native :focus gates.
• Canvas spreadsheet/doc data invisible to a snapshot — browser_clipboard moves it in and out.

Responses may carry an 'environment' field when the browser acted around your command — a dialog auto-answered, a popup opened (auto-leased to you), a file chooser intercepted (fulfil via browser_upload). Read it when present.`;
