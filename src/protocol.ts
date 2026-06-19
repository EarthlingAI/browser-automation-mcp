/**
 * Wire protocol shared by daemon, bridges, and the extension.
 *
 * Three message hops:
 *   bridge ↔ daemon   — JSON-line over loopback TCP. Bridges are MCP clients.
 *   daemon ↔ extension — JSON over WebSocket on :9223. One extension at a time.
 *
 * The daemon is the single source of truth for tab leases and routes
 * commands from bridges to the extension, and events back.
 */

export type TabId = number;

export type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

export interface Lease {
  tabId: TabId;
  sessionId: string;
  agentLabel?: string;
  claimedAt: number;
  reason?: string;
}

export interface TabInfo {
  id: TabId;
  url: string;
  title: string;
  windowId: number;
  active: boolean;
  leasedBy?: { sessionId: string; agentLabel?: string; since: number };
}

/**
 * Settle protocol — when an action command (click/type/scroll/...) lands in the
 * page, the extension installs a brief observer and resolves only once the page
 * has shown a signal of having processed the action, OR a timeout elapses. This
 * is what stops the Suno-class "click returned but nothing visibly happened →
 * agent re-fires it → double-submit" failure mode.
 *
 *  - dom     → resolve on first MutationObserver callback on document.body
 *  - network → resolve on first webRequest fired from the tab
 *  - selector → resolve when the named CSS selector matches
 *  - none    → no settle wait; resolve immediately
 */
export interface SettleOptions {
  mode: "dom" | "network" | "selector" | "none";
  timeout?: number;
  selector?: string;
}

/** Reported back to the agent so it knows what triggered the action to settle. */
export type SettleResult =
  | { via: "dom"; elapsedMs: number }
  | { via: "network"; elapsedMs: number }
  | { via: "selector"; elapsedMs: number; selector: string }
  | { via: "timeout"; elapsedMs: number }
  | { via: "none"; elapsedMs: 0 };

// ─── bridge → daemon ────────────────────────────────────────────────

export type BridgeRequest =
  | {
      id: string;
      type: "subscribe";
      sessionId: string;
      agentLabel?: string;
      token: string;
    }
  | { id: string; type: "list_tabs"; query?: string }
  | { id: string; type: "open_tab"; url: string; background?: boolean }
  | { id: string; type: "close_tab"; tabId: TabId }
  | {
      id: string;
      type: "switch_tab";
      tabId: TabId;
      force?: boolean;
      reason?: string;
    }
  | { id: string; type: "release_tab"; tabId?: TabId }
  | { id: string; type: "exec"; tabId: TabId; command: ExtCommand };

// ─── daemon → bridge ────────────────────────────────────────────────

export type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | {
      id: string;
      ok: false;
      error: string;
      leasedBy?: string;
      since?: string;
      hint?: string;
      recovery?: string;
      kind?: string;
    };

// ─── daemon ↔ extension ─────────────────────────────────────────────

export type ExtCommand =
  | { kind: "tabs_query"; query?: string }
  | { kind: "get_focused_tab" }
  | {
      kind: "tabs_create";
      url: string;
      background?: boolean;
      settle?: SettleOptions;
    }
  | { kind: "tabs_remove"; tabId: TabId }
  | {
      kind: "navigate";
      url?: string;
      waitUntil?: "load" | "domcontentloaded";
      settle?: SettleOptions;
    }
  | { kind: "navigate_back"; settle?: SettleOptions }
  /**
   * Atomic tree + screenshot capture. Eliminates the layout-shift race that
   * a sequential snapshot-then-screenshot would suffer on SPAs (Suno,
   * ChatGPT, etc. fire layout-shifts on scroll/focus/hydration). The
   * extension uses a single `chrome.debugger` attach for the screenshot and
   * walks the tree inside the same promise.
   *
   * Either `withTree` or `withScreenshot` may be false — `{withTree:false,
   * withScreenshot:true}` yields a tree-less, pixels-only payload.
   *
   * Response shape (extension → daemon):
   *   { tree?: RawNode, screenshot?: { format, dataBase64, resizedTo? },
   *     cssViewport?: { w: number; h: number } }
   * `cssViewport` is surfaced only when `withTree:true` — the annotation hop
   * is the only consumer and it never runs without a fresh tree.
   */
  | {
      kind: "snapshot_capture";
      withTree: boolean;
      withScreenshot: boolean;
      viewportOnly?: boolean;
      limit?: number;
      format?: "png" | "jpeg";
      quality?: number;
      maxWidth?: number;
      /**
       * Phase 4b opt-in: after the main-frame walk, descend cross-origin OOPIFs
       * (executeScript into each frame's own realm) and splice their subtrees in
       * with `fN:`-namespaced refs + top-viewport rects. Default off — the base
       * snapshot never reaches into cross-origin frames (cost + privacy).
       */
      includeCrossOriginFrames?: boolean;
    }
  /**
   * Stateless image-in / image-out overlay. The bridge supplies the bitmap,
   * the CSS-pixel rect list (from the most recent snapshot), and the visual
   * constants; the extension draws ref badges using OffscreenCanvas in the
   * privileged service-worker context — no debugger attach, no page-script
   * injection, no CSP exposure.
   *
   * Lives in a separate hop (not folded into snapshot_capture) so the bridge
   * can decide whether to spend the annotation cycle and so each hop stays
   * independently testable. A tree-less capture (`withTree:false`) never calls this.
   *
   * Response shape: `{ format, dataBase64, resizedTo? }`.
   */
  | {
      kind: "annotate_image";
      imageBase64: string;
      format: "png" | "jpeg";
      quality?: number;
      rects: Array<{
        ref: string;
        rect: { x: number; y: number; w: number; h: number };
        /**
         * Whether the extension should stroke the bounding box for this rect.
         * Computed bridge-side: a rect that fully contains another annotated
         * rect has `drawStroke:false` (parent-bbox suppression — kills the
         * "WebArea root strokes the entire viewport" visual noise). The badge
         * always draws regardless so the agent can still target the parent.
         */
        drawStroke: boolean;
      }>;
      /**
       * Page CSS-pixel viewport at snapshot time (`window.innerWidth/Height`).
       * The extension derives canvas-pixel scale as `imgW / cssViewport.w`
       * (and `imgH / cssViewport.h`) — DPR drops out because it's baked into
       * both the post-resize bitmap and the CSS viewport identically, so the
       * formula is invariant to which hop did the resize.
       */
      cssViewport: { w: number; h: number };
      maxWidth?: number;
      constants: {
        BADGE_FILL: string;
        BADGE_TEXT_COLOR: string;
        BADGE_FONT: string;
        BBOX_STROKE: string;
        BBOX_STROKE_WIDTH: number;
        BADGE_PADDING: number;
        BADGE_OFFSET_Y: number;
        MIN_ANNOTATABLE_PX: number;
      };
    }
  | {
      kind: "console_messages";
      limit?: number;
      cursor?: string;
    }
  | {
      kind: "network_requests";
      limit?: number;
      cursor?: string;
      urlPattern?: string;
      type?: string[];
      methodIn?: string[];
      statusGte?: number;
      statusLt?: number;
    }
  | {
      kind: "click";
      ref: string;
      button?: "left" | "right" | "middle";
      clickCount?: 1 | 2 | 3;
      modifiers?: string[];
      settle?: SettleOptions;
    }
  | {
      kind: "type";
      ref: string;
      text: string;
      append?: boolean;
      settle?: SettleOptions;
    }
  | {
      kind: "select_option";
      ref: string;
      value: string;
      settle?: SettleOptions;
    }
  | { kind: "hover"; ref: string; settle?: SettleOptions }
  | {
      kind: "scroll";
      ref?: string;
      deltaY?: number;
      deltaX?: number;
      settle?: SettleOptions;
    }
  | {
      kind: "upload";
      ref: string;
      files: Array<{ name: string; mimeType: string; dataBase64: string }>;
      settle?: SettleOptions;
    }
  /**
   * Drag the source ref's element onto the target ref's element. Page-side
   * synthetic events (helpers.js::actDrag) — no CDP `Input.*`, no window raise.
   * `mechanism` picks the event family: "native" fires the HTML5 DnD-API
   * sequence (dragstart→dragenter→dragover→drop→dragend with a shared
   * DataTransfer) for `draggable="true"` sources; "pointer" fires a
   * mousedown→interpolated-mousemove→mouseup pointer sequence for pointer-based
   * DnD libraries (SortableJS forceFallback, react-beautiful-dnd, kanban
   * boards). "auto" (default) inspects the source's `draggable` IDL flag and
   * picks native when set, pointer otherwise.
   */
  | {
      kind: "drag";
      ref: string;
      targetRef: string;
      mechanism?: "auto" | "native" | "pointer";
      settle?: SettleOptions;
    }
  /**
   * Drop files onto the target ref's element — synthesizes an HTML5
   * dragenter→dragover→drop sequence carrying the files in a constructed
   * DataTransfer (the page sees `dataTransfer.files`, same shape a real desktop
   * file-drop produces). Page-side (helpers.js::actDrop); reuses the upload
   * command's base64 file-payload shape.
   */
  | {
      kind: "drop";
      ref: string;
      files: Array<{ name: string; mimeType: string; dataBase64: string }>;
      settle?: SettleOptions;
    }
  | {
      kind: "press_key";
      key: string;
      modifiers?: string[];
      /**
       * Escalate from the default page-side synthetic KeyboardEvent to a TRUSTED
       * CDP `Input.dispatchKeyEvent`. Set when a widget gates on `event.isTrusted`
       * or needs the browser's own key handling (real form-submit on Enter, focus
       * navigation on Tab). Auto-asserts focus-emulation before dispatch. Costs the
       * "started debugging" infobar; see invariant #37. Omitted/false → synthetic.
       */
      trusted?: boolean;
      settle?: SettleOptions;
    }
  /**
   * Trusted coordinate click via CDP `Input.dispatchMouseEvent` (mouseMoved →
   * mousePressed → mouseReleased ×clickCount). Unlike `click` (ref-based,
   * page-side synthetic by default), this fires REAL browser mouse input at a
   * viewport coordinate — it hit-tests through overlays/iframes and satisfies
   * `event.isTrusted` gates. Coordinates are CSS pixels relative to the layout
   * viewport (same space as snapshot rects). Auto-asserts focus-emulation so a
   * backgrounded tab composites + hit-tests faithfully. See invariant #37.
   */
  | {
      kind: "click_xy";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: 1 | 2 | 3;
      modifiers?: string[];
      settle?: SettleOptions;
    }
  /**
   * Trusted freehand pointer stroke via CDP `Input.dispatchMouseEvent`
   * (mousePressed → N×mouseMoved → mouseReleased, button held throughout). Draws
   * a continuous path through `points` (CSS-pixel viewport coords) — the input a
   * signature pad, canvas drawing tool, or pointer-DnD surface needs. Auto-asserts
   * focus-emulation. See invariant #37.
   */
  | {
      kind: "draw";
      points: Array<{ x: number; y: number }>;
      button?: "left" | "right" | "middle";
      settle?: SettleOptions;
    }
  /**
   * Run a JS expression in the page via CDP `Runtime.evaluate`. When `timeout`
   * is set (ms), it is passed to CDP so the in-page promise is ABORTED on expiry
   * (not left running unsupervised) and a `{timed_out:true, elapsedMs}` result
   * returns instead of a thrown error. Omitted → the daemon's ~30s watchdog is
   * the only bound (unchanged default). The daemon widens its own watchdog to
   * `timeout + buffer` (timeouts.ts) so it never fires before the in-page deadline.
   */
  | { kind: "evaluate"; expression: string; timeout?: number }
  /**
   * Read or write the OS clipboard as structured data — the content channel for
   * canvas-based spreadsheet/document/slide apps whose grid or document lives in a
   * `<canvas>`, not the DOM. The agent puts the selection on the clipboard with a
   * trusted Ctrl+C (`op:"read"`) or pastes written data with a trusted Ctrl+V
   * (`op:"write"`), and this command moves the structured payload across.
   *
   *  - read  → `execCommand('paste')` in the extension's ISOLATED content-script
   *    world, gated by the manifest `clipboardRead` permission (NOT the page's
   *    `clipboard-read`, which Chrome leaves at `prompt` for backgrounded tabs and
   *    silently returns empty for). Returns `{ text, html }` — `text` is the
   *    plain-text/TSV flavour (hidden `<textarea>`), `html` the rich flavour
   *    (hidden `contenteditable`), either possibly empty.
   *  - write → `navigator.clipboard.write([ClipboardItem])` in the page's MAIN
   *    world (clipboard-WRITE is granted for a focused secure context, so no
   *    manifest permission is needed). Writes `text/plain` always and `text/html`
   *    when `html` is supplied. Returns `{ written: true }`.
   *
   * Both ops first assert focus-emulation (the tab must read as focused for either
   * to succeed) — no window raise. The page itself never gains clipboard-read: the
   * privileged read runs only in the extension's own content-script context on the
   * agent-leased tab.
   */
  | { kind: "clipboard"; op: "read" }
  | { kind: "clipboard"; op: "write"; text: string; html?: string }
  /**
   * Read-only liveness probe for a single ref. Runs `__mcpResolveRef` in the
   * page and returns `{name, role, tag, rect}` while the ref's element is still
   * attached to the DOM, or `null` once it's gone. Used by the bridge's
   * non-evicting ref resolution: a ref that fell out of the latest snapshot
   * (pruner cap, scrolled out of viewport, hidden) is verified live via this
   * probe before the action fires, so genuinely-removed elements surface an
   * actionable error instead of a silent no-op. Performs no mutation and never
   * settles.
   */
  | { kind: "resolve_ref"; ref: string }
  | {
      kind: "wait_for";
      selector?: string;
      condition?: string;
      timeout?: number;
      networkIdle?: boolean;
      pollIntervalMs?: number;
    }
  /**
   * Toggle CDP focus-emulation (`Emulation.setFocusEmulationEnabled` + lifecycle
   * `active`) on the leased tab. This makes Chrome treat an occluded background tab
   * as visible + focused — WITHOUT raising the OS window — which resumes
   * `requestAnimationFrame`. It is a RENDERING/visibility aid: backgrounded canvas
   * SPAs (Google Sheets, Figma, Miro) route selection highlight, menu positioning,
   * and scroll through rAF, so without emulation they RENDER stale (and screenshots
   * look stale) even though the page's JS model stays live — input via synthetic DOM
   * events reaches the model regardless. Emulation is debugger-session-scoped (clears
   * on detach); the service worker re-asserts it on every fresh attach for flagged
   * tabs, and the disable path detaches promptly to revert all overrides. See
   * invariants #27/#28.
   */
  | { kind: "set_focus_emulation"; enabled: boolean }
  /**
   * Override the leased tab's viewport via CDP `Emulation.setDeviceMetricsOverride`
   * (debugger-session-scoped, same infra as focus-emulation — no window raise, no
   * focus theft). Resizes the visual viewport so `window.innerWidth/Height`, media
   * queries, and responsive layout reflect `width`×`height` in CSS pixels.
   * `deviceScaleFactor:0` (host-natural DPR) + `mobile:false` keep it a pure desktop
   * viewport resize. STICKY per-tab: the override is tracked SW-side in the
   * `deviceMetrics` Map and re-asserted on every fresh debugger attach, so it
   * survives the attach/detach churn of an action sequence; it clears on tab-close
   * or extension reload (and transiently when focus-emulation is disabled, which
   * detaches the debugger — re-asserted on the next attach).
   */
  | { kind: "resize"; width: number; height: number }
  /**
   * Pre-arm an auto-response for the leased tab's next native JS dialog
   * (alert / confirm / prompt / beforeunload). The extension subscribes to CDP
   * `Page.javascriptDialogOpening` events on tabs with an armed disposition and
   * answers via `Page.handleJavaScriptDialog{accept, promptText?}`. `disposition`
   * is "accept" or "dismiss"; `promptText` (only meaningful when accepting a
   * `prompt`) is fed into the dialog's input. `lifetime:"one_shot"` (default)
   * clears the disposition after the next dialog fires; `"sticky"` persists until
   * an explicit `clear:true` (xor with disposition) or tab close. `Page.enable` is
   * scoped to tabs with an active handler and dropped via `Page.disable` the
   * moment the handler clears — never enabled on focus-emulation alone (invariant
   * #35). The disposition is debugger-session-tracked but the Map is SW state, so
   * `debuggerAttach` re-asserts `Page.enable` on every fresh attach for tabs with
   * an entry (same model as focus-emulation / resize).
   */
  | {
      kind: "handle_dialog";
      disposition?: "accept" | "dismiss";
      promptText?: string;
      lifetime?: "one_shot" | "sticky";
      clear?: boolean;
    }
  /**
   * Raise the real OS browser window and activate the tab (`chrome.windows.update`
   * + `chrome.tabs.update({active})`). This GENUINELY steals the user's focus — the
   * sole sanctioned exception to the no-raise/no-activate invariants (#1/#2/#29).
   * Only for focus-dependent cases focus-emulation can't satisfy (OS file pickers,
   * clipboard-paste permission gates, drag-drop, native `:focus` UI). Returns the
   * previously-active tab so the agent can restore it.
   */
  | { kind: "bring_to_front" }
  | { kind: "indicator_state"; state: IndicatorState };

export interface IndicatorState {
  state: "leased" | "released";
  agentLabel?: string;
  /**
   * Brand label for the Chrome tab-group title (e.g. "Automation", "Earthling").
   * Decorated by the daemon from `BROWSER_EXTENSION_TAB_GROUP_LABEL` so the same
   * generic MCP can ship under host-specific branding without per-build edits to
   * the extension. The extension uses `tabGroupBrand ?? "Automation"`.
   */
  tabGroupBrand?: string;
}

export interface ExtRequest {
  id: string;
  tabId?: TabId;
  command: ExtCommand;
}

export type ExtResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export type ExtEvent =
  | { type: "hello"; version: string }
  | { type: "tab_closed"; tabId: TabId }
  | { type: "tab_created"; tab: TabInfo }
  | { type: "tab_updated"; tab: TabInfo };

export type ExtMessage = ExtResponse | ExtEvent;

// ─── shared constants ───────────────────────────────────────────────

export const EXT_PORT_DEFAULT = 9223;
export const DAEMON_PORT_FILE = "daemon.port";
export const DAEMON_TOKEN_FILE = "subscribe.token";
export const DAEMON_LOCK_FILE = "daemon.lock";

/**
 * Loopback port the daemon binds for the WebSocket the Chrome extension dials.
 * Override via BROWSER_AUTOMATION_MCP_RELAY_PORT — useful when 9223 is taken.
 * If you override, you must also update the matching DAEMON_URL constant in
 * browser-extension/background.js (and the probe URL in status.js / status.html);
 * the unpacked extension cannot read env vars.
 */
export function resolveExtPort(): number {
  const raw = process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT;
  if (!raw) return EXT_PORT_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(
      `[browser-automation-mcp] BROWSER_AUTOMATION_MCP_RELAY_PORT="${raw}" is not a valid port; falling back to ${EXT_PORT_DEFAULT}`,
    );
    return EXT_PORT_DEFAULT;
  }
  return parsed;
}

/**
 * Chrome extension ID derived from the pinned CRX `key` in `browser-extension/manifest.json`.
 * The daemon checks every WebSocket upgrade's `Origin` header against `chrome-extension://<id>` —
 * browsers set Origin from the executing context and web pages cannot forge it, so this gives
 * us per-extension authentication without any user-visible token paste.
 */
export const BROWSER_EXTENSION_ID = "ifoggnihepkfpokholefpgpcgiikkeke";
export const BROWSER_EXTENSION_ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}`;
