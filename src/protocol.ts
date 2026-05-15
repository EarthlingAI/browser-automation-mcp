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
  | { kind: "snapshot"; viewportOnly?: boolean; limit?: number }
  | {
      kind: "screenshot";
      format?: "png" | "jpeg";
      quality?: number;
      maxWidth?: number;
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
 * earthling-extension/background.js (and the probe URL in status.js / status.html);
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
 * Chrome extension ID derived from the pinned CRX `key` in `earthling-extension/manifest.json`.
 * The daemon checks every WebSocket upgrade's `Origin` header against `chrome-extension://<id>` —
 * browsers set Origin from the executing context and web pages cannot forge it, so this gives
 * us per-extension authentication without any user-visible token paste.
 */
export const EARTHLING_EXTENSION_ID = "ifoggnihepkfpokholefpgpcgiikkeke";
export const EARTHLING_EXTENSION_ORIGIN = `chrome-extension://${EARTHLING_EXTENSION_ID}`;
