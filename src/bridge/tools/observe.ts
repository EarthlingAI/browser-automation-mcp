import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerTool,
  ToolContext,
  execOnLeasedTab,
  updateSnapshotParams,
} from "../registry";
import { coerceToArray, coerceBoolean } from "./coerce";
import { runUnifiedCapture } from "./capture";
import { saveToPathSchema } from "./save";

export function registerObserveTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  registerTool(server, ctx, {
    name: "browser_snapshot",
    title: "Snapshot the page accessibility tree (optionally with screenshot)",
    description:
      "Pruned accessibility-tree snapshot of the leased tab. Returns nodes with stable numeric `ref` IDs " +
      "to target in interaction tools. `screenshot` is tri-state: \"off\" (default, tree only), " +
      "\"annotated\" (tree + native MCP image content block with each element's numeric ref badged on the live page), " +
      "or \"raw\" (tree + clean pixels with no badges — for saving artifacts or showing the page as the user sees it). " +
      "Once `\"annotated\"` or `\"raw\"` is set, every subsequent action-tool auto-snapshot automatically carries " +
      "the image forward in the same mode (no extra call needed). Costs ~150–250 ms per action when screenshot " +
      "mode is on; pass `screenshot:\"off\"` on the next call to drop back to tree-only.",
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
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe(
          "Restrict snapshot to the visible viewport. Default false — return the whole page's " +
            "intelligently-pruned tree (ranked + capped at `limit`). When the page exceeds 3 × `limit` " +
            "candidate nodes the snapshot auto-falls-back to viewport-only and surfaces " +
            "`meta.viewport_fallback`. Pass `true` to force viewport-only unconditionally.",
        ),
      screenshot: z
        .enum(["off", "annotated", "raw"])
        .default("off")
        .describe(
          "Screenshot mode. \"off\" (default) — tree only, no image. " +
            "\"annotated\" — tree + image with each ref's numeric badge painted on its element " +
            "(vision-ready; what you want when planning the next action). " +
            "\"raw\" — tree + clean pixels with no badges (for saving a chart, capturing an artifact, " +
            "or showing the page as the user sees it). Once set to \"annotated\" or \"raw\", every " +
            "subsequent action-tool auto-snapshot returns the image in the same mode — set back to \"off\" to drop it.",
        ),
      // Image format is not an agent-facing arg — it follows `save_to_path`'s
      // extension when a string (".png" → PNG, ".jpg/.jpeg" → JPEG); defaults
      // to JPEG when no save is requested or when save_to_path:true (which
      // auto-names ".jpg"). See save.ts::resolveSavePath.
      quality: z
        .coerce.number()
        .int()
        .min(1)
        .max(100)
        .default(70)
        .describe(
          "JPEG quality (1–100). Ignored for PNG saves. Applies to inline (always JPEG) and to any `.jpg`/`.jpeg` save target.",
        ),
      maxWidth: z
        .coerce.number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe(
          "Downscale the screenshot to at most this width (preserves aspect ratio).",
        ),
      save_to_path: saveToPathSchema,
    },
    handler: async ({
      tabId,
      detail,
      limit,
      viewportOnly,
      screenshot,
      quality,
      maxWidth,
      save_to_path,
    }) => {
      const target = tabId ?? ctx.session.lastLeasedTab;
      if (!target)
        throw new Error(
          "no leased tab; call browser_switch_tab or browser_open_tab first",
        );
      // Persist params for replaySnapshot's auto-snap pipeline. save_to_path
      // is NEVER persisted — saving is per-call opt-in, never a session mode.
      updateSnapshotParams(ctx.session, {
        tabId: target,
        detail,
        limit,
        viewportOnly,
        screenshot,
        quality,
        maxWidth,
      });
      return runUnifiedCapture(ctx, target, {
        detail,
        limit,
        viewportOnly,
        screenshot,
        quality,
        maxWidth,
        save_to_path,
        withTree: true,
      });
    },
  });

  registerTool(server, ctx, {
    name: "browser_screenshot",
    title: "[DEPRECATED — use browser_snapshot(screenshot:\"raw\")] Screenshot the leased tab",
    description:
      "DEPRECATED — superseded by `browser_snapshot(screenshot:\"raw\")` which returns clean pixels " +
      "alongside the a11y tree from one call. This tool will be removed in an upcoming release. " +
      "Background-tab screenshot via CDP `Page.captureScreenshot` — never raises the window. " +
      "Returns the image as a native MCP image content block. Format follows `save_to_path`'s file " +
      "extension when a string (\".png\" → PNG, \".jpg/.jpeg\" → JPEG); defaults to JPEG otherwise.",
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
      // Image format is not an agent-facing arg — follows `save_to_path`'s
      // extension when a string; defaults to JPEG otherwise.
      quality: z
        .coerce.number()
        .int()
        .min(1)
        .max(100)
        .default(70)
        .describe(
          "JPEG quality (1–100). Ignored for PNG saves. Applies to inline (always JPEG) and to any `.jpg`/`.jpeg` save target.",
        ),
      maxWidth: z
        .coerce.number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe(
          "Downscale the captured image to at most this width (preserves aspect ratio).",
        ),
      save_to_path: saveToPathSchema,
    },
    handler: async ({ tabId, quality, maxWidth, save_to_path }) => {
      const target = tabId ?? ctx.session.lastLeasedTab;
      if (!target)
        throw new Error(
          "no leased tab; call browser_switch_tab or browser_open_tab first",
        );
      // Implementation: route through the same unified pipeline that
      // browser_snapshot(screenshot:"raw") would use, but with withTree:false
      // so the legacy contract (no tree in the payload) is preserved until
      // the tool is removed.
      return runUnifiedCapture(ctx, target, {
        detail: "standard",
        limit: 0,
        viewportOnly: true,
        screenshot: "raw",
        quality,
        maxWidth,
        save_to_path,
        withTree: false,
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
