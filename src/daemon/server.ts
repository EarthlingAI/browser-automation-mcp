import { createServer, Server, Socket } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
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
  EXT_PORT_DEFAULT,
  DAEMON_PORT_FILE,
  DAEMON_TOKEN_FILE,
  EARTHLING_EXTENSION_ORIGIN,
} from "../protocol";
import { TabLeaseManager } from "./leases";

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

  const wss = new WebSocketServer({
    port: EXT_PORT_DEFAULT,
    host: "127.0.0.1",
    // Origin gate: only our extension's chrome-extension:// URL is accepted. Web pages
    // get https://… origins which browsers set and JS cannot override, so this blocks
    // any malicious page that finds the loopback port — no user-visible token needed.
    verifyClient: (info, done) => {
      const origin = info.origin;
      if (origin === EARTHLING_EXTENSION_ORIGIN) {
        done(true);
      } else {
        console.error(
          `[daemon] rejecting WS connection from origin: ${origin || "(none)"}`,
        );
        done(false, 401, "unauthorized origin");
      }
    },
  });
  wss.on("error", (err) => {
    console.error(`[daemon] WebSocketServer error: ${err.message}`);
  });
  wss.on("connection", (ws) => {
    if (extSocket) extSocket.close(4002, "replaced");
    extSocket = ws;
    ws.on("error", (err) => {
      console.error(`[daemon] extension WS error: ${err.message}`);
    });
    ws.on("message", (raw) => {
      handleExtMessage(String(raw));
    });
    ws.on("close", () => {
      if (extSocket === ws) extSocket = null;
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
    }
  }

  function pushIndicator(tabId: TabId, state: IndicatorState): void {
    void sendExt({ kind: "indicator_state", state }, tabId).catch(() => {});
  }

  function sendExt(command: ExtCommand, tabId?: TabId): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!extSocket || extSocket.readyState !== WebSocket.OPEN) {
        reject(new Error("extension not connected"));
        return;
      }
      const id = randomBytes(8).toString("hex");
      const req: ExtRequest = { id, tabId, command };
      pendingExt.set(id, (m) => {
        if (m.ok) resolve(m.result);
        else reject(new Error(m.error));
      });
      setTimeout(() => {
        if (pendingExt.delete(id)) reject(new Error("extension timeout"));
      }, 30_000);
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
        for (const id of released) pushIndicator(id, { state: "released" });
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
    try {
      const result = await dispatch(client, req);
      respond(client, { id: req.id, ok: true, result });
    } catch (err: any) {
      respond(client, {
        id: req.id,
        ok: false,
        error: err?.message ?? String(err),
        leasedBy: err?.leasedBy,
        since: err?.since,
        hint: err?.hint,
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
        })) as TabInfo;
        tabsCache.set(tab.id, tab);
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
        const r = leases.claim(req.tabId, client.sessionId, client.agentLabel, {
          force: req.force,
          reason: req.reason,
        });
        if (!r.ok) {
          const e: any = new Error("tab_leased");
          e.leasedBy = r.held.agentLabel ?? r.held.sessionId;
          e.since = new Date(r.held.claimedAt).toISOString();
          e.hint = "call again with force:true and reason:'…' to revoke";
          throw e;
        }
        pushIndicator(req.tabId, {
          state: "leased",
          agentLabel: client.agentLabel,
        });
        return { claimed: req.tabId };
      }
      case "release_tab": {
        if (req.tabId === undefined) {
          const released = leases.releaseAll(client.sessionId);
          for (const id of released) pushIndicator(id, { state: "released" });
          return { released };
        }
        const ok = leases.release(req.tabId, client.sessionId);
        if (ok) pushIndicator(req.tabId, { state: "released" });
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
          e.hint = `call switch_tab(tabId:${req.tabId}) first`;
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
    `[daemon] bridges on tcp://127.0.0.1:${tcpPort}, extension on ws://127.0.0.1:${EXT_PORT_DEFAULT} (origin-gated)`,
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
