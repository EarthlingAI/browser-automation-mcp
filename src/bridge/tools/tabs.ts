import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, ToolContext } from "../registry";
import { TabInfo } from "../../protocol";

export function registerTabTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: "browser_list_tabs",
    description:
      "List all open tabs across all browser windows. Returns id, url, title, leasedBy. Lease-free.",
    schema: {
      query: z
        .string()
        .optional()
        .describe("Substring filter on title/URL (case-insensitive)."),
    },
    handler: async ({ query }) =>
      await ctx.daemon.send({ type: "list_tabs", query }),
  });

  registerTool(server, ctx, {
    name: "browser_open_tab",
    description:
      "Open a URL in a new tab and auto-claim the lease. Defaults to background (no focus change).",
    schema: {
      url: z.string().url().describe("URL to open."),
      background: z
        .boolean()
        .default(true)
        .describe(
          "Open without raising the browser window or activating the tab.",
        ),
    },
    handler: async ({ url, background }) => {
      const tab = (await ctx.daemon.send({
        type: "open_tab",
        url,
        background,
      })) as TabInfo;
      ctx.session.lastLeasedTab = tab.id;
      return tab;
    },
  });

  registerTool(server, ctx, {
    name: "browser_close_tab",
    description: "Close a tab by id. Releases the lease.",
    schema: {
      tabId: z.number().int().describe("Tab id from browser_list_tabs."),
    },
    handler: async ({ tabId }) => {
      const r = await ctx.daemon.send({ type: "close_tab", tabId });
      if (ctx.session.lastLeasedTab === tabId)
        ctx.session.lastLeasedTab = undefined;
      return r;
    },
  });

  registerTool(server, ctx, {
    name: "browser_switch_tab",
    description:
      "Claim the lease on an existing tab so this session can act on it. Errors with leasedBy if held; pass force:true with a reason to revoke.",
    schema: {
      tabId: z.number().int().describe("Tab id from browser_list_tabs."),
      force: z
        .boolean()
        .default(false)
        .describe("Revoke another session's lease. Required reason."),
      reason: z
        .string()
        .optional()
        .describe("Why you are revoking. Required when force:true."),
    },
    handler: async ({ tabId, force, reason }) => {
      if (force && !reason) throw new Error("force:true requires reason");
      const r = await ctx.daemon.send({
        type: "switch_tab",
        tabId,
        force,
        reason,
      });
      ctx.session.lastLeasedTab = tabId;
      return r;
    },
  });

  registerTool(server, ctx, {
    name: "browser_release_tab",
    description:
      "Release the lease on a tab so another session can claim. Omit tabId to release all this session's leases.",
    schema: {
      tabId: z
        .number()
        .int()
        .optional()
        .describe("Tab id to release. Omit to release all."),
    },
    handler: async ({ tabId }) => {
      const r = await ctx.daemon.send({ type: "release_tab", tabId });
      if (tabId !== undefined && ctx.session.lastLeasedTab === tabId)
        ctx.session.lastLeasedTab = undefined;
      else if (tabId === undefined) ctx.session.lastLeasedTab = undefined;
      return r;
    },
  });
}
