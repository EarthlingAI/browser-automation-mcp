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
   * Either `withTree` or `withScreenshot` may be false — `browser_screenshot`
   * uses `{withTree:false, withScreenshot:true}` for a pixels-only payload.
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
   * independently testable. Standalone `browser_screenshot` never calls this.
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
  | {
      kind: "press_key";
      key: string;
      modifiers?: string[];
      settle?: SettleOptions;
    }
  | { kind: "evaluate"; expression: string }
  | {
      kind: "wait_for";
      selector?: string;
      condition?: string;
      timeout?: number;
      networkIdle?: boolean;
      pollIntervalMs?: number;
    }
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
