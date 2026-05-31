# browser-automation-mcp

Cross-tab control of the user's real authenticated Chrome session via a passive MV3 extension. 25 tools across tabs, observation, and interaction — actions run in the background by default, never raising the window or stealing focus. The one exception is `browser_activate_tab(level:"foreground")`, an explicit opt-in focus-steal for OS file pickers / clipboard / drag-drop; the default `browser_activate_tab(level:"render")` resumes faithful rendering of a backgrounded canvas tab without any window raise.

## Setup

```bash
npm install
npm run build              # esbuild → dist/index.js + dist/test-exports.mjs
```

Wire into the host agent's MCP config:

```jsonc
// .mcp.json (or equivalent MCP client config)
"browser-automation-mcp": {
  "command": "node",
  "args": ["tools/browser-automation-mcp/dist/index.js"]
}
```

### Load the Chrome extension

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `browser-extension/` directory. The extension's options page (`status.html`) shows live daemon-connection state.

If a Reload doesn't take after rebuilding the extension, do a full Remove + Load unpacked — Chrome's Reload button sometimes leaves the MV3 service worker on stale handlers.

### CLI flags

| Flag             | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `--agent <label>` | Human-readable label surfaced in lease records. Useful when multiple agent sessions share one browser. |
| `--daemon`       | Internal — run as the singleton daemon. Bridges spawn this automatically.   |

## Tools

All tools are prefixed `browser_*`. Action tools (any tool that mutates the page) take four extra parameters injected by the action-tool wrapper — listed once below to avoid repetition in every table.

### Auto-snapshot + settle (every action tool)

| Parameter          | Type    | Default | Description                                                                                  |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------------------------- |
| `snapshot`         | boolean | `true`  | Auto-refresh the a11y tree after the action. Set `false` to skip for back-to-back actions.   |
| `delay`            | number  | `0.1`   | Seconds to wait before the auto-snapshot fires. Increase for slow transitions (0.5 menus, 1.0 dialogs, 2.0+ page nav). |
| `wait_for_settle`  | string  | `"dom"` | Settle signal: `"dom"` (first DOM mutation), `"network"` (first request), `"selector:<css>"` (named selector), or `"none"` (return immediately). |
| `settle_timeout`   | int     | `1500`  | Max ms to wait for the settle signal before returning anyway.                                |

### Tabs & sessions

#### `browser_list_tabs` (read-only)

List all open tabs across all browser windows. Returns `id`, `url`, `title`, `leasedBy`. Lease-free.

| Parameter | Type   | Default | Description                                       |
| --------- | ------ | ------- | ------------------------------------------------- |
| `query`   | string | —       | Substring filter on title/URL (case-insensitive). |

#### `browser_open_tab`

Open a URL in a new tab and auto-claim the lease. Defaults to background — never raises the window or activates the tab.

| Parameter    | Type    | Default | Description                                              |
| ------------ | ------- | ------- | -------------------------------------------------------- |
| `url`        | string  | —       | URL to open (validated).                                 |
| `background` | boolean | `true`  | Open without raising the browser window or activating the tab. |

Returns `{ id, url, title, navigated, settledAt, previousActiveTab }` — `navigated:false` signals the SPA dropped the requested URL to its root.

#### `browser_close_tab`

Close a tab by id and release its lease.

| Parameter | Type | Default | Description                       |
| --------- | ---- | ------- | --------------------------------- |
| `tabId`   | int  | —       | Tab id from `browser_list_tabs`.  |

#### `browser_switch_tab`

Claim the lease on an existing tab so this session can act on it. Errors with `leasedBy` if held; pass `force:true` with a `reason` to revoke.

| Parameter | Type    | Default | Description                                              |
| --------- | ------- | ------- | -------------------------------------------------------- |
| `tabId`   | int     | —       | Tab id from `browser_list_tabs`.                         |
| `force`   | boolean | `false` | Revoke another session's lease. Requires `reason`.       |
| `reason`  | string  | —       | Why you are revoking. Required when `force:true`.        |

Returns `{ claimed, previousActiveTab, previousActiveTabError? }` — `previousActiveTab` is explicit `null` when no foreground tab was found.

#### `browser_release_tab`

Release the lease on a tab so another session can claim it. Omit `tabId` to release all leases held by this session.

| Parameter | Type | Default | Description                              |
| --------- | ---- | ------- | ---------------------------------------- |
| `tabId`   | int  | —       | Tab id to release. Omit to release all.  |

### Activation & focus

#### `browser_activate_tab`

One tool for the whole backgrounded-tab visibility spectrum, selected by an ordered `level`:

| `level` | What it does | Window raise / focus theft |
| --- | --- | --- |
| `"background"` | Drop CDP focus-emulation; the tab returns to Chrome's natural background throttling (~0fps `requestAnimationFrame`). | No |
| `"render"` (default) | Enable CDP focus-emulation so Chrome renders the tab as if visible+focused. Backgrounded canvas SPAs (Google Sheets, Figma, Miro) throttle `requestAnimationFrame` to ~0fps, so screenshots and on-screen selection/scroll/menu rendering can look stale even though the page's JS model stays live — this restores faithful rendering. A **rendering/visibility aid, NOT required for input**: synthetic events and ordinary actions reach the page regardless. | No |
| `"foreground"` | Genuinely raise the browser window and activate the tab — **the only level that STEALS the user's focus**. Reserve for focus-dependent flows emulation can't satisfy: OS file pickers, clipboard-paste permission prompts, drag-and-drop, native `:focus`-gated UI. | Yes |

| Parameter | Type | Default     | Description                                                                                       |
| --------- | ---- | ----------- | ------------------------------------------------------------------------------------------------- |
| `level`   | enum | `"render"`  | `"background"` \| `"render"` \| `"foreground"` — ordered visibility spectrum (see table above).   |
| `tabId`   | int  | last leased | Tab id. Omit to use the current leased tab.                                                       |

`"render"`/`"background"` return `{ focusEmulation: boolean }`. Enabling (`"render"`) keeps the debugger warm and re-asserts emulation on each subsequent action, so rendering stays live across an action sequence; `"background"` detaches the debugger promptly, dropping the tab straight back to Chrome's natural background throttling. Because emulation toggles the page's visibility/focus state (and the debugger detaches/re-attaches between actions), pages with visibility/focus-gated logic — analytics beacons, ad-refresh, autoplay-resume — may fire those handlers repeatedly while emulation is held.

`"foreground"` returns `{ broughtToFront, windowId, previousActiveTab }` — `previousActiveTab` (`null` if no foreground tab was found) lets you restore the user's prior tab afterward. Requires a lease on the target tab. Most canvas/rendering needs are met by `"render"` — only escalate to `"foreground"` when a native focus gate truly requires it.

#### `browser_resize`

Resize the leased tab's viewport to `width`×`height` CSS pixels via CDP `Emulation.setDeviceMetricsOverride` — the same debugger-scoped infra as `browser_activate_tab(level:"render")`, so **no window raise and no focus theft**. `window.innerWidth/Height`, media queries, and responsive layout reflect the new size, letting you exercise mobile/tablet/desktop breakpoints. The override is **sticky per tab**: it's re-asserted on every fresh debugger attach (alongside focus-emulation), so it survives the attach/detach churn of an action sequence, and it clears on tab close or extension reload. Disabling focus-emulation (`browser_activate_tab(level:"background")`) detaches the debugger and transiently drops the override until the next debugger-attaching action re-asserts it. Auto-snapshots the reflowed layout.

| Parameter | Type | Default     | Description                          |
| --------- | ---- | ----------- | ------------------------------------ |
| `width`   | int  | —           | Viewport width in CSS pixels (1-16384).  |
| `height`  | int  | —           | Viewport height in CSS pixels (1-16384). |
| `tabId`   | int  | last leased | Tab id. Omit to use the current leased tab. |

Returns `{ resized: { width, height } }`.

#### `browser_handle_dialog`

Pre-arm an auto-response for the leased tab's next native JS dialog (`alert` / `confirm` / `prompt` / `beforeunload`). Native dialogs block the page until answered, so call this **before** the action that triggers one — typically right before a `browser_click` on a button you know fires a `confirm()`.

| Parameter     | Type   | Default      | Description                                                                                              |
| ------------- | ------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `disposition` | enum   | —            | `"accept"` (click OK) or `"dismiss"` (click Cancel). Omit when clearing.                                 |
| `promptText`  | string | —            | Text to enter into a `prompt()` dialog before accepting. Only meaningful with `disposition:"accept"`.    |
| `lifetime`    | enum   | `"one_shot"` | `"one_shot"` auto-clears after the next dialog fires; `"sticky"` persists until you call again with `clear:true`. |
| `clear`       | bool   | `false`      | Disarm any existing handler on this tab. Mutually exclusive with `disposition`.                          |
| `tabId`       | int    | last leased  | Tab id. Omit to use the current leased tab.                                                              |

Returns `{ dialogHandler: { disposition, promptText?, lifetime } }` on arm, `{ dialogHandler: null }` on clear.

**Safe-default DISMISS — no tool can block on a native dialog.** Uses CDP `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog` under the hood — no window raise, no focus theft. `Page.*` is enabled **unconditionally** on every debugger-attached tab (whether the debugger was attached for `handle_dialog`, focus-emulation, viewport override, a screenshot, `evaluate`, or `wait_for`), and a global listener answers every `Page.javascriptDialogOpening`: per the armed disposition when set, or `accept:false` (DISMISS) when not. Without this safe-default, Chrome does NOT auto-dismiss background-tab dialogs while the debugger is attached, so an unhandled `confirm()` / `prompt()` / `beforeunload` would block the page — wedging the next agent call until the daemon's per-command watchdog fired (10 s for synthetic-event actions like `browser_click`, 30 s for slower commands). With it, the only thing `handle_dialog` arming does is **upgrade** the default from "dismiss" to "accept" (or supply `promptText`) for the next (one-shot) or all (sticky) dialogs on the tab.

**Sticky keeps the debugger attached.** A `lifetime:"sticky"` arming keeps the debugger pinned to the tab for the duration (so the "Started debugging this browser" infobar stays visible, like `browser_activate_tab(level:"render")` does) — this is what lets it answer page-driven dialogs from timers, network responses, or `beforeunload`. Without sticky-stay-attached, the debugger's deferred 5 s detach would drop those dialogs onto the safe-default DISMISS, which is the wrong answer for an explicit sticky-accept. A `lifetime:"one_shot"` arming lets the debugger detach after 5 s of idle, on the assumption you armed right before the click that triggers the dialog.

**`clear:true` reverts to the safe-default, not to Chrome's default.** Once cleared, subsequent dialogs are auto-dismissed by the global listener (while the debugger remains attached for any reason). If you need a different disposition mid-session, re-arm rather than relying on Chrome's "natural" background-tab behaviour — the debugger's presence suppresses Chrome's policy, so "natural" is not what you get.

### Observation

#### `browser_snapshot` (read-only)

Pruned accessibility-tree snapshot of the leased tab. Returns nodes with stable numeric `ref` IDs to target in interaction tools. `screenshot` is tri-state:

| `screenshot` | What you get | Use when |
| --- | --- | --- |
| `"off"` (default) | Tree only, no image block | You only need refs and don't need to see the page |
| `"annotated"` | Tree + image with each ref's number badged on its element | Vision-guided action planning (default for "I want to see what I'm doing") |
| `"raw"` | Tree + clean pixels (no badges) | Saving a chart, capturing an artifact, or showing the page as the user sees it |

Once `"annotated"` or `"raw"` is set, every subsequent action's auto-snapshot returns the image in the same mode. Set back to `"off"` to drop back to tree-only.

| Parameter      | Type                                  | Default      | Description                                                              |
| -------------- | ------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `tabId`        | int                                   | last leased  | Tab to snapshot.                                                         |
| `detail`       | enum                                  | `"standard"` | `"standard"` = interactive elements only; `"full"` = entire a11y tree.   |
| `limit`        | int                                   | `1500`       | Max nodes returned. The pruner includes the whole page's semantic tree, ranks by salience, and caps here; a loud `meta.notice` fires if any ranked node was deferred. Range 1-5000. |
| `viewportOnly` | boolean                               | `false`      | Restrict snapshot to the visible viewport. Default `false` — return the whole page's intelligently-pruned tree. Auto-falls-back to viewport-only when the page exceeds `3 × limit` candidates (surfaces `meta.viewport_fallback`). Pass `true` to force viewport-only unconditionally. |
| `screenshot`   | `"off"` \| `"annotated"` \| `"raw"` | `"off"`      | See table above. Replays on auto-snapshot until set back to `"off"`. Costs ~150-250ms per action when `"annotated"`. |
| `quality`      | int                                   | `70`         | JPEG quality (1-100). Ignored for PNG saves. Applies to inline (always JPEG) and to any `.jpg`/`.jpeg` save target. |
| `maxWidth`     | int                                   | —            | Downscale the screenshot to at most this width (preserves aspect ratio). Range 64-4096. |
| `save_to_path` | bool \| string                        | `false`      | Write the image to disk. **String paths drive the image format** (`.png`/`.jpg`/`.jpeg`); inline-only and auto-name use JPEG. See "Save to disk" below. |

`detail:"full"` at `limit < 1000` raises the effective limit to 1000 and surfaces `meta.limit_adjusted` in the response.

**Pruner meta.** Every response includes `meta.total_candidates` (the full count of accessible candidate nodes the pruner saw before any viewport-filtering or limit cap). When the pruner auto-falls-back to viewport-only (`total_candidates > 3 × effectiveLimit` AND the caller did NOT pass `viewportOnly:true`), an additional `meta.viewport_fallback: { active:true, reason:"page_too_large", threshold, total_candidates }` surfaces so the agent knows useful nodes may sit off-screen. Whenever a cap or fallback fires, `meta.notice` carries a one-line recovery hint (what was hidden, how to reach it) that is also inlined as the first line of the serialized outline, prefixed `NOTE: `.

**Auto-snapshot carries the image forward.** Once you call `browser_snapshot(screenshot:"annotated")` or `browser_snapshot(screenshot:"raw")`, every subsequent action-tool auto-snapshot replays the visual params (`screenshot`, `quality`, `maxWidth`) — the agent sees one image per action, not just per explicit snapshot. `save_to_path` is NEVER replayed: saving is per-call opt-in, never a session mode.

**Pixel-accurate badges.** The annotation hop derives canvas-pixel scale from the actual final bitmap dimensions vs. the page's CSS viewport (`scaleX = imgW / cssViewport.w`), so ref badges land on the right elements regardless of browser zoom or device pixel ratio — including the `maxWidth`-resized path.

#### `browser_console_messages` (read-only)

Recent console output from the leased tab (log, warn, error). Supports cursor pagination.

| Parameter | Type   | Default      | Description                                                  |
| --------- | ------ | ------------ | ------------------------------------------------------------ |
| `tabId`   | int    | last leased  | Tab to read from.                                            |
| `limit`   | int    | `50`         | Max entries returned. Range 1-500.                           |
| `cursor`  | string | —            | Opaque cursor from a prior call's `next_cursor`.             |

#### `browser_network_requests` (read-only)

Recent network requests from the leased tab. For unfamiliar SPAs, call this first to discover real backend endpoints from xhr/fetch traffic before guessing endpoint paths.

| Parameter    | Type   | Default                                | Description                                                                                |
| ------------ | ------ | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tabId`      | int    | last leased                            | Tab to read from.                                                                          |
| `limit`      | int    | `50`                                   | Max entries returned. Range 1-500.                                                         |
| `cursor`     | string | —                                      | Opaque cursor from a prior call's `next_cursor`.                                           |
| `urlPattern` | string | —                                      | URL filter. Plain string = substring match. Wrap in `/.../` for regex (e.g. `/\/api\//`).  |
| `type`       | enum[] | `["xmlhttprequest","fetch","document"]` | Resource types: `xmlhttprequest`, `fetch`, `image`, `script`, `document`, `stylesheet`, `other`. |
| `methodIn`   | enum[] | all                                    | HTTP methods: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD`.                  |
| `statusGte`  | int    | —                                      | Include only responses with status >= this.                                                |
| `statusLt`   | int    | —                                      | Include only responses with status < this.                                                 |

### Navigation

#### `browser_navigate`

Navigate the leased tab to a URL. Omit `url` to reload the current page.

| Parameter   | Type   | Default              | Description                                       |
| ----------- | ------ | -------------------- | ------------------------------------------------- |
| `url`       | string | —                    | URL to navigate to. Omit to reload.               |
| `tabId`     | int    | last leased          | Tab to navigate.                                  |
| `waitUntil` | enum   | `"domcontentloaded"` | `"load"` or `"domcontentloaded"`.                 |

#### `browser_navigate_back`

Go back one entry in the leased tab's history.

| Parameter | Type | Default      | Description     |
| --------- | ---- | ------------ | --------------- |
| `tabId`   | int  | last leased  | Tab to act on.  |

### Interaction

#### `browser_click`

Click an element by `ref` from a recent snapshot. Supports modifiers, double/right click.

| Parameter    | Type     | Default  | Description                                              |
| ------------ | -------- | -------- | -------------------------------------------------------- |
| `ref`        | string   | —        | Element ref from `browser_snapshot` (e.g. `"5"`).        |
| `tabId`      | int      | last     | Tab to act on.                                           |
| `button`     | enum     | `"left"` | `"left"`, `"right"`, or `"middle"`.                      |
| `clickCount` | 1 \| 2 \| 3 | `1`     | Single, double, or triple click.                         |
| `modifiers`  | string[] | —        | Keys held during click, e.g. `["Control"]`, `["Shift"]`. |

#### `browser_type`

Type text into a textbox by `ref`. Clears existing value unless `append:true`.

| Parameter | Type    | Default | Description                                       |
| --------- | ------- | ------- | ------------------------------------------------- |
| `ref`     | string  | —       | Element ref from `browser_snapshot`.              |
| `text`    | string  | —       | Text to type.                                     |
| `tabId`   | int     | last    | Tab to act on.                                    |
| `append`  | boolean | `false` | Append instead of clearing first.                 |

#### `browser_select_option`

Select an option in a `<select>` element by value or visible label.

| Parameter | Type   | Default | Description                                |
| --------- | ------ | ------- | ------------------------------------------ |
| `ref`     | string | —       | Element ref to a `<select>`.               |
| `value`   | string | —       | Option value or visible label.             |
| `tabId`   | int    | last    | Tab to act on.                             |

#### `browser_fill_form`

Fill several form fields in one batch — faster than one `browser_type`/`browser_select_option` per field. Each field reuses the single-field actions via `kind`. Fields apply in order, back-to-back with no inter-field settle; a single auto-snapshot after the batch covers the final repaint. Purely bridge-side — it sequences the existing `type`/`select_option`/`click` extension commands, so no extension reload is needed for it.

| Parameter | Type     | Default | Description                                                          |
| --------- | -------- | ------- | -------------------------------------------------------------------- |
| `fields`  | object[] | —       | Fields to fill (1+), applied in order. Each is `{ref, value?, kind?}`. |
| `tabId`   | int      | last    | Tab to act on.                                                       |

Each field object:

| Field   | Type   | Default  | Description                                                                                   |
| ------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| `ref`   | string | —        | Element ref from `browser_snapshot`.                                                          |
| `value` | string | —        | Text for `kind:"type"`, or option value/label for `kind:"select_option"`. Omit for `kind:"click"`. |
| `kind`  | enum   | `"type"` | `"type"` (textbox), `"select_option"` (`<select>`), or `"click"` (checkbox/radio).            |

Returns `{ filled, fields: [{ref, kind, result}, ...] }`. A `"type"`/`"select_option"` field with no `value` is rejected.

#### `browser_hover`

Hover the pointer over an element by `ref`. Useful for revealing hover menus.

| Parameter | Type   | Default | Description           |
| --------- | ------ | ------- | --------------------- |
| `ref`     | string | —       | Element ref to hover. |
| `tabId`   | int    | last    | Tab to act on.        |

#### `browser_scroll`

Scroll the page or a specific scrollable element by deltas (positive = down/right).

| Parameter | Type   | Default | Description                                       |
| --------- | ------ | ------- | ------------------------------------------------- |
| `ref`     | string | —       | Element ref to scroll. Omit to scroll the page.   |
| `tabId`   | int    | last    | Tab to act on.                                    |
| `deltaY`  | number | `400`   | Vertical scroll delta.                            |
| `deltaX`  | number | `0`     | Horizontal scroll delta.                          |

#### `browser_upload`

Upload local files to a file input by `ref`.

| Parameter | Type     | Default | Description                                |
| --------- | -------- | ------- | ------------------------------------------ |
| `ref`     | string   | —       | Element ref to a file input.               |
| `files`   | string[] | —       | Absolute paths to local files (1+).        |
| `tabId`   | int      | last    | Tab to act on.                             |

Max 10 files, 25 MB per file, 50 MB total.

#### `browser_drag`

Drag the source element (`ref`) onto a target element (`targetRef`). All synthetic and page-side — no window raise, no focus theft. `mechanism` picks the event family:

- `"auto"` (default) — inspect the source's `draggable` flag: use `"native"` when set, `"pointer"` otherwise.
- `"native"` — HTML5 drag-and-drop events (`dragstart`→`dragenter`→`dragover`→`drop`→`dragend`) sharing one `DataTransfer`. Drives `draggable="true"` sources: file managers, HTML5-DnD demos, SortableJS default config.
- `"pointer"` — a mouse/pointer press→interpolated-move→release sequence. Drives pointer-based libraries: react-beautiful-dnd, SortableJS `forceFallback`, most kanban boards.

Synthetic events are `isTrusted:false`; if a library gates on trust and neither mechanism moves the element, escalate to `browser_activate_tab(level:"foreground")` for a native gesture. Pass `mechanism` explicitly to override the auto heuristic.

| Parameter   | Type   | Default  | Description                                              |
| ----------- | ------ | -------- | -------------------------------------------------------- |
| `ref`       | string | —        | Source element ref to drag.                              |
| `targetRef` | string | —        | Target element ref to drop onto.                         |
| `mechanism` | enum   | `"auto"` | `"auto"` / `"native"` / `"pointer"` (see above).         |
| `tabId`     | int    | last     | Tab to act on.                                           |

Returns `{ dragged, to, mechanism }` (the resolved mechanism). An unknown `targetRef` is rejected with a nearby-refs error before any action.

#### `browser_drop`

Drop local files onto a drop-zone element by `ref` — synthesizes the HTML5 `dragenter`→`dragover`→`drop` sequence carrying the files in a `DataTransfer`, exactly as a desktop file-drop would. Use for "drag files here" upload zones that expose no `<input type=file>` for `browser_upload` to target.

| Parameter | Type     | Default | Description                          |
| --------- | -------- | ------- | ------------------------------------ |
| `ref`     | string   | —       | Drop-target element ref.             |
| `files`   | string[] | —       | Absolute paths to local files (1+).  |
| `tabId`   | int      | last    | Tab to act on.                       |

Same file limits as `browser_upload` (10 files, 25 MB each, 50 MB total). Returns `{ dropped, ref }`.

#### `browser_press_key`

Press a keyboard shortcut at page level. Key names follow `KeyboardEvent.key`.

| Parameter   | Type     | Default | Description                                            |
| ----------- | -------- | ------- | ------------------------------------------------------ |
| `key`       | string   | —       | e.g. `"Enter"`, `"Tab"`, `"a"`, `"F5"`.                |
| `tabId`     | int      | last    | Tab to act on.                                         |
| `modifiers` | string[] | —       | e.g. `["Control"]`, `["Shift", "Alt"]`.                |

#### `browser_evaluate`

Run a JS expression in the leased tab and return the JSON-serialisable result. Strings come back as strings (not char-indexed objects). For unfamiliar SPAs, call `browser_network_requests` first to discover real backend endpoints.

| Parameter    | Type   | Default | Description                                                                      |
| ------------ | ------ | ------- | -------------------------------------------------------------------------------- |
| `expression` | string | —       | JS expression; the value of the last expression is returned.                     |
| `tabId`      | int    | last    | Tab to act on.                                                                   |

#### `browser_wait_for` (read-only)

Wait for a CSS selector, a JS predicate, network idle, or a timeout. Exactly one of `selector`, `condition`, or `networkIdle:true` must be set.

| Parameter          | Type    | Default | Description                                                                                  |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------------------------- |
| `selector`         | string  | —       | CSS selector to wait for. Pass raw — JSON layer handles escaping.                            |
| `condition`        | string  | —       | JS expression evaluated in-page on a polling loop. Use for state-machine SPAs (data-status, aria-busy, react state). |
| `networkIdle`      | boolean | `false` | Wait until no network activity for 500ms.                                                    |
| `timeout`          | int     | `10000` | Max wait in ms. Range 0-300000 (5 minutes).                                                  |
| `poll_interval_ms` | int     | `250`   | Polling interval for `condition` mode. Range 50-5000.                                        |
| `tabId`            | int     | last    | Tab to act on.                                                                               |

Condition mode runs through `chrome.debugger Runtime.evaluate` to bypass strict-CSP sites' `unsafe-eval` restrictions (Suno, ChatGPT, banks). The daemon's watchdog matches the command's `timeout` (plus a 5 s safety buffer), so the full schema-max of 5 minutes is honoured end-to-end.

## Annotations

| Tool                       | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| -------------------------- | ------------ | --------------- | -------------- | ------------- |
| `browser_list_tabs`        | ✓            | —               | ✓              | ✓             |
| `browser_open_tab`         | —            | —               | —              | ✓             |
| `browser_close_tab`        | —            | ✓               | ✓              | ✓             |
| `browser_switch_tab`       | —            | —               | ✓              | ✓             |
| `browser_release_tab`      | —            | —               | ✓              | ✓             |
| `browser_activate_tab`     | —            | —               | ✓              | ✓             |
| `browser_resize`           | —            | —               | ✓              | ✓             |
| `browser_handle_dialog`    | —            | —               | ✓              | ✓             |
| `browser_snapshot`         | ✓            | —               | ✓              | ✓             |
| `browser_console_messages` | ✓            | —               | ✓              | ✓             |
| `browser_network_requests` | ✓            | —               | ✓              | ✓             |
| `browser_navigate`         | —            | ✓               | —              | ✓             |
| `browser_navigate_back`    | —            | ✓               | —              | ✓             |
| `browser_click`            | —            | ✓               | —              | ✓             |
| `browser_type`             | —            | ✓               | —              | ✓             |
| `browser_select_option`    | —            | ✓               | —              | ✓             |
| `browser_fill_form`        | —            | ✓               | —              | ✓             |
| `browser_hover`            | —            | —               | —              | ✓             |
| `browser_scroll`           | —            | —               | —              | ✓             |
| `browser_upload`           | —            | ✓               | —              | ✓             |
| `browser_drag`             | —            | ✓               | —              | ✓             |
| `browser_drop`             | —            | ✓               | —              | ✓             |
| `browser_press_key`        | —            | ✓               | —              | ✓             |
| `browser_evaluate`         | —            | ✓               | —              | ✓             |
| `browser_wait_for`         | ✓            | —               | ✓              | ✓             |

The full policy is sweep-tested in `scripts/tests/annotations.test.mjs`.

## Architecture

```
AI agent ──MCP/stdio──▶ bridge process ──TCP loopback──▶ daemon ──WebSocket :9223──▶ MV3 extension ──chrome.tabs/.scripting/.debugger──▶ user's tabs
          (one per                                       (singleton,                   ("Browser Automation Bridge",
          agent session)                                  owns leases)                  loaded into user's Chrome)
```

Three processes for two reasons:

1. **Multi-agent.** Each agent session spawns its own bridge MCP process. Bridges share one daemon, which shares one extension. Per-tab leases at the daemon layer keep concurrent agents from clobbering each other.
2. **Background by default.** The MV3 extension uses `chrome.tabs.create({active:false})` and `chrome.debugger Page.captureScreenshot` — never `captureVisibleTab`, and never activates a tab or raises the window EXCEPT the explicit `browser_activate_tab(level:"foreground")` escape hatch (`chrome.windows.update({focused:true})` + `chrome.tabs.update({active:true})`). `browser_activate_tab(level:"render")` resumes faithful rendering via CDP focus-emulation with no window raise. The user keeps focus unless they invoke `browser_activate_tab(level:"foreground")`.

The daemon auto-spawns from the first bridge that finds the port unbound. Authentication uses Origin-header gating: the daemon checks every WebSocket upgrade against `chrome-extension://<id>` (extension ID pinned by the CRX `key` in `manifest.json`). Browsers set `Origin` from the executing context and JS cannot override it — web pages cannot impersonate the extension, no user-visible token paste required.

### File tree

```
browser-automation-mcp/
├── src/
│   ├── index.ts              # Entry — dispatches --daemon vs bridge mode based on argv
│   ├── protocol.ts           # Wire types shared by daemon, bridge, extension (BridgeRequest, ExtCommand, etc.)
│   ├── test-exports.ts       # Re-exports a subset of internals for the test harness only
│   ├── daemon/
│   │   ├── server.ts         # WebSocket + bridge TCP server + command router
│   │   ├── spawn.ts          # Race-safe daemon spawn (shared by startup + recovery)
│   │   ├── leases.ts         # TabLeaseManager — per-tab single-holder claim/release
│   │   └── timeouts.ts       # Pure helper inferring per-command extension-RPC watchdog (wait_for honours its own timeout + 5s; synthetic-event action kinds — click/type/select_option/hover/scroll/press_key/drag/drop/resolve_ref — get a 10s budget; everything else gets 30s)
│   ├── bridge/
│   │   ├── mcp.ts            # MCP server entry (stdio + streamable-HTTP transports)
│   │   ├── meta.ts           # SERVER_INSTRUCTIONS string + BUILD_STAMP (injected by esbuild)
│   │   ├── client.ts         # Daemon client over loopback TCP (single-shot disconnect retry)
│   │   ├── registry.ts       # Tool registration + per-session ref registry + settle plumbing + envelope helpers
│   │   ├── session.ts        # Per-bridge session state (lastSnapshotRefs, lastLeasedTab, isStale)
│   │   └── tools/
│   │       ├── tabs.ts            # 8 tab tools (5 tab/lease + browser_activate_tab + browser_resize + browser_handle_dialog)
│   │       ├── observe.ts         # 3 observation tools (browser_snapshot, console, network)
│   │       ├── interact.ts        # 14 action tools (auto-snapshot + auto-settle wrapped)
│   │       ├── capture.ts         # Unified-capture orchestrator — single source of truth for browser_snapshot and the auto-snapshot replay path
│   │       ├── save.ts            # save_to_path schema + resolver (resolveSavePath, writeImage, getOutputsDir)
│   │       ├── visual.ts          # Annotation visual constants (badge color, font, sizing) — travel inside annotate_image payload
│   │       ├── containment.ts     # computeDrawStroke — containment-based parent-bbox suppression for annotated screenshots
│   │       └── coerce.ts          # Schema-input coercion helpers (coerceToArray, coerceBoolean, coerceLiteralNumber)
│   └── snapshot/
│       ├── prune.ts          # A11y tree pruner — scoring, cookie-collapse, sidebar penalty, data-collapse, full-mode floor
│       ├── serialize.ts      # serializeTree + shared formatNodeFields/formatNodeIdentity — pruned tree → compact indented-text outline (payload.tree)
│       └── diff.ts           # serializeDiff — delta between two pruned trees (added/removed/changed) for the auto-snapshot path
├── browser-extension/
│   ├── manifest.json         # MV3 — CRX key pinned for stable ID, alarms permission for keepalive
│   ├── background.js         # Service worker — WS client, chrome.* glue, settle observers, screenshot resize
│   ├── inject/
│   │   ├── helpers.js        # In-page a11y walker + interaction primitives (versioned via HELPERS_VERSION)
│   │   └── indicator.js      # In-page "agent is acting on this tab" indicator
│   ├── status.html           # Options page — live daemon-connection probe
│   └── status.js             # Probe script for status.html
└── scripts/
    ├── build.js              # esbuild → dist/index.js + dist/test-exports.mjs (injects __BUILD_STAMP__)
    ├── dump-session.js       # Dev helper — dumps the test-exports session state
    ├── harness/
    │   ├── capture-snippet.js     # In-page snippet that captures a raw a11y tree for fixture generation
    │   ├── capture-fixtures.mjs   # Driver — pulls captured trees from a live tab into scripts/harness/fixtures/
    │   └── snapshot-harness.mjs   # Replays fixtures through the pruner + serializer, compares against baseline/
    └── tests/
        ├── annotations.test.mjs       # Sweep test for tool annotation policy
        ├── coerce.test.mjs            # Schema coercion (stringified numbers/booleans/arrays)
        ├── envelope.test.mjs          # toolResult / toolError envelope shape (incl. mixed image+text content)
        ├── evaluate.test.mjs          # browser_evaluate primitive-wrap (Issue #2 regression)
        ├── drag.test.mjs              # browser_drag bridge wiring (single drag ExtCommand, mechanism passthrough, target-ref validation)
        ├── drop.test.mjs              # browser_drop bridge wiring (file-payload read + drop ExtCommand, missing-file rejection)
        ├── handle_dialog.test.mjs     # browser_handle_dialog bridge wiring (arm/clear forwards, default lifetime, xor validation, leased-tab fallback)
        ├── fill_form.test.mjs         # browser_fill_form bridge-side batching (type/select_option/click sequencing, default kind, value validation)
        ├── fingerprint.test.mjs       # Build fingerprint surfaces in SERVER_INSTRUCTIONS
        ├── prune.test.mjs             # Pruner heuristics (cookie collapse, sidebar penalty, full-mode floor, etc.)
        ├── registry.test.mjs          # populateRefs + resolveRef (no-snapshot / fresh-miss / non-evicting / liveness-probe paths)
        ├── replay.test.mjs            # replaySnapshot — visual params replayed; save_to_path never replayed
        ├── resize.test.mjs            # browser_resize bridge wiring (forwards resize ExtCommand, leased-tab fallback)
        ├── serialize.test.mjs         # serializeTree compact-outline grammar (flags, value, values-collapse, escaping, nesting)
        ├── diff.test.mjs              # serializeDiff — added/removed/changed classification + Δ-header grammar + numeric-ref sort
        ├── save.test.mjs              # save_to_path resolver (outputs_dir precedence, traversal rejection, non-fatal errors)
        ├── snapshot-capture.test.mjs  # runUnifiedCapture — snapshot_capture + annotate_image two-hop topology
        ├── containment.test.mjs       # computeDrawStroke — containment-based parent stroke suppression
        ├── timeout.test.mjs           # inferExtTimeout — per-command watchdog inference
        └── visual.test.mjs            # VISUAL_CONSTANTS shape — every key the extension's annotate handler reads
```

## Snapshot model

`browser_snapshot` returns a pruned accessibility tree with stable numeric `ref` IDs (stable across snapshots — see [Ref registry](#ref-registry)). Action tools target elements by `ref`. The pruner (`src/snapshot/prune.ts`) is a port of `windows-native-mcp`'s tree scorer + data-collapse pass:

**Output format (compact indented outline).** The tree ships as text, not nested JSON — `src/snapshot/serialize.ts::serializeTree` renders one line per node, two spaces per depth:

```text
- WebArea "Artificial intelligence - Wikipedia" [ref=1]
  - searchbox "Search Wikipedia" [ref=22]
  - button "Search" [ref=24]
  - checkbox "Subscribe" [ref=31] [checked]
  - textbox "Email" [ref=33] = "a@b.com"
  - row [ref=288] values: "Machine learning", "Symbolic", "Deep learning"
```

Grammar: `{indent}- {role}[ "{name}"][ [ref={N}]][ = "{value}"][ flags…][ values: …]`. State flags render in order `[checked]`/`[mixed]` → `[selected]` → `[disabled]` → `[level=N]`. Names/values are whitespace-collapsed with embedded `"` escaped; the synthetic multi-root sentinel (`ref "0"`) prints no `[ref]` tag. The outline lands in `payload.tree` (string); structured counts go to `payload.meta`. When the pruner caps or falls back, `meta.notice` carries a recovery hint that is also inlined as the outline's first line, prefixed `NOTE: `. Against the harness fixtures this outline is ~25% smaller than the former JSON-tree serialization with zero element loss. The pruner heuristics below decide WHICH nodes appear; the serializer only changes how they're rendered:

- **Keep the whole semantic tree** — `standard` mode admits everything interactive/navigational/data-bearing PLUS any **named** node, including named landmarks/containers (`region`/`main`/`navigation`/`list`/`group` with an aria-label) that wrap and structure the page. Only **unnamed** structural nodes are dropped from `standard`; `detail:"full"` returns the complete tree.
- **Score to ORDER, not to exclude** — area, named-ness, viewport bounds, depth, navigation-role bonus, form-field-in-form boost, and modal-subtree boost rank the candidates. Within budget the score only decides the order siblings appear in — it never silently drops a node.
- **Cap at `limit`** (default 1500 — CP3's compact outline funds the larger tree) with reserved slots for nav-role items (tab/menuitem/treeitem) AND for form-field roles inside a `<form>` ancestor — a deep listbox can't crowd out the primary interactive form. When in-scope candidates overflow the limit, the lowest-ranked tail is **deferred** and `meta.notice` says so (count + how to recover) — never a silent truncation.
- **Cookie-banner collapse** — OneTrust / Cookiebot / Quantcast-style consent banners (`position:fixed` + name matching `/cookie|consent|gdpr|privacy preference/i`) collapse to a single placeholder node. The agent can still dismiss the banner by clicking the placeholder.
- **Sidebar penalty** — lists with ≥8 same-role children get -10 per sibling above 6 (capped at -80). Off-axis items (outside the central horizontal third) get an additional -20.
- **Data-collapse** for `listitem`/`row`/`treeitem` parents with ≥2 text-only children — they emit a `values: [...]` array instead of nested children, cutting context 40-60% on data-heavy pages.
- **Full-mode floor** — `detail:"full"` at `limit < 1000` raises the effective limit to 1000 and surfaces `meta.limit_adjusted` in the response.
- **A11y-hidden filtering** — subtrees with `aria-hidden="true"` or `inert` are pruned entirely.
- **viewportOnly auto-fallback** — `viewportOnly` defaults to `false`, so the pruner ranks across the whole page. When the page exceeds `3 × effectiveLimit` candidates AND `viewportOnly:true` was not passed explicitly, the pruner auto-falls-back to viewport-only and surfaces `meta.viewport_fallback`. `meta.total_candidates` is ALWAYS surfaced so the agent knows how much was available.

**Diff snapshots (auto-snapshot path).** An explicit `browser_snapshot` always returns the full outline above. But after an action, the auto-refresh snapshot returns only **what changed** since the previous snapshot of that tab — refs are stable and non-evicting (see [Ref registry](#ref-registry)), so a ref present in both the prior and new pruned tree is the same element. `src/snapshot/diff.ts::serializeDiff` flattens both trees by ref, classifies each as added / removed / changed, and renders the same node-line grammar with `+`/`-`/`~` markers under a one-line header:

```text
Δ 1 added, 1 removed, 2 changed
+ button "Save" [ref=12]
- link "Cancel" [ref=8]
~ textbox "Email" [ref=5] value: (none) → "a@b.com"
~ checkbox "Subscribe" [ref=31] checked: false → true
```

Added/removed lines carry the node's full fields; a changed line carries the identity lead plus `field: old → new` transitions. An action that moved nothing returns `Δ no changes`. The prior tree is stored per tab (`session.lastPrunedTree`) and refreshed on every snapshot, so each action's diff reflects only that action's delta. The diff falls back to a full outline when there's no prior snapshot of the tab, when the prior is from a different tab (page-side ref ids are per-tab), or when the diff would be larger than the full tree (a full-page navigation turns over every ref). `payload.meta.mode` is `"diff"` or `"full"` so the agent always knows which it received; re-call `browser_snapshot` for the whole tree at any time.

## Settle protocol

Action tools observe the page for a state delta before returning, so same-tick re-fires return only after the page has shown the action took effect. Tune via the `wait_for_settle` arg:

| Value              | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `"dom"` (default)  | Wait for the first DOM mutation, or `settle_timeout` ms          |
| `"network"`        | Wait for the first network request, or timeout                   |
| `"selector:<css>"` | Wait until the named CSS selector appears, or timeout            |
| `"none"`           | Return immediately; no settle wait                               |

Every action response includes `settled: { via, elapsedMs }`. This is what prevents the "click looked like a no-op so I fired it again" failure mode.

## Ref registry

Refs are **stable and non-evicting**. Page-side, a given element keeps ONE id across every walk (a persistent `WeakMap<Element,id>` in `helpers.js` that is never reset per snapshot; the reverse map holds `WeakRef`s so detached nodes stay garbage-collectable). A ref resolves for as long as its element stays attached to the DOM — even if a later snapshot dropped it (pruner cap, scrolled out of view, hidden).

Bridge-side, two structures back this:

- **`lastSnapshotRefs`** — just the latest snapshot's refs (the fast-path "definitely current" set; also the annotation hop's rect source).
- **`refRegistry`** — a cumulative merge of every snapshot of the current tab (reset only when the snapshot tab changes, since page-side ids are per-tab). This is what makes resolution non-evicting and backs the nearby-refs error listing.

`execOnLeasedTab` validates a ref before the action hop: an **unknown** (never-minted) ref fails fast with a nearby-refs error; a **known** ref that isn't freshly-current — carried forward from an earlier snapshot, or any ref after an action flipped `isStale=true` — is confirmed live via a cheap read-only `resolve_ref` probe, so a **genuinely-removed** element returns a "no longer exists" nearby-refs error instead of firing a silent no-op. `isStale` no longer invalidates refs wholesale; it only forces that liveness probe. The auto-snapshot after each action refreshes `lastSnapshotRefs`, so the common case stays on the fast path.

## Lease model

```
A: browser_open_tab https://example.com         → lease auto-claimed by A
B: browser_list_tabs                             → sees A's lease on the tab
B: browser_switch_tab tabId=42                   → error: tab_leased by A
B: browser_switch_tab tabId=42 force=true reason="urgent task"
                                                 → claim succeeds; A's next call gets lease_required
```

`browser_release_tab` (no `tabId`) releases all of this session's leases — fastest way to hand over.

`browser_list_tabs` annotates each tab's `leasedBy` with `byCurrentSession: boolean` so the agent doesn't have to parse the `agentLabel` string.

`browser_switch_tab` and `browser_open_tab` both return `previousActiveTab: { id, title, url } | null` — the user's foreground tab at the moment of the call. Purely informational (we never activate the new tab).

`browser_open_tab` also returns `navigated: boolean` plus the actually-loaded URL/title — so the agent can detect when a `/c/<chat-id>` URL was caught by a SPA root and dropped to the index.

## Recovery

### Daemon recovery

The bridge holds the daemon endpoint in memory but lazily re-resolves it on socket close — the next tool call respawns the daemon via the same `daemon.lock`-protected path used at startup. Concurrent bridges race-share the spawn; exactly one new daemon process results.

`src/daemon/spawn.ts` auto-selects between two re-exec modes:

- **Entry on disk** (dev / standalone, `node dist/index.js`) — re-exec `process.execPath <entry> --daemon` directly.
- **Entry not on disk** (compiled host mode, source runs from memory) — re-enter via the host dispatcher as `<MCP_HOST_DISPATCHER> run-mcp browser-automation-mcp --daemon`. `MCP_HOST_DISPATCHER` is injected by the host on every spawned MCP child; its absence here is fatal.

Lease state lives only in the daemon's memory and is lost on respawn. The next tool call on a previously-leased tab returns `lease_required` — the agent re-claims via `browser_switch_tab`. In-flight requests at the moment the daemon dies fail fast with `daemon connection lost` rather than hanging.

### Extension recovery

The MV3 service worker idle-dies after ~30s of inactivity. A `chrome.alarms` keepalive heartbeat fires every 24s to stay under that threshold — without it the first call after even brief idle would return `extension not connected` even though everything is healthy.

If the SW wakes mid-call, the bridge transparently retries once after ~500 ms on `extension not connected` errors. If the retry also fails, the error propagates with `recovery` and `hint` fields carrying `"extension not connected — reload the Browser Automation Bridge extension at chrome://extensions"`. The same hint covers user-initiated states (extension manually disabled at `chrome://extensions`).

## Response format

Tool responses are lean single-line JSON. List-style tools (`browser_list_tabs`, `browser_console_messages`, `browser_network_requests`) wrap their results as `{ count, items, ... }`. Errors carry structured fields — null/undefined keys are stripped.

**Success (action tool with auto-snapshot):**

```jsonc
{
  "clicked": "5",
  "settled": { "via": "dom", "elapsedMs": 43 },
  // An action's auto-snapshot returns a DIFF of what changed since the prior
  // snapshot (meta.mode "diff") — tree is the compact change outline. An
  // explicit browser_snapshot returns the full tree (meta.mode "full").
  "snapshot": {
    "tree": "Δ 1 added, 0 removed, 1 changed\n+ alert \"Saved\" [ref=40]\n~ textbox \"Email\" [ref=7] value: (none) → \"a@b.com\"",
    "meta": { "total_candidates": 42, "mode": "diff" }
  }
}
```

**Success (list-style tool):**

```json
{
  "count": 20,
  "items": [...],
  "truncated": true,
  "next_cursor": "abc123"
}
```

**Success (primitive from `browser_evaluate`):**

```json
{ "result": "https://example.com/page" }
```

The wrapper detects primitives and arrays and wraps them under `result` rather than spreading (spreading `"abc"` produces `{0:"a",1:"b",2:"c"}`).

### Mixed-content envelope (snapshot + screenshot tools)

When `browser_snapshot(screenshot:"annotated"|"raw")` returns an image (or an action's auto-snapshot does, while screenshot mode is on), the MCP response carries a two-block `content` array: a native MCP image block at index 0, then a JSON text block at index 1. Image-first ordering is deliberate — Anthropic vision attends to images that precede related text. The text block never duplicates the image bytes; the bytes live exclusively in the image block.

```jsonc
{
  "content": [
    { "type": "image", "data": "<base64>", "mimeType": "image/jpeg" },
    { "type": "text", "text": "{\"format\":\"jpeg\",\"resizedTo\":{\"width\":1280,\"height\":720},\"savedTo\":\"...\",\"tree\":\"- WebArea \\\"...\\\" [ref=1]\\n  ...\",\"meta\":{...}}" }
  ]
}
```

Text payload fields when a screenshot is returned:

- `format` — `"jpeg"` or `"png"`.
- `resizedTo` — present only when `maxWidth` downscaled the capture; `{width, height}` in pixels.
- `savedTo` — absolute path written, present when `save_to_path` was set and the write succeeded.
- `saveError` — non-fatal save failure message, present when `save_to_path` was set but the write failed (the image still returns inline).
- `tree` — the pruned a11y tree as a **compact indented-text outline** (a string) on `browser_snapshot`, or a **compact change diff** on the action auto-snapshot. See [Snapshot model](#snapshot-model) for both grammars.
- `meta` — structured pruner metadata (`total_candidates`, `mode` (`"diff"`|`"full"`), optional `viewport_fallback` / `limit_adjusted` / `notice`), split out from the tree.

Action tools follow the same envelope: when an auto-snapshot returns an image (screenshot mode is on), the action's response includes the image block at index 0 and its JSON text (`{clicked, settled, snapshot:{...}}`) at index 1.

### Save to disk (`save_to_path`)

`save_to_path` is available on `browser_snapshot`. Semantics:

- `false` (default) — return inline only, no disk write. Inline format: JPEG.
- `true` — auto-name `<outputs_dir>/screenshot_<tabId>_<unixms>.jpg` → JPEG.
- string ending in `.png` → PNG.
- string ending in `.jpg`/`.jpeg` → JPEG.
- any other extension is rejected at schema-validation time with an actionable error.

Relative string paths resolve under `outputs_dir`; absolute paths are allowed; any `..` segment is rejected with a non-fatal `saveError` (image still returns inline).

**The file extension drives the image format** — there is no separate `format` parameter. This avoids the silent "`.jpg` extension with PNG bytes" mismatch.

`outputs_dir` resolution order:

1. `BROWSER_AUTOMATION_MCP_OUTPUTS_DIR` env var (highest priority).
2. `<BROWSER_AUTOMATION_MCP_RUNTIME_DIR>/outputs/` when the runtime dir env var is set.
3. `<cwd>/outputs/browser/` as the final fallback.

**Deployment tip:** hosts that embed this MCP should set `BROWSER_AUTOMATION_MCP_OUTPUTS_DIR` in their `.mcp.json` `env` block so screenshots land in a host-managed folder rather than under the MCP source tree. Example:

```json
{
  "mcpServers": {
    "browser-automation": {
      "command": "node",
      "args": ["path/to/dist/index.js"],
      "env": {
        "BROWSER_AUTOMATION_MCP_OUTPUTS_DIR": "/path/to/host-project/outputs/browser"
      }
    }
  }
}
```

Save errors are non-fatal — the image still returns inline; the failure surfaces in the text payload as `saveError`. `save_to_path` is NEVER replayed on auto-snapshot, so a one-off save never accidentally fills the disk over a long session.

**Error (lease):**

```json
{
  "error": "tab_leased",
  "leasedBy": "agent-alice",
  "since": "2026-05-16T11:48:23.000Z",
  "hint": "tab 42 is leased by another session; call browser_switch_tab again with force:true and reason:\"…\" to revoke"
}
```

**Error (extension disconnected):**

```json
{
  "error": "extension not connected",
  "kind": "extension_disconnected",
  "recovery": "extension not connected — reload the Browser Automation Bridge extension at chrome://extensions",
  "hint": "extension not connected — reload the Browser Automation Bridge extension at chrome://extensions"
}
```

The hint is a single universal string — the same message covers SW idle-death, user-initiated disable, and any other disconnect state. The bridge's transparent retry handles the cold-wake case; if the retry also fails, the agent surfaces this message and the user reloads the extension at `chrome://extensions`.

## Environment variables

| Variable                              | Default                                                       | Description                                                                                  |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`                       | `stdio`                                                       | `stdio` or `http`. HTTP mode binds a streamable-HTTP server.                                 |
| `MCP_HTTP_HOST`                       | `127.0.0.1`                                                   | Host for HTTP transport.                                                                     |
| `MCP_HTTP_PORT`                       | (required for http)                                           | Port for HTTP transport.                                                                     |
| `BROWSER_AUTOMATION_MCP_RUNTIME_DIR`  | OS state dir (see below)                                      | Override runtime-files location (`daemon.port`, `daemon.log`, `subscribe.token`).            |
| `BROWSER_AUTOMATION_MCP_OUTPUTS_DIR`  | `<runtime_dir>/outputs/` then `<cwd>/outputs/browser/`        | Override where `save_to_path` writes screenshots. Takes priority over the runtime-dir / cwd fallbacks. |
| `BROWSER_AUTOMATION_MCP_RELAY_PORT`   | `9223`                                                        | Override the daemon ↔ extension WebSocket port. **Also update `DAEMON_URL` in `browser-extension/background.js` if you change this** — the unpacked extension cannot read process env vars. |
| `BROWSER_EXTENSION_TAB_GROUP_LABEL`   | `Automation`                                                  | Brand prefix used in the Chrome tab-group title when an agent claims a tab (e.g. `"Acme — Alice"`). Daemon reads at startup and stamps it onto every `IndicatorState`, so the same generic MCP can ship under host-specific branding without forking the extension. |
| `MCP_HOST_DISPATCHER`                 | (injected by host)                                            | Path to the host's MCP dispatcher executable, used for daemon re-exec when the entry isn't on disk. |

Default runtime dir per OS:

- Windows: `%LOCALAPPDATA%\browser-automation-mcp\`
- Linux: `$XDG_STATE_HOME/browser-automation-mcp/` (or `~/.local/state/browser-automation-mcp/`)
- macOS: `~/Library/Application Support/browser-automation-mcp/`

`.runtime/` next to the bundle is a last-resort fallback for smoke tests.

## Tests

```bash
npm test                   # node --test scripts/tests/*.test.mjs
npm run dev                # esbuild watch mode (main bundle only)
```

The test harness imports from `dist/test-exports.mjs`, so run `npm run build` once before `npm test`. Tests cover pruner heuristics (including viewportOnly auto-fallback, total_candidates surfacing, and the Round 7 philosophy flip — named-landmark widening, within-budget no-drop, score-only-reordering, and the loud over-limit `meta.notice`), the ref registry (non-evicting resolution, tab-change reset, and the `resolve_ref` liveness probe in `execOnLeasedTab`), envelope shape (including the mixed image+text content array), schema coercion, build fingerprint, annotation policy, daemon watchdog inference, the `browser_evaluate` primitive-wrap regression, the unified-capture two-hop topology (`snapshot_capture` + `annotate_image`), the tri-state screenshot mode (`"off"` → no image, `"annotated"` → 2 hops, `"raw"` → 1 hop with raw bytes, plus defense-in-depth for `"annotated"` + `withTree:false`), the annotation scale formula (`scaleX = imgW / cssViewport.w`, pixel-accurate across the DPR × maxWidth matrix), `save_to_path` resolution (format-from-extension inference, unknown-extension rejection, outputs_dir precedence, traversal rejection, non-fatal save errors), `replaySnapshot` (visual params replayed; `save_to_path` never replayed), `computeDrawStroke` (containment-based parent-bbox suppression), the visual-constants contract, the compact-outline serializer (`serialize.test.mjs` — grammar shape and content: flags, value, values-collapse, whitespace-collapse, quote-escape, nesting, synthetic-root) and the `meta.notice` inlining (`NOTE:` first line), and the diff serializer (`diff.test.mjs` — added/removed/changed classification, `Δ`-header counts, multi-field transitions, no-changes case, synthetic-root skip, numeric-ref sort) plus its auto-snapshot integration (`replay.test.mjs` — diff on the second snapshot of a tab, full fallback when there's no prior / a cross-tab prior / an oversized diff, and explicit-snapshot-always-full), and the CP6 parity tools (`fill_form.test.mjs` — bridge-side type/select_option/click sequencing, default kind, value validation; `resize.test.mjs` — resize ExtCommand forwarding + leased-tab fallback), and the CP7 drag-and-drop parity tools (`drag.test.mjs` — single `drag` ExtCommand forwarding, mechanism passthrough, target-ref validation; `drop.test.mjs` — file-payload read off disk + `drop` ExtCommand forwarding, missing-file rejection), and the CP8 dialog parity tool (`handle_dialog.test.mjs` — arm forwards a single `handle_dialog` ExtCommand carrying disposition/promptText/lifetime, clear forwards `{clear:true}`, default lifetime is `"one_shot"`, xor validation rejects both/neither before any daemon hop, leased-tab fallback when `tabId` is omitted, sticky-lifetime passthrough, promptText-on-dismiss permissive forwarding), and the CP9 fast-action timeout policy (`timeout.test.mjs` — synthetic-event action kinds — click/type/select_option/hover/scroll/press_key/drag/drop/resolve_ref — get the 10 s budget; navigate/evaluate/upload/snapshot_capture/CDP-glue commands stay on the 30 s default; wait_for still adds the 5 s buffer to the caller timeout) — 153 cases total. All tests run without standing up the daemon or extension; they exercise pure helpers.

## License

MIT. Most of the codebase is from-scratch; the in-DOM accessibility walker (`browser-extension/inject/helpers.js`) is conceptually based on `hangwin/mcp-chrome`'s `accessibility-tree-helper.js` (MIT).
