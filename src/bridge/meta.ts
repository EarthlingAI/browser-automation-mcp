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
Tabs operate in the background by default — no focus theft, no window raise.

Rendering & focus: backgrounded canvas SPAs (Sheets/Figma/Miro) throttle rendering, so screenshots
and on-screen selection/scroll/menus can look stale even though the page's JS model stays live.
browser_activate_tab sets an ordered visibility level. "render" (default) enables CDP focus-emulation
so a backgrounded tab renders faithfully — still no window raise, no focus theft; it is a
rendering/visibility aid, NOT a precondition for input (synthetic events and ordinary actions reach
the page regardless). "background" drops emulation, returning the tab to natural throttling.
"foreground" is the sole escape hatch that genuinely raises the window and steals focus — reserve it
for OS file pickers, clipboard-paste prompts, drag-drop, and native :focus-gated UI.

Observe-act loop: browser_snapshot returns the pruned a11y tree as a compact indented outline
(payload.tree) — one line per node, two spaces per depth: '- {role} "{name}" [ref={N}]' plus
inline state ([checked]/[selected]/[disabled]/[level=N]), an input's = "value", and a collapsed
row's values: "a", "b". Pass the [ref=N] number to browser_click / browser_type / etc. By default a
snapshot spans the WHOLE page's semantic tree (landmarks + interactive + content, not just the
viewport), ranked by salience and capped at 'limit'. Structured counts live in payload.meta
(total_candidates is always there); if the pruner deferred a ranked tail or auto-scoped a huge page
to the viewport, a 'NOTE: …' recovery hint leads the outline telling you what was hidden and how to
reach it (raise 'limit', scroll, or scope to a region).

Diff snapshots: action tools auto-snapshot after acting, and that auto-snapshot returns a DIFF — only
what changed since the previous snapshot of the tab — led by a 'Δ {A} added, {R} removed, {K} changed'
header, then '+ {node}' / '- {node}' / '~ {node} field: old → new' lines keyed by the stable ref (or
'Δ no changes'). It falls back to the full outline when there's no prior snapshot of the tab or the
page turned over completely. An explicit browser_snapshot is ALWAYS the full tree. payload.meta.mode
('diff' | 'full') tells you which you got; re-call browser_snapshot any time you want the whole tree.

Settle protocol: action tools observe the page for a state delta (DOM mutation, network
request, or named selector) before returning, so a same-tick re-fire is safe to skip. Tune
via the wait_for_settle arg (default "dom"); use "none" for pure-UI nudges, "selector:..."
when you know exactly what should appear.

Forms & viewport: browser_fill_form fills several fields in one call — a {ref, value, kind?}[]
where kind is "type" (textbox, default) / "select_option" (<select>) / "click" (checkbox/radio) —
faster than one action per field. browser_resize sets the tab's viewport (width×height CSS px) via
CDP device-metrics emulation so you can exercise mobile/desktop breakpoints — no window raise; the
override is sticky per tab until the tab closes or the extension reloads.

Drag & drop: browser_drag drags one element (ref) onto another (targetRef) via synthetic
page-side events — mechanism "auto" (default) fires the HTML5 DnD sequence for draggable="true"
sources and a pointer (mouse) sequence otherwise; pass "native"/"pointer" to override if the auto
pick doesn't move the element (HTML5-DnD libraries vs pointer-based ones like react-beautiful-dnd /
SortableJS need different event families). browser_drop drops local files onto a drop-zone ref —
synthesizing a desktop-style file drop (dragenter/dragover/drop with the files in a DataTransfer) —
for "drag files here" zones that expose no <input type=file> for browser_upload. Both are background
synthetic events: no window raise, no focus theft.

Native dialogs: alert / confirm / prompt / beforeunload block the page until answered. The bridge
safe-defaults to AUTO-DISMISS so no tool can block on an unhandled dialog — Page.* is enabled on
every debugger-attached tab and a global listener answers Page.javascriptDialogOpening with
accept:false unless a handler is armed. To accept (or supply prompt text), pre-arm with
browser_handle_dialog BEFORE the action that triggers the dialog — typically right before a
browser_click on a button you know fires a confirm. disposition is "accept" or "dismiss"; pass
promptText with disposition:"accept" for prompt() dialogs; lifetime defaults to "one_shot"
(auto-clears after the next dialog) — pass "sticky" to keep it armed across multiple dialogs (the
debugger stays attached so page-driven dialogs from timers / network / beforeunload also auto-
answer), then clear:true to disarm. Once cleared, the safe-default auto-dismiss takes over.

Ref registry: refs are stable and non-evicting — a ref keeps resolving for as long as its
element stays in the page's DOM, even if a later snapshot dropped it (pruner cap, scrolled out
of view). Acting on a ref whose element was genuinely removed returns an actionable error naming
nearby refs; an unknown (never-snapshotted) ref errors the same way. Most action tools
auto-snapshot, so you rarely manage this by hand.

Lease model: claim a tab with browser_switch_tab (or browser_open_tab auto-claims) before
acting. Multiple agents coexist by holding leases on different tabs. browser_release_tab
hands over. If another agent revoked your lease (or the tab closed), the next action returns
lease_required with a hint — re-claim via browser_switch_tab and continue.

Build: ${BUILD_STAMP}`;
