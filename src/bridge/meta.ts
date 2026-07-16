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
inline state ([checked]/[selected]/[disabled]/[occluded]/[level=N]), an input's = "value", and a
collapsed table row's values: "a", "b" (empty cells hold their "" slot, so values align with the
header row's values by position; a partial table says '(showing X of Y rows)' on its own line).
[occluded] means another layer covers the element at its centre — it's still in the DOM but likely
not what the user sees. Pass the [ref=N] number to browser_click / browser_type / etc. By default a
snapshot spans the WHOLE page's semantic tree in DOCUMENT ORDER (landmarks + interactive + content +
tables, not just the viewport), losslessly compacted — nothing is ranked, scored, or silently
dropped. When the tree exceeds 'limit' the snapshot first retries scoped to the viewport
(meta.viewport_fallback), then cuts at the limit in document order (meta.truncated names the first
omitted ref); every reduction leads the outline with a 'NOTE: …' naming the recovery levers: raise
'limit', re-snapshot with scope:"<ref>" to drill into one subtree, viewportOnly:true, or
save_tree_to_path:true to write the FULL uncapped outline to a file (its refs are actable like any
other; treeSavedTo carries the path). scope and save_tree_to_path are per-call — they never carry
into auto-snapshots. Structured counts live in payload.meta (total_candidates is always there — the
full page's node count). The snapshot spans SAME-ORIGIN iframes and open shadow DOM automatically (refs inside them work like any other); a CROSS-ORIGIN iframe shows as
a single '- iframe "<url>" [cross-origin frame — not descended]' leaf, and payload.meta.frames lists
every child frame with whether it was descended. To reach inside a cross-origin frame (e.g. a SCORM
course or embedded app hosted on another domain), call browser_snapshot(includeCrossOriginFrames:true):
the leaf is descended and its subtree spliced in with 'fN:localId' refs (e.g. f1:7) that you click/type
like any other ref — the leaf then renders '[cross-origin frame — descended]'. It's opt-in (extra
injection per frame) and replayed on auto-snapshots until you set it false.

Diff snapshots: action tools auto-snapshot after acting, and that auto-snapshot returns a DIFF — only
what changed since the previous snapshot of the tab — led by a 'Δ {A} added, {R} removed, {K} changed'
header, then '+ {node}' / '- {node}' / '~ {node} field: old → new' lines keyed by the stable ref (or
'Δ no changes'). '~ … occluded: false → true' means a layer slid over that element. It falls back to
the full outline when there's no prior snapshot of the tab or the page turned over completely. An
explicit browser_snapshot is ALWAYS the full tree (and a scoped one never disturbs the diff
baseline). payload.meta.mode ('diff' | 'full') tells you which you got; re-call browser_snapshot any
time you want the whole tree.

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

Trusted input: ordinary browser_click / browser_press_key fire page-side SYNTHETIC events (isTrusted
false) — fine for almost everything. When a widget ignores them (a custom switch / signature pad /
media control that gates on event.isTrusted) or there's no usable ref (a coordinate inside a
cross-origin iframe, a <canvas> hit-region), escalate to a REAL CDP input event: browser_click_xy
clicks an (x,y) viewport coordinate, browser_draw traces a freehand pointer stroke through a points
list (signature pads, sliders, pointer-DnD), and browser_click / browser_press_key take trusted:true
(click uses the ref's centre). Coordinates are CSS-pixel viewport coords in the same space as snapshot
rects (top-left origin, pre-scroll) — re-snapshot after scrolling since coords shift; an out-of-viewport
coordinate is rejected with the current viewport size. Cost vs synthetic: it attaches the debugger
(the "started debugging this browser" infobar shows for the lease) and auto-asserts focus-emulation so
the backgrounded tab hit-tests faithfully — still no window raise. Prefer ref-based synthetic actions;
reach for trusted only when synthetic doesn't land.

Clipboard (canvas data apps): a spreadsheet / document / slide grid painted to <canvas> exposes
nothing to browser_snapshot, but the clipboard does. browser_clipboard moves STRUCTURED data across.
Read it out: select in the app (trusted browser_press_key Ctrl+A then Ctrl+C), then browser_clipboard
op:"read" → { text, html } (text is plain/TSV, html the rich flavour). Write it in: browser_clipboard
op:"write" with text (and optional html — e.g. a <table> so a paste lands as multiple cells), then
paste with a trusted browser_press_key Ctrl+V. Reading runs in the extension's own privileged context
(the page is never granted clipboard access) and both ops assert focus-emulation — no window raise. The
OS clipboard is shared with the user: a copy/write overwrites whatever they had on it.

Escalation ladder: when an action won't land, climb ONE rung at a time and no higher than needed —
each rung is more capable but more intrusive. (1) ref-based SYNTHETIC actions (browser_click /
browser_type) — the default, covers almost everything, no debugger; (2) TRUSTED CDP input
(trusted:true, browser_click_xy / browser_draw) — for isTrusted-gated widgets or coordinate/<canvas>
targets with no ref; costs the debugger infobar; (3) EXTENSION-privileged paths (browser_clipboard for
canvas content, includeCrossOriginFrames to reach into another domain's frame) — when the page realm
is blocked but the extension's own context can do it; (4) FOREGROUND (browser_activate_tab
level:"foreground") — the only focus-steal, reserved for native :focus / file-picker / clipboard-paste
gates. If the blocker is the browser CHROME itself — its settings pages, the extension's own UI, an OS
file dialog — that's beyond this server's reach: fall back to OS-level desktop automation or the shell.

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
