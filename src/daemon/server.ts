import { createServer, Server, Socket } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  appendFileSync,
  statSync,
  renameSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  BridgeRequest,
  BridgeResponse,
  ExtRequest,
  ExtMessage,
  ExtResponse,
  ExtCommand,
  ExtEvent,
  IndicatorState,
  TabInfo,
  TabId,
  TabEnvState,
  resolveExtPort,
  DAEMON_PORT_FILE,
  DAEMON_TOKEN_FILE,
  BROWSER_EXTENSION_ORIGIN,
} from "../protocol";
import { TabLeaseManager } from "./leases";
import { inferExtTimeout } from "./timeouts";

/**
 * Recovery hint surfaced when the WebSocket between the daemon and the MV3
 * extension is not open at call time. The actionable user-side fix is always
 * the same: reload the unpacked extension at chrome://extensions. The agent
 * cannot programmatically fix this from inside the MCP — the message is for
 * the user via the agent's error surfacing.
 */
const EXT_DISCONNECT_RECOVERY_HINT =
  "extension not connected — reload the Browser Automation Bridge extension at chrome://extensions";

/**
 * Chrome tab-group title prefix when an agent claims a tab. Default "Automation"
 * keeps the MCP shippable as a generic standalone tool. Host platforms (e.g.
 * Earthling) can override via the `BROWSER_EXTENSION_TAB_GROUP_LABEL` env var
 * to brand the user-visible tab grouping without forking the MCP — set it in
 * the host's `.mcp.json` env block for `browser-automation-mcp`. The daemon
 * reads it once at startup and stamps it onto every `IndicatorState` so the
 * extension can render the group title without needing its own config plumbing.
 *
 * Read once at module load — the daemon is restarted alongside the engine, so
 * a host config change always lands via a fresh process.
 */
const TAB_GROUP_BRAND =
  process.env.BROWSER_EXTENSION_TAB_GROUP_LABEL?.trim() || "Automation";

interface BridgeClient {
  socket: Socket;
  sessionId: string;
  agentLabel?: string;
  buffer: string;
}

export async function startDaemon(runtimeDir: string): Promise<void> {
  // Last-ditch safety net: never let a stray socket error bring the daemon down.
  process.on("uncaughtException", (err) => {
    console.error(`[daemon] uncaughtException: ${err.stack ?? err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[daemon] unhandledRejection: ${err}`);
  });
  mkdirSync(runtimeDir, { recursive: true });
  // Bridge subscribe-token: random per daemon boot, never user-visible. The bridge reads it
  // from the runtime dir alongside the port. The extension does NOT use this — it is gated
  // by Origin-header check instead (see verifyClient below).
  const token = randomBytes(24).toString("hex");
  const leases = new TabLeaseManager();

  const bySession = new Map<string, BridgeClient>();
  let extSocket: WebSocket | null = null;
  const pendingExt = new Map<string, (m: ExtResponse) => void>();
  const tabsCache = new Map<TabId, TabInfo>();
  /**
   * Per-tab environment state captured off the most recent extension response
   * (ok OR error) and consumed by the NEXT bridge `exec` response for that tab.
   * Last-write-wins per tab: when two sessions drive the SAME tab concurrently
   * one exec may consume the other's event batch — acceptable, since standing
   * states are re-stamped by the extension on every response and drained
   * events surface to *an* agent driving that tab rather than nobody.
   */
  const envByTab = new Map<TabId, TabEnvState>();

  // ─── liveness journal (dropout forensics) ──────────────────────
  //
  // Append-only jsonl of connectivity events (daemon boot, extension WS
  // open/close/replaced, SW hello, bridge subscribe/close, per-command
  // extension timeouts). Exists to answer "why did the extension drop?"
  // after the fact — the disconnect cause is otherwise lost with the daemon's
  // stderr. Size-capped: rotates to `.1` (single generation) at ~512KB.
  const journalPath = join(runtimeDir, "liveness.jsonl");
  const JOURNAL_MAX_BYTES = 512 * 1024;
  function journal(event: string, fields: Record<string, unknown> = {}): void {
    try {
      try {
        if (statSync(journalPath).size > JOURNAL_MAX_BYTES) {
          renameSync(journalPath, `${journalPath}.1`);
        }
      } catch {
        // No journal file yet — the append below creates it.
      }
      appendFileSync(
        journalPath,
        JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) +
          "\n",
      );
    } catch {
      // Fail-soft: forensics must never break live traffic.
    }
  }
  journal("daemon_boot", { pid: process.pid });
  /**
   * Why and when the extension last went away — folded into the
   * "extension not connected" error so the agent sees the probable cause
   * (SW killed? daemon replaced it? clean close?) and how stale it is.
   */
  let lastExtDisconnect: { at: number; cause: string } | null = null;

  const extPort = resolveExtPort();
  // Fail-fast on bind failure: another daemon already owns the relay port. Track a `wsStarted`
  // flag flipped inside `listening` so any pre-listening error (EADDRINUSE, EACCES, …) is fatal,
  // while post-listening errors stay logged-and-ignored as before.
  let wsStarted = false;
  const wss = new WebSocketServer({
    port: extPort,
    host: "127.0.0.1",
    // Origin gate: only our extension's chrome-extension:// URL is accepted. Web pages
    // get https://… origins which browsers set and JS cannot override, so this blocks
    // any malicious page that finds the loopback port — no user-visible token needed.
    verifyClient: (info, done) => {
      const origin = info.origin;
      if (origin === BROWSER_EXTENSION_ORIGIN) {
        done(true);
      } else {
        console.error(
          `[daemon] rejecting WS connection from origin: ${origin || "(none)"}`,
        );
        done(false, 401, "unauthorized origin");
      }
    },
  });
  wss.on("listening", () => {
    wsStarted = true;
  });
  wss.on("error", (err) => {
    if (!wsStarted) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      console.error(
        `[daemon] fatal: failed to bind ws://127.0.0.1:${extPort} (${code}: ${err.message}). Another browser-automation-mcp daemon is likely already running. Exiting.`,
      );
      process.exit(1);
    }
    console.error(`[daemon] WebSocketServer error: ${err.message}`);
  });
  wss.on("connection", (ws) => {
    if (extSocket) {
      journal("ext_ws_replaced");
      extSocket.close(4002, "replaced");
    }
    journal("ext_ws_open");
    extSocket = ws;
    ws.on("error", (err) => {
      console.error(`[daemon] extension WS error: ${err.message}`);
      journal("ext_ws_error", { error: err.message });
    });
    ws.on("message", (raw) => {
      handleExtMessage(String(raw));
    });
    ws.on("close", (code, reason) => {
      const cause = `ws close ${code}${reason?.length ? ` (${reason.toString()})` : ""}`;
      journal("ext_ws_close", { code, reason: reason?.toString() || "" });
      if (extSocket === ws) {
        extSocket = null;
        lastExtDisconnect = { at: Date.now(), cause };
      }
    });
    rebroadcastIndicators();
  });

  // Extension service workers are wiped on every reload; their per-tab Maps come back empty.
  // Daemon leases survive, so on each fresh WS connect we re-emit them so the extension can
  // rehydrate its tab-group colours and in-page indicator state.
  function rebroadcastIndicators(): void {
    for (const lease of leases.all()) {
      pushIndicator(lease.tabId, {
        state: "leased",
        agentLabel: lease.agentLabel,
      });
    }
  }

  function handleExtMessage(text: string): void {
    let msg: ExtMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if ("id" in msg && typeof (msg as ExtResponse).id === "string") {
      const response = msg as ExtResponse;
      const resolver = pendingExt.get(response.id);
      if (resolver) {
        pendingExt.delete(response.id);
        resolver(response);
      }
      return;
    }
    handleExtEvent(msg as ExtEvent);
  }

  function handleExtEvent(ev: ExtEvent): void {
    if (ev.type === "tab_created" || ev.type === "tab_updated") {
      tabsCache.set(ev.tab.id, ev.tab);
    } else if (ev.type === "tab_closed") {
      tabsCache.delete(ev.tabId);
      leases.dropTab(ev.tabId);
      envByTab.delete(ev.tabId);
    } else if (ev.type === "hello") {
      journal("ext_hello", {
        version: ev.version,
        swStartedAt: ev.swStartedAt,
      });
    } else if (ev.type === "popup_opened") {
      tabsCache.set(ev.tab.id, ev.tab);
      // Auto-lease the popup to the opener's session: the popup IS the
      // continuation of the agent's own action (its trusted click / the
      // page's window.open), so the agent should be able to act on it
      // without a manual browser_switch_tab hop. The indicator push then
      // triggers the extension's eager lease-attach on the popup.
      const opener = leases.get(ev.openerTabId);
      if (opener) {
        const claimed = leases.claim(
          ev.tab.id,
          opener.sessionId,
          opener.agentLabel,
          { reason: `popup opened by leased tab ${ev.openerTabId}` },
        );
        if (claimed.ok) {
          pushIndicator(ev.tab.id, {
            state: "leased",
            agentLabel: opener.agentLabel,
          });
        }
      }
    }
  }

  function pushIndicator(tabId: TabId, state: IndicatorState): void {
    // Stamp the host-configured brand label on every indicator push. The
    // extension uses this for the Chrome tab-group title (e.g. "Earthling — Anjuman").
    // Caller-supplied tabGroupBrand wins so future callers can override per push.
    const decorated: IndicatorState = {
      tabGroupBrand: TAB_GROUP_BRAND,
      ...state,
    };
    void sendExt({ kind: "indicator_state", state: decorated }, tabId).catch(
      () => {},
    );
  }

  function sendExt(command: ExtCommand, tabId?: TabId): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!extSocket || extSocket.readyState !== WebSocket.OPEN) {
        // Fold in the last-known disconnect cause + age — "SW closed 4s ago"
        // reads very differently from "closed 2h ago" (dead extension).
        const since = lastExtDisconnect
          ? ` (last disconnect: ${lastExtDisconnect.cause}, ${Math.round((Date.now() - lastExtDisconnect.at) / 1000)}s ago)`
          : "";
        const err: any = new Error(`extension not connected${since}`);
        err.kind = "extension_disconnected";
        err.tabId = tabId;
        err.recovery = EXT_DISCONNECT_RECOVERY_HINT;
        err.hint = EXT_DISCONNECT_RECOVERY_HINT;
        reject(err);
        return;
      }
      const id = randomBytes(8).toString("hex");
      const req: ExtRequest = { id, tabId, command };
      pendingExt.set(id, (m) => {
        // Environment passthrough: the extension stamps per-tab env state on
        // BOTH ok and error responses; park it for the enclosing bridge exec
        // to consume (handleBridgeLine) since `resolve(m.result)` drops the
        // envelope.
        if (m.env && tabId !== undefined) envByTab.set(tabId, m.env);
        if (m.ok) resolve(m.result);
        else {
          const err: any = new Error(m.error);
          // Extension-side timeouts often mean a CDP attach is wedged; surface
          // the same recovery hint shape.
          if (/timeout/i.test(m.error)) {
            err.kind = "extension_timeout";
            err.tabId = tabId;
            err.hint = `extension call timed out (tabId ${tabId ?? "n/a"}); check that the tab is still alive and the extension is responsive`;
          }
          reject(err);
        }
      });
      setTimeout(() => {
        if (pendingExt.delete(id)) {
          journal("ext_command_timeout", { kind: command.kind, tabId });
          const err: any = new Error("extension timeout");
          err.kind = "extension_timeout";
          err.tabId = tabId;
          err.hint = `extension call timed out (tabId ${tabId ?? "n/a"}); check that the tab is still alive and the extension is responsive`;
          reject(err);
        }
      }, inferExtTimeout(command));
      extSocket!.send(JSON.stringify(req));
    });
  }

  // ─── bridge server (loopback TCP) ──────────────────────────────

  const tcp = createServer((socket) => {
    const client: BridgeClient = { socket, sessionId: "", buffer: "" };
    socket.setNoDelay(true);
    socket.on("error", (err) => {
      console.error(`[daemon] bridge socket error: ${err.message}`);
    });
    socket.on("data", (chunk) => {
      client.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = client.buffer.indexOf("\n")) >= 0) {
        const line = client.buffer.slice(0, nl);
        client.buffer = client.buffer.slice(nl + 1);
        if (line.trim()) handleBridgeLine(client, line);
      }
    });
    socket.on("close", () => {
      if (client.sessionId) {
        bySession.delete(client.sessionId);
        const released = leases.releaseAll(client.sessionId);
        for (const id of released) {
          pushIndicator(id, { state: "released" });
          envByTab.delete(id);
        }
        journal("bridge_close", {
          sessionId: client.sessionId,
          leasesReleased: released,
        });
        if (released.length) {
          console.error(
            `[daemon] released ${released.length} lease(s) from disconnected session ${client.sessionId}`,
          );
        }
      }
    });
  });

  async function handleBridgeLine(
    client: BridgeClient,
    line: string,
  ): Promise<void> {
    let req: BridgeRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    // Consume-once env passthrough for tab-targeted execs: whatever the
    // extension stamped for this tab rides out on this response and is
    // cleared (standing states are re-stamped extension-side every response,
    // so nothing sticky is lost by consuming).
    const takeEnv = (): TabEnvState | undefined => {
      if (req.type !== "exec") return undefined;
      const env = envByTab.get(req.tabId);
      if (env) envByTab.delete(req.tabId);
      return env;
    };
    try {
      const result = await dispatch(client, req);
      const env = takeEnv();
      respond(client, { id: req.id, ok: true, result, ...(env ? { env } : {}) });
    } catch (err: any) {
      // A lease_required rejection never reached the extension AND the caller
      // is not the tab's holder — delivering (and consuming) the parked env
      // here would leak the holder's events to a non-holder session.
      const env = err?.message === "lease_required" ? undefined : takeEnv();
      respond(client, {
        id: req.id,
        ok: false,
        error: err?.message ?? String(err),
        leasedBy: err?.leasedBy,
        since: err?.since,
        hint: err?.hint,
        recovery: err?.recovery,
        kind: err?.kind,
        ...(env ? { env } : {}),
      });
    }
  }

  async function dispatch(
    client: BridgeClient,
    req: BridgeRequest,
  ): Promise<unknown> {
    switch (req.type) {
      case "subscribe": {
        if (req.token !== token) throw new Error("bad token");
        client.sessionId = req.sessionId;
        client.agentLabel = req.agentLabel;
        bySession.set(req.sessionId, client);
        journal("bridge_subscribe", {
          sessionId: req.sessionId,
          agentLabel: req.agentLabel,
        });
        return { ok: true };
      }
      case "list_tabs": {
        const all = (await sendExt({
          kind: "tabs_query",
          query: req.query,
        })) as TabInfo[];
        return all.map(annotateLease);
      }
      case "open_tab": {
        const tab = (await sendExt({
          kind: "tabs_create",
          url: req.url,
          background: req.background !== false,
        })) as TabInfo & {
          navigated?: boolean;
          settledAt?: number;
          previousActiveTab: { id: TabId; title: string; url: string } | null;
        };
        tabsCache.set(tab.id, {
          id: tab.id,
          url: tab.url,
          title: tab.title,
          windowId: tab.windowId,
          active: tab.active,
        });
        leases.claim(tab.id, client.sessionId, client.agentLabel);
        pushIndicator(tab.id, {
          state: "leased",
          agentLabel: client.agentLabel,
        });
        return annotateLease(tab);
      }
      case "close_tab": {
        await sendExt({ kind: "tabs_remove", tabId: req.tabId });
        leases.dropTab(req.tabId);
        tabsCache.delete(req.tabId);
        return { closed: req.tabId };
      }
      case "switch_tab": {
        // Capture the user's currently-focused tab BEFORE the claim so the
        // agent can restore focus later if it has nudged the user's context.
        // Distinguish three cases explicitly so the agent can tell "no
        // foreground tab" from "couldn't ask the extension":
        //   - extension returned a tab → { id, title }
        //   - extension returned null  → null (no foreground tab)
        //   - lookup threw              → null + previousActiveTabError
        // Cosmetic capture must not fail the claim — that's an existing
        // invariant — but the error surfaces alongside the success result.
        let previousActiveTab: { id: TabId; title: string; url: string } | null = null;
        let previousActiveTabError: string | undefined;
        try {
          previousActiveTab =
            ((await sendExt({ kind: "get_focused_tab" })) as
              | { id: TabId; title: string; url: string }
              | null) ?? null;
        } catch (e: any) {
          previousActiveTabError = e?.message ?? "get_focused_tab failed";
        }
        const r = leases.claim(req.tabId, client.sessionId, client.agentLabel, {
          force: req.force,
          reason: req.reason,
        });
        if (!r.ok) {
          const e: any = new Error("tab_leased");
          e.leasedBy = r.held.agentLabel ?? r.held.sessionId;
          e.since = new Date(r.held.claimedAt).toISOString();
          e.hint = `tab ${req.tabId} is leased by another session; call browser_switch_tab again with force:true and reason:"…" to revoke`;
          throw e;
        }
        pushIndicator(req.tabId, {
          state: "leased",
          agentLabel: client.agentLabel,
        });
        return {
          claimed: req.tabId,
          previousActiveTab,
          ...(previousActiveTabError ? { previousActiveTabError } : {}),
        };
      }
      case "release_tab": {
        // Parked env dies with the lease: a future lease of the same tab must
        // not receive the previous agent's drained events (the extension
        // clears its side on the released indicator; this is the daemon twin).
        if (req.tabId === undefined) {
          const released = leases.releaseAll(client.sessionId);
          for (const id of released) {
            pushIndicator(id, { state: "released" });
            envByTab.delete(id);
          }
          return { released };
        }
        const ok = leases.release(req.tabId, client.sessionId);
        if (ok) {
          pushIndicator(req.tabId, { state: "released" });
          envByTab.delete(req.tabId);
        }
        return { released: ok ? [req.tabId] : [] };
      }
      case "exec": {
        const lease = leases.requireHolder(req.tabId, client.sessionId);
        if (!lease) {
          const held = leases.get(req.tabId);
          const e: any = new Error("lease_required");
          if (held) {
            e.leasedBy = held.agentLabel ?? held.sessionId;
            e.since = new Date(held.claimedAt).toISOString();
          }
          e.hint = `lease required for tab ${req.tabId}; call browser_switch_tab(tabId:${req.tabId}) before acting on it`;
          throw e;
        }
        return await sendExt(req.command, req.tabId);
      }
    }
  }

  function annotateLease(t: TabInfo): TabInfo {
    const lease = leases.get(t.id);
    return lease
      ? {
          ...t,
          leasedBy: {
            sessionId: lease.sessionId,
            agentLabel: lease.agentLabel,
            since: lease.claimedAt,
          },
        }
      : t;
  }

  function respond(client: BridgeClient, msg: BridgeResponse): void {
    try {
      client.socket.write(JSON.stringify(msg) + "\n");
    } catch {
      /* socket gone */
    }
  }

  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const tcpPort = (tcp.address() as { port: number }).port;
  writeFileSync(join(runtimeDir, DAEMON_PORT_FILE), String(tcpPort));
  writeFileSync(join(runtimeDir, DAEMON_TOKEN_FILE), token, { mode: 0o600 });

  console.error(
    `[daemon] bridges on tcp://127.0.0.1:${tcpPort}, extension on ws://127.0.0.1:${extPort} (origin-gated)`,
  );

  const cleanup = () => {
    try {
      unlinkSync(join(runtimeDir, DAEMON_PORT_FILE));
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(join(runtimeDir, DAEMON_TOKEN_FILE));
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

export function readDaemonEndpoint(
  runtimeDir: string,
): { port: number; token: string } | null {
  const pf = join(runtimeDir, DAEMON_PORT_FILE);
  const tf = join(runtimeDir, DAEMON_TOKEN_FILE);
  if (!existsSync(pf) || !existsSync(tf)) return null;
  const port = parseInt(readFileSync(pf, "utf8").trim(), 10);
  const token = readFileSync(tf, "utf8").trim();
  if (!port || !token) return null;
  return { port, token };
}
