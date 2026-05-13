import { createConnection, Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  BridgeRequest,
  BridgeResponse,
  BridgeNotification,
  DistributiveOmit,
  ExtCommand,
  TabId,
} from "../protocol";

type Resolver = (m: BridgeResponse) => void;
export type NotificationHandler = (m: BridgeNotification) => void;

export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, Resolver>();
  private notifyHandlers = new Set<NotificationHandler>();
  readonly sessionId: string;
  private connected = false;

  constructor(
    readonly endpoint: { port: number; token: string },
    readonly agentLabel?: string,
  ) {
    this.sessionId = randomBytes(8).toString("hex");
  }

  onNotification(handler: NotificationHandler): void {
    this.notifyHandlers.add(handler);
  }

  async connect(): Promise<void> {
    this.socket = createConnection(this.endpoint.port, "127.0.0.1");
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("close", () => {
      this.connected = false;
    });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("connect", () => resolve());
      this.socket!.once("error", reject);
    });
    this.connected = true;
    await this.send({
      type: "subscribe",
      sessionId: this.sessionId,
      agentLabel: this.agentLabel,
      token: this.endpoint.token,
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
      } else if (msg.type) {
        for (const h of this.notifyHandlers) h(msg);
      }
    }
  }

  send(req: DistributiveOmit<BridgeRequest, "id">): Promise<unknown> {
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
          reject(err);
        }
      });
      if (!this.connected || !this.socket) {
        reject(new Error("daemon not connected"));
        return;
      }
      this.socket.write(JSON.stringify(full) + "\n");
    });
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
