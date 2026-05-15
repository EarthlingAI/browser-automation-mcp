import { createConnection, Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  BridgeRequest,
  BridgeResponse,
  DistributiveOmit,
  ExtCommand,
  TabId,
} from "../protocol";

type Resolver = (m: BridgeResponse) => void;

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
      // race the reconnect. One ~200ms retry recovers transparently; if the
      // retry also fails, propagate the error with the recovery hint intact.
      if (this.isExtensionDisconnect(err)) {
        await new Promise((r) => setTimeout(r, 200));
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

  private sendOnce(
    req: DistributiveOmit<BridgeRequest, "id">,
  ): Promise<unknown> {
    const id = randomBytes(8).toString("hex");
    const full = { id, ...req } as BridgeRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
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
