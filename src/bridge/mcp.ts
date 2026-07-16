import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { DaemonClient } from "./client";
import { BridgeSession } from "./session";
import { registerTabTools } from "./tools/tabs";
import { registerObserveTools } from "./tools/observe";
import { registerInteractTools } from "./tools/interact";
import { registerNetTools } from "./tools/net";
import { BUILD_STAMP, SERVER_INSTRUCTIONS } from "./meta";

export interface BridgeOptions {
  agentLabel?: string;
  endpoint: { port: number; token: string };
  ensureDaemonFn: () => Promise<{ port: number; token: string }>;
}

async function buildServer(opts: BridgeOptions): Promise<{ server: McpServer; daemon: DaemonClient }> {
  const daemon = new DaemonClient(opts.endpoint, opts.agentLabel, opts.ensureDaemonFn);
  await daemon.connect();
  const session = new BridgeSession();
  const ctx = { daemon, session };
  const server = new McpServer(
    { name: "browser-automation-mcp", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTabTools(server, ctx);
  registerObserveTools(server, ctx);
  registerInteractTools(server, ctx);
  registerNetTools(server, ctx);
  return { server, daemon };
}

export async function startBridge(opts: BridgeOptions): Promise<void> {
  // Stderr only — the stamp must never enter SERVER_INSTRUCTIONS (hosts inject
  // instructions into the model's system prefix; a per-build value there would
  // bust the host's prompt cache on every rebuild).
  console.error(`[browser-automation-mcp] build ${BUILD_STAMP}`);
  const mode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (mode === "http") {
    await startHttp(opts);
    return;
  }
  const { server } = await buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(opts: BridgeOptions): Promise<void> {
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const portRaw = process.env.MCP_HTTP_PORT;
  const port = Number(portRaw);
  if (!portRaw || Number.isNaN(port)) {
    throw new Error("MCP_HTTP_PORT must be a valid port number when MCP_TRANSPORT=http");
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      if (req.method === "POST") {
        await handlePost(req, res, transports, opts);
      } else if (req.method === "GET" || req.method === "DELETE") {
        await handleSession(req, res, transports);
      } else {
        res.statusCode = 405;
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (err as Error).message } }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function isInitializeBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const arr = Array.isArray(body) ? body : [body];
  return arr.some((m) => m && typeof m === "object" && (m as { method?: string }).method === "initialize");
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
  opts: BridgeOptions,
): Promise<void> {
  const body = await readBody(req);
  const sid = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sid) ? sid[0] : sid;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, body);
    return;
  }

  if (!sessionId && isInitializeBody(body)) {
    // Per-MCP-session: a fresh McpServer + DaemonClient + BridgeSession so each agent gets its own daemon-side lease scope. Closing the transport closes the daemon socket, which auto-releases that session's leases (see daemon/server.ts socket close handler).
    const { server, daemon } = await buildServer(opts);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
      daemon.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Bad Request: missing or unknown Mcp-Session-Id" },
      id: null,
    }),
  );
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  const sid = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sid) ? sid[0] : sid;
  if (!sessionId || !transports.has(sessionId)) {
    res.statusCode = 400;
    res.end();
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}
