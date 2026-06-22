import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  registerActionTool,
  execOnLeasedTab,
  ToolContext,
} from "../registry";
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
      "Claim the lease on an existing tab so this session can act on it. Errors with leasedBy if held; pass force:true with a reason to revoke. Returns the previously-active tab so the agent can restore focus later if desired. Call browser_release_tab when you finish controlling the tab so other sessions can claim it.",
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
  // browser_activate_tab exposes an ordered visibility spectrum over the leased
  // tab. "background"/"render" route to CDP focus-emulation (no window raise, no
  // focus theft); "foreground" is the SOLE sanctioned focus-steal (raises the
  // window). This is a tool-layer surface only — the ExtCommand kinds
  // (set_focus_emulation / bring_to_front) and the invariant #1/#2/#29
  // enforcement point in background.js are unchanged.

  registerTool(server, ctx, {
    name: "browser_activate_tab",
    title: "Set tab visibility level (render / focus)",
    description:
      "Set the visibility level of the leased tab along an ordered spectrum. " +
      '"background" — drop focus-emulation; the tab returns to Chrome\'s natural background throttling (~0fps requestAnimationFrame). ' +
      '"render" (default) — enable CDP focus-emulation so a backgrounded canvas SPA (Google Sheets, Figma, Miro) renders as if visible+focused, WITHOUT raising the window or stealing focus. Screenshots and on-screen selection/scroll/menu rendering become faithful. This is a rendering/visibility aid, NOT an input precondition — synthetic events and ordinary actions reach the page regardless. ' +
      '"foreground" — the SOLE focus-steal: genuinely raises the browser window and activates the tab, stealing the user\'s focus. Reserve for focus-dependent flows emulation can\'t satisfy: OS file pickers, clipboard-paste permission prompts, drag-and-drop, native :focus-gated UI. Returns previousActiveTab so you can restore the user\'s prior tab afterward. ' +
      'Most canvas/rendering needs are met by "render" — only escalate to "foreground" when a native focus gate truly requires it.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      level: z
        .enum(["background", "render", "foreground"])
        .default("render")
        .describe(
          'Ordered visibility level. "background" = drop focus-emulation (natural throttling); ' +
            '"render" (default) = focus-emulation on (faithful rendering, no window raise, no focus theft); ' +
            '"foreground" = raise the window and steal focus (the only level that does).',
        ),
      tabId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Tab id. Omit to use the current leased tab."),
    },
    handler: async ({ level, tabId }) => {
      const cmd =
        level === "foreground"
          ? ({ kind: "bring_to_front" } as const)
          : ({ kind: "set_focus_emulation", enabled: level === "render" } as const);
      return execOnLeasedTab(ctx, tabId, cmd);
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_resize",
    title: "Resize the tab viewport",
    description:
      "Resize the leased tab's viewport to width×height CSS pixels via CDP device-metrics emulation — WITHOUT raising the window or stealing focus (same debugger-scoped infra as browser_activate_tab render mode). window.innerWidth/Height, media queries, and responsive layout reflect the new size, so you can exercise mobile/tablet/desktop breakpoints. The override is sticky per tab (re-asserted across an action sequence) and clears on tab close or extension reload. Auto-snapshots the reflowed layout.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      width: z
        .coerce.number()
        .int()
        .min(1)
        .max(16384)
        .describe("Viewport width in CSS pixels."),
      height: z
        .coerce.number()
        .int()
        .min(1)
        .max(16384)
        .describe("Viewport height in CSS pixels."),
      tabId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Tab id. Omit to use the current leased tab."),
    },
    handler: async ({ width, height, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "resize", width, height }),
  });

  registerTool(server, ctx, {
    name: "browser_handle_dialog",
    title: "Pre-arm a response to the next native JS dialog",
    description:
      "Pre-arm an auto-response for the leased tab's next native JS dialog (alert / confirm / prompt / beforeunload). " +
      "Call BEFORE the action that triggers the dialog — typically right before a browser_click on a button you know fires a confirm. " +
      'Set disposition to "accept" or "dismiss"; pass promptText to fill a prompt() dialog\'s input. ' +
      'lifetime "one_shot" (default) clears the disposition after the next dialog fires; "sticky" persists across multiple dialogs until you call again with clear:true. ' +
      "Once cleared, dialogs revert to Chrome's default behaviour (it auto-dismisses, generally). " +
      "Pass clear:true (xor with disposition) to disarm an existing handler. " +
      "Uses CDP Page.javascriptDialogOpening + Page.handleJavaScriptDialog under the hood — no window raise, no focus theft.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      disposition: z
        .enum(["accept", "dismiss"])
        .optional()
        .describe(
          'How to answer the next dialog. "accept" clicks OK; "dismiss" clicks Cancel. Omit when clearing.',
        ),
      promptText: z
        .string()
        .optional()
        .describe(
          'Text to enter into a prompt() dialog before accepting. Ignored for alert/confirm/beforeunload. Only meaningful with disposition:"accept".',
        ),
      lifetime: z
        .enum(["one_shot", "sticky"])
        .default("one_shot")
        .describe(
          '"one_shot" (default) — auto-clear after the next dialog fires. "sticky" — persist until you call again with clear:true (useful for "spam-confirm everything in this flow").',
        ),
      clear: z
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe(
          "Disarm any existing handler on this tab. Mutually exclusive with disposition.",
        ),
      tabId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Tab id. Omit to use the current leased tab."),
    },
    handler: async ({ disposition, promptText, lifetime, clear, tabId }) => {
      // xor validation BEFORE any daemon hop: caller must arm xor clear.
      if (clear && disposition !== undefined) {
        throw new Error(
          "handle_dialog: pass either `disposition` (to arm) or `clear:true` (to disarm), not both.",
        );
      }
      if (!clear && disposition === undefined) {
        throw new Error(
          'handle_dialog: pass `disposition:"accept"|"dismiss"` to arm, or `clear:true` to disarm.',
        );
      }
      // Mirror CP6's `f.kind ?? "type"` / CP7's `mechanism ?? "auto"` pattern so
      // zod-bypassing tests (which skip the schema default) still see the
      // documented default on the wire.
      const effectiveLifetime = lifetime ?? "one_shot";
      const cmd = clear
        ? ({ kind: "handle_dialog", clear: true } as const)
        : ({
            kind: "handle_dialog",
            disposition,
            ...(promptText !== undefined ? { promptText } : {}),
            lifetime: effectiveLifetime,
          } as const);
      return execOnLeasedTab(ctx, tabId, cmd);
    },
  });
}
