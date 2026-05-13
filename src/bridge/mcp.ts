import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "./client";
import { BridgeSession } from "./session";
import { registerTabTools } from "./tools/tabs";
import { registerObserveTools } from "./tools/observe";
import { registerInteractTools } from "./tools/interact";

const SERVER_INSTRUCTIONS = `Cross-tab control of the user's real Chrome session via a passive MV3 extension.
Tabs operate in the background — no focus theft, no window raise.

Observe-act loop: browser_snapshot returns a pruned a11y tree with stable numeric refs.
Use refs in browser_click / browser_type / etc. Action tools auto-snapshot after.

Lease model: claim a tab with browser_switch_tab (or browser_open_tab auto-claims) before acting.
Multiple agents coexist by holding leases on different tabs. browser_release_tab hands over.`;

export async function startBridge(opts: {
  agentLabel?: string;
  endpoint: { port: number; token: string };
}): Promise<void> {
  const daemon = new DaemonClient(opts.endpoint, opts.agentLabel);
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

  daemon.onNotification((_msg) => {
    // TODO: forward `lease_revoked` / `tab_closed` to the agent via `server.sendNotification` once the MCP SDK's notification API settles. Hook is wired; the call site is the only missing piece.
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
