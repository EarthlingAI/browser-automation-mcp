import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  ToolContext,
  execOnLeasedTab,
  populateRefs,
  updateSnapshotParams,
} from "../registry";
import { prune, RawNode } from "../../snapshot/prune";
import { coerceToArray, coerceBoolean } from "./coerce";

export function registerObserveTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  registerTool(server, ctx, {
    name: "browser_snapshot",
    title: "Snapshot the page accessibility tree",
    description:
      "Pruned accessibility-tree snapshot of the leased tab. Returns nodes with stable numeric `ref` IDs to target in interaction tools. Prefer this over screenshot.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z
        .coerce.number()
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
        .coerce.number()
        .int()
        .min(1)
        .max(5000)
        .default(500)
        .describe("Max nodes returned (ranked)."),
      viewportOnly: z
        .preprocess(coerceBoolean, z.boolean().default(true))
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
      const pruned = prune(raw, { limit, viewportOnly, detail });
      populateRefs(ctx.session, pruned, raw, target);
      return pruned;
    },
  });

  registerTool(server, ctx, {
    name: "browser_screenshot",
    title: "Screenshot the leased tab",
    description:
      "Background-tab screenshot via CDP Page.captureScreenshot — never raises the window. Defaults to JPEG quality 70 (typical ~30–50 KB encoded, well within the agent token budget). Use only when the snapshot tree alone is insufficient.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z
        .coerce.number()
        .int()
        .optional()
        .describe("Tab to capture. Defaults to the most recently leased tab."),
      format: z.enum(["png", "jpeg"]).default("jpeg"),
      quality: z
        .coerce.number()
        .int()
        .min(1)
        .max(100)
        .default(70)
        .describe("JPEG quality (1–100). Ignored for PNG."),
      maxWidth: z
        .coerce.number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe(
          "Downscale the captured image to at most this width (preserves aspect ratio). Omit for native viewport resolution.",
        ),
    },
    handler: async ({ tabId, format, quality, maxWidth }) => {
      return execOnLeasedTab(ctx, tabId, {
        kind: "screenshot",
        format,
        quality,
        maxWidth,
      });
    },
  });

  registerTool(server, ctx, {
    name: "browser_console_messages",
    title: "Recent console messages",
    description:
      "Recent console output from the leased tab (log, warn, error). Supports cursor pagination — pass `next_cursor` from a prior call to page back through history.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor from a prior call's next_cursor."),
    },
    handler: async ({ tabId, limit, cursor }) =>
      execOnLeasedTab(ctx, tabId, { kind: "console_messages", limit, cursor }),
  });

  registerTool(server, ctx, {
    name: "browser_network_requests",
    title: "Recent network requests",
    description:
      "Recent network requests from the leased tab (method, URL, status, type, timing). For unfamiliar SPAs, call this first to discover real backend endpoints from xhr/fetch traffic before guessing endpoint paths. Default filter excludes images/scripts/stylesheets — pass `type` explicitly to include them. Supports cursor pagination.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      tabId: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      cursor: z
        .string()
        .optional()
        .describe("Opaque cursor from a prior call's next_cursor."),
      urlPattern: z
        .string()
        .optional()
        .describe(
          "URL filter. Plain string = substring match. Wrap in /…/ to use a regex (e.g. `/\\/api\\/v2\\//`).",
        ),
      type: z
        .preprocess(
          coerceToArray,
          z
            .array(
              z.enum([
                "xmlhttprequest",
                "fetch",
                "image",
                "script",
                "document",
                "stylesheet",
                "other",
              ]),
            )
            .optional(),
        )
        .describe(
          "Resource types to include. Defaults to ['xmlhttprequest','fetch','document'] for API discovery (drops image/script noise).",
        ),
      methodIn: z
        .preprocess(
          coerceToArray,
          z
            .array(
              z.enum([
                "GET",
                "POST",
                "PUT",
                "DELETE",
                "PATCH",
                "OPTIONS",
                "HEAD",
              ]),
            )
            .optional(),
        )
        .describe("HTTP methods to include. Omit to include all."),
      statusGte: z
        .coerce.number()
        .int()
        .optional()
        .describe("Include only responses with status >= statusGte."),
      statusLt: z
        .coerce.number()
        .int()
        .optional()
        .describe("Include only responses with status < statusLt."),
    },
    handler: async ({
      tabId,
      limit,
      cursor,
      urlPattern,
      type,
      methodIn,
      statusGte,
      statusLt,
    }) =>
      execOnLeasedTab(ctx, tabId, {
        kind: "network_requests",
        limit,
        cursor,
        urlPattern,
        type,
        methodIn,
        statusGte,
        statusLt,
      }),
  });
}
