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
import { saveToPathSchema, saveTreeToPathSchema } from "./save";

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
          "standard (default) = the semantic tree — interactive/nav/data/table nodes plus every " +
            "named node; full = the entire a11y tree including unnamed structural wrappers.",
        ),
      limit: z
        .coerce.number()
        .int()
        .min(1)
        .max(5000)
        .default(1500)
        .describe(
          "Max nodes returned. The tree is kept in document order and losslessly compacted; " +
            "when it still exceeds this limit the snapshot first retries scoped to the viewport " +
            "(meta.viewport_fallback), then cuts at the limit in document order (meta.truncated " +
            "names the first omitted ref). Every reduction is loud — a NOTE line lists the exact " +
            "recovery levers (raise limit / scope / viewportOnly / save_tree_to_path).",
        ),
      viewportOnly: z
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe(
          "Restrict the snapshot to the visible viewport. Default false — the tree spans the whole " +
            "page (auto-falling back to the viewport only when the page exceeds `limit`, surfaced as " +
            "`meta.viewport_fallback`). Pass `true` to force viewport-only unconditionally.",
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
      scope: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Snapshot only the subtree rooted at this ref (from a prior snapshot of the SAME tab) — " +
            "the drill-down lever when a page is too large or you only care about one region/table/row. " +
            "limit and viewportOnly apply within the scope. Per-call only: never carried into " +
            "auto-snapshots, and a scoped snapshot does not disturb the action-diff baseline. " +
            "For an fN: ref inside a cross-origin frame, pass includeCrossOriginFrames:true on the same call.",
        ),
      save_to_path: saveToPathSchema,
      save_tree_to_path: saveTreeToPathSchema,
      includeCrossOriginFrames: z
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe(
          "Descend cross-origin iframes (OOPIFs) and splice their content into the tree with " +
            "`fN:`-namespaced refs (e.g. `f1:5`) you can click/type like any other ref. Default false — " +
            "a normal snapshot shows a cross-origin frame as a single `[cross-origin frame — not descended]` " +
            "leaf. Set true for SCORM/embedded-app frames (e.g. a course player hosted on another domain). " +
            "Costs extra injection per frame; replayed on auto-snapshots until you set it false.",
        ),
    },
    handler: async ({
      tabId,
      detail,
      limit,
      viewportOnly,
      screenshot,
      quality,
      maxWidth,
      scope,
      save_to_path,
      save_tree_to_path,
      includeCrossOriginFrames,
    }) => {
      const target = tabId ?? ctx.session.lastLeasedTab;
      if (!target)
        throw new Error(
          "no leased tab; call browser_switch_tab or browser_open_tab first",
        );
      // Persist params for replaySnapshot's auto-snap pipeline. `scope` and
      // `save_tree_to_path` are NEVER persisted (invariant #39), nor is
      // `save_to_path` (invariant #8) — scoping is a per-call drill-down and
      // saving a per-call opt-in, never session modes.
      updateSnapshotParams(ctx.session, {
        tabId: target,
        detail,
        limit,
        viewportOnly,
        screenshot,
        quality,
        maxWidth,
        includeCrossOriginFrames,
      });
      return runUnifiedCapture(ctx, target, {
        detail,
        limit,
        viewportOnly,
        screenshot,
        quality,
        maxWidth,
        scope,
        save_to_path,
        save_tree_to_path,
        withTree: true,
        includeCrossOriginFrames,
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
