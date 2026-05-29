import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, execOnLeasedTab, ToolContext } from "../registry";
import { TabInfo } from "../../protocol";
import { coerceBoolean } from "./coerce";

export function registerTabTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: "browser_list_tabs",
    title: "List browser tabs",
    description:
      "List all open tabs across all browser windows. Returns id, url, title, leasedBy. Lease-free.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      query: z
        .string()
        .optional()
        .describe("Substring filter on title/URL (case-insensitive)."),
    },
    handler: async ({ query }) => {
      const tabs = (await ctx.daemon.send({
        type: "list_tabs",
        query,
      })) as TabInfo[];
      // Annotate each tab with byCurrentSession for direct lease-ownership checks
      // without parsing the agentLabel string.
      const mySessionId = ctx.daemon.sessionId;
      return tabs.map((t) => {
        if (!t.leasedBy) return t;
        return {
          ...t,
          leasedBy: {
            ...t.leasedBy,
            byCurrentSession: t.leasedBy.sessionId === mySessionId,
          },
        };
      });
    },
  });

  registerTool(server, ctx, {
    name: "browser_open_tab",
    title: "Open a new tab",
    description:
      "Open a URL in a new tab and auto-claim the lease. Defaults to background (no focus change). Returns the actual loaded url/title plus a `navigated` flag and a `settledAt` timestamp.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: {
      url: z.string().url().describe("URL to open."),
      background: z
        .preprocess(coerceBoolean, z.boolean().default(true))
        .describe(
          "Open without raising the browser window or activating the tab.",
        ),
    },
    handler: async ({ url, background }) => {
      const tab = (await ctx.daemon.send({
        type: "open_tab",
        url,
        background,
      })) as TabInfo & { navigated?: boolean; settledAt?: number };
      ctx.session.lastLeasedTab = tab.id;
      return tab;
    },
  });

  registerTool(server, ctx, {
    name: "browser_close_tab",
    title: "Close a tab",
    description: "Close a tab by id. Releases the lease.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z.coerce.number().int().describe("Tab id from browser_list_tabs."),
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
    title: "Claim a tab lease",
    description:
      "Claim the lease on an existing tab so this session can act on it. Errors with leasedBy if held; pass force:true with a reason to revoke. Returns the previously-active tab so the agent can restore focus later if desired.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z.coerce.number().int().describe("Tab id from browser_list_tabs."),
      force: z
        .preprocess(coerceBoolean, z.boolean().default(false))
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
    title: "Release tab lease(s)",
    description:
      "Release the lease on a tab so another session can claim. Omit tabId to release all this session's leases.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z
        .coerce.number()
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

  // ─── Activation & focus ───────────────────────────────────────────
  // browser_set_active is the default, transparent rendering fix (CDP focus-emulation:
  // makes a backgrounded tab RENDER faithfully — screenshots/selection/scroll/menus — with
  // no window raise; input reaches the page regardless). browser_bring_to_front is the
  // explicit, rarely-needed real focus-theft (raises the window) for OS pickers / clipboard /
  // drag-drop / native :focus-gated UI.

  registerTool(server, ctx, {
    name: "browser_set_active",
    title: "Resume rendering (focus-emulation)",
    description:
      "Enable CDP focus-emulation on the leased tab so Chrome renders this background tab as if visible+focused — WITHOUT raising the window or stealing the user's focus. Backgrounded canvas SPAs (Google Sheets, Figma, Miro) throttle requestAnimationFrame to ~0fps, so screenshots and on-screen selection/scroll/menu rendering can look stale even though the page's JS model stays live. This restores faithful rendering — useful before a screenshot or for visual verification. It is a rendering/visibility aid, NOT required for input: synthetic events and ordinary actions reach the page regardless. Toggle off with enabled:false. Unnecessary for ordinary DOM pages.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      enabled: z
        .preprocess(coerceBoolean, z.boolean().default(true))
        .describe(
          "true (default) resumes rendering; false turns focus-emulation back off.",
        ),
      tabId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Tab id. Omit to use the current leased tab."),
    },
    handler: async ({ enabled, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "set_focus_emulation", enabled }),
  });

  registerTool(server, ctx, {
    name: "browser_bring_to_front",
    title: "Raise window (steals focus)",
    description:
      "Raise the browser window and activate this tab — this STEALS the user's focus (the only tool that does). Use ONLY for focus-dependent flows that focus-emulation can't satisfy: OS file pickers, clipboard-paste permission prompts, drag-and-drop, native :focus-gated UI. For canvas/rAF rendering issues use browser_set_active instead (no focus theft). Returns previousActiveTab so you can restore the user's prior tab afterward.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Tab id. Omit to use the current leased tab."),
    },
    handler: async ({ tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "bring_to_front" }),
  });
}
