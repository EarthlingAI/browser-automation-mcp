import { createConnection, Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  BridgeRequest,
  BridgeResponse,
  DistributiveOmit,
  ExtCommand,
  TabId,
  TabEnvState,
} from "../protocol";

type Resolver = (m: BridgeResponse) => void;

/**
 * Environment state as surfaced on a tool envelope: per-tab, tabId stamped so
 * a session holding several leases can attribute each event/standing state.
 * A single object when one tab reported, an array when several did.
 */
export type EnvReport =
  | (TabEnvState & { tabId: TabId })
  | Array<TabEnvState & { tabId: TabId }>;

export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, Resolver>();
  readonly sessionId: string;
  private connected = false;
  private _endpoint: { port: number; token: string };
  // Serialises concurrent recovery attempts inside one bridge — multiple send() calls
  // that race past `!this.connected` all await the same respawn rather than each spawning.
  private recoveryPromise: Promise<void> | null = null;
  /**
   * Environment state accumulated off daemon responses (ok AND error) since
   * the last `takeEnv()`, keyed PER TAB — a session can hold several leases,
   * and an exec on tab B must not disturb (or masquerade as) tab A's state.
   * A tool call spans SEVERAL daemon round-trips (act + auto-snapshot +
   * resolve_ref probes …), so events from every hop merge here and ride out
   * once on the tool's final envelope, tabId-stamped. Standing states
   * (fileChooser / attachBlocked) overwrite per tab — the extension re-stamps
   * them on every response, so the latest copy is always current.
   */
  private pendingEnv = new Map<TabId, TabEnvState>();

  constructor(
    endpoint: { port: number; token: string },
    readonly agentLabel: string | undefined,
    private readonly ensureDaemonFn: () => Promise<{
      port: number;
      token: string;
    }>,
  ) {
    this._endpoint = endpoint;
    this.sessionId = randomBytes(8).toString("hex");
  }

  async connect(): Promise<void> {
    this.socket = createConnection(this._endpoint.port, "127.0.0.1");
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk) => this.handleData(chunk));
    // Per-socket: each respawn replaces `this.socket` and gets its own close handler.
    // Old socket's close fires before recover()'s new `connect` resolves, so a stale
    // close cannot drain entries that were registered after recovery completed.
    // Draining pending here is the fail-fast contract — in-flight callers reject with
    // "daemon connection lost" instead of hanging forever on a dead resolver.
    this.socket.on("close", () => {
      this.connected = false;
      if (this.pending.size > 0) {
        const drained = Array.from(this.pending.values());
        this.pending.clear();
        const err = { ok: false, error: "daemon connection lost" } as const;
        for (const resolve of drained) {
          resolve(err as unknown as BridgeResponse);
        }
        console.error(
          `[browser-automation-mcp] daemon socket closed; drained ${drained.length} in-flight request(s)`,
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", () => resolve());
      this.socket!.once("error", reject);
    });
    this.connected = true;
    await this.sendOnce({
      type: "subscribe",
      sessionId: this.sessionId,
      agentLabel: this.agentLabel,
      token: this._endpoint.token,
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    }
  }

  async send(req: DistributiveOmit<BridgeRequest, "id">): Promise<unknown> {
    if (!this.connected) await this.recover();
    try {
      return await this.sendOnce(req);
    } catch (err) {
      if (this.isConnectionError(err) && !this.connected) {
        await this.recover();
        return await this.sendOnce(req);
      }
      // Narrow extension-not-connected retry: the extension service worker
      // sleeps aggressively and the first call after a long idle window can
      // race the reconnect. One ~500ms retry recovers transparently; if the
      // retry also fails, propagate the error with the recovery hint intact.
      // MV3 SW cold-wake is empirically ~300-400ms — 500ms leaves headroom
      // without making the warm-path noticeably slower.
      if (this.isExtensionDisconnect(err)) {
        await new Promise((r) => setTimeout(r, 500));
        return await this.sendOnce(req);
      }
      throw err;
    }
  }

  private isExtensionDisconnect(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const kind = (err as { kind?: string }).kind;
    if (kind === "extension_disconnected") return true;
    const msg = (err as { message?: string }).message ?? "";
    return msg === "extension not connected";
  }

  /**
   * Fold one exec response's env into ITS TAB's accumulator. Events concat
   * (each is a drained one-shot — never re-sent). Standing states are
   * replaced WHOLESALE by the newest response for that tab: the extension
   * re-stamps them on every response while the condition holds, so their
   * absence on a fresh exec env (or an env-less exec response) means the
   * condition cleared — for that tab only.
   */
  private noteEnv(tabId: TabId, env: TabEnvState | undefined): void {
    const prior = this.pendingEnv.get(tabId);
    const events = [...(prior?.events ?? []), ...(env?.events ?? [])];
    if (!events.length && !env?.fileChooser && !env?.attachBlocked) {
      this.pendingEnv.delete(tabId);
      return;
    }
    this.pendingEnv.set(tabId, {
      ...(events.length ? { events } : {}),
      ...(env?.fileChooser ? { fileChooser: env.fileChooser } : {}),
      ...(env?.attachBlocked ? { attachBlocked: env.attachBlocked } : {}),
    });
  }

  /**
   * Consume-once: everything accumulated since the last take, tabId-stamped,
   * for the tool envelope. Single object when one tab reported (the common
   * case), array when several did.
   */
  takeEnv(): EnvReport | undefined {
    if (this.pendingEnv.size === 0) return undefined;
    const all = [...this.pendingEnv.entries()].map(([tabId, env]) => ({
      tabId,
      ...env,
    }));
    this.pendingEnv.clear();
    return all.length === 1 ? all[0] : all;
  }

  /** Non-consuming look at one tab's accumulated env (e.g. snapshot NOTE lead). */
  peekEnv(tabId: TabId): TabEnvState | undefined {
    return this.pendingEnv.get(tabId);
  }

  private sendOnce(
    req: DistributiveOmit<BridgeRequest, "id">,
  ): Promise<unknown> {
    const id = randomBytes(8).toString("hex");
    const full = { id, ...req } as BridgeRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        // Env riding on the daemon response (exec only). Both paths — an
        // errored action still surfaces what happened in the environment.
        if (req.type === "exec") this.noteEnv(req.tabId, msg.env);
        if (msg.ok) resolve(msg.result);
        else {
          const err: any = new Error(msg.error);
          err.leasedBy = msg.leasedBy;
          err.since = msg.since;
          err.hint = msg.hint;
          err.recovery = msg.recovery;
          err.kind = msg.kind;
          reject(err);
        }
      });
      if (!this.connected || !this.socket) {
        this.pending.delete(id);
        reject(new Error("daemon not connected"));
        return;
      }
      try {
        this.socket.write(JSON.stringify(full) + "\n");
      } catch (writeErr) {
        this.pending.delete(id);
        reject(writeErr);
      }
    });
  }

  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.message === "daemon connection lost") return true;
    if (err.message === "daemon not connected") return true;
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPIPE" || code === "ECONNRESET" || code === "ECONNREFUSED";
  }

  private async recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = (async () => {
      try {
        const fresh = await this.ensureDaemonFn();
        this._endpoint = fresh;
        await this.connect();
      } finally {
        this.recoveryPromise = null;
      }
    })();
    return this.recoveryPromise;
  }

  exec(tabId: TabId, command: ExtCommand): Promise<unknown> {
    return this.send({ type: "exec", tabId, command });
  }

  close(): void {
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
  }
}
