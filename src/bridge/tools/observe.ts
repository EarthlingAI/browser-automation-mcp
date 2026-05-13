import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  ToolContext,
  execOnLeasedTab,
  updateSnapshotParams,
} from "../registry";
import { prune, RawNode } from "../../snapshot/prune";

export function registerObserveTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  registerTool(server, ctx, {
    name: "browser_snapshot",
    description:
      "Pruned accessibility-tree snapshot of the leased tab. Returns nodes with stable numeric `ref` IDs to target in interaction tools. Prefer this over screenshot.",
    schema: {
      tabId: z
        .number()
        .int()
        .optional()
        .describe("Tab to snapshot. Defaults to the most recently leased tab."),
      detail: z
        .enum(["standard", "full"])
        .default("standard")
        .describe(
          "standard = interactive elements only; full = entire a11y tree.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(500)
        .describe("Max nodes returned (ranked)."),
      viewportOnly: z
        .boolean()
        .default(true)
        .describe("Exclude nodes outside the visible viewport."),
    },
    handler: async ({ tabId, detail, limit, viewportOnly }) => {
      const target = tabId ?? ctx.session.lastLeasedTab;
      if (!target)
        throw new Error(
          "no leased tab; call browser_switch_tab or browser_open_tab first",
        );
      updateSnapshotParams(ctx.session, {
        tabId: target,
        detail,
        limit,
        viewportOnly,
        screenshot: false,
      });
      const raw = (await ctx.daemon.exec(target, {
        kind: "snapshot",
        viewportOnly,
        limit,
      })) as RawNode;
      return prune(raw, { limit, viewportOnly, detail });
    },
  });

  registerTool(server, ctx, {
    name: "browser_screenshot",
    description:
      "PNG screenshot of the leased tab. Background-tab capture uses CDP Page.captureScreenshot — never raises the window. Use only when the snapshot tree alone is insufficient.",
    schema: {
      tabId: z
        .number()
        .int()
        .optional()
        .describe("Tab to capture. Defaults to the most recently leased tab."),
      format: z.enum(["png", "jpeg"]).default("png"),
      quality: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("JPEG quality (1-100)."),
    },
    handler: async ({ tabId, format, quality }) => {
      return execOnLeasedTab(ctx, tabId, {
        kind: "screenshot",
        format,
        quality,
      });
    },
  });

  registerTool(server, ctx, {
    name: "browser_console_messages",
    description:
      "Recent console output from the leased tab (log, warn, error).",
    schema: {
      tabId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    handler: async ({ tabId, limit }) =>
      execOnLeasedTab(ctx, tabId, { kind: "console_messages", limit }),
  });

  registerTool(server, ctx, {
    name: "browser_network_requests",
    description:
      "Recent network requests from the leased tab. Method, URL, status, timing.",
    schema: {
      tabId: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    handler: async ({ tabId, limit }) =>
      execOnLeasedTab(ctx, tabId, { kind: "network_requests", limit }),
  });
}
