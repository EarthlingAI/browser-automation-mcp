/**
 * Unified capture orchestrator — the single core of every "look at the page"
 * call in this MCP. Shared by:
 *
 *   - `browser_snapshot`        (observe.ts)     — withTree:true,  withScreenshot:configurable
 *   - `browser_screenshot`      (observe.ts)     — withTree:false, withScreenshot:true
 *   - `replaySnapshot` auto-snap (registry.ts)    — replays the last params, save_to_path always off
 *
 * Two extension hops:
 *
 *   1. `snapshot_capture` — atomic tree + screenshot in one debugger cycle.
 *      Eliminates the layout-shift race a sequential snapshot-then-screenshot
 *      would have on SPAs (Suno, ChatGPT) that fire hydration mid-call.
 *
 *   2. `annotate_image` (conditional) — only fired when there's a tree AND
 *      `lastSnapshotRefs` is populated, so the badges actually have refs to
 *      paint. Annotation runs in the SW's OffscreenCanvas (no page injection,
 *      no CSP exposure).
 *
 * Returns a `CaptureResult` shape: `{ payload, image? }`. `registry.ts`'s
 * `registerTool` wrapper detects the shape and extracts the image into a
 * native MCP image content block alongside the text payload.
 */

import { prune, RawNode } from "../../snapshot/prune";
import type { TabId } from "../../protocol";
import {
  type ImagePayload,
  populateRefs,
  type ToolContext,
} from "../registry";
import { computeDrawStroke } from "./containment";
import { resolveSavePath, writeImage } from "./save";
import { VISUAL_CONSTANTS } from "./visual";

export interface CaptureOpts {
  detail: "standard" | "full";
  limit: number;
  viewportOnly: boolean;
  screenshot: boolean;
  // No `format` here — Round 7 removed the agent-facing param. Format is
  // derived from `save_to_path`'s file extension when a string; otherwise
  // defaults to JPEG (see save.ts::resolveSavePath).
  quality: number;
  maxWidth?: number;
  /** false → no save (default). true → auto-named in outputs_dir. String → explicit path. */
  save_to_path: boolean | string;
  /** False for standalone `browser_screenshot` — skip the tree walk entirely. */
  withTree: boolean;
}

export interface CaptureResult {
  /** Goes into the text content block. */
  payload: Record<string, unknown>;
  /** Goes into the image content block. Omitted when no screenshot was requested. */
  image?: ImagePayload;
}

interface SnapshotCaptureResponse {
  tree?: RawNode;
  screenshot?: {
    format: "png" | "jpeg";
    dataBase64: string;
    resizedTo?: { width: number; height: number };
  };
  /** Set only when `withTree:true`; the annotation hop reads it. The
   * `withTree:false` standalone path doesn't need DPR — no rect scaling. */
  dpr?: number;
}

interface AnnotateImageResponse {
  format: "png" | "jpeg";
  dataBase64: string;
  resizedTo?: { width: number; height: number };
}

export async function runUnifiedCapture(
  ctx: ToolContext,
  tabId: TabId,
  opts: CaptureOpts,
): Promise<CaptureResult> {
  // Round 7: format is no longer an agent-facing arg. Resolve it (and the
  // optional save path) up-front so the same value flows into both extension
  // hops (snapshot_capture chooses the encoder; annotate_image preserves it)
  // AND into the optional disk write at the end. A bad save_to_path string
  // throws here — short-circuit BEFORE any extension hop so the agent gets
  // a fast error instead of paying for an unused screenshot.
  let savePath: string | null = null;
  let format: "png" | "jpeg";
  let resolveError: string | undefined;
  try {
    const resolved = resolveSavePath(opts.save_to_path, tabId);
    savePath = resolved.path;
    format = resolved.format;
  } catch (err: any) {
    // Save errors must stay non-fatal — the image still returns inline. Stash
    // the message for the response and pick the default format for the
    // capture itself. (Pre-Round-7 traversal rejection had the same contract.)
    resolveError = err?.message ?? String(err);
    format = "jpeg";
  }

  // Hop 1: atomic snapshot + screenshot.
  const captureResp = (await ctx.daemon.exec(tabId, {
    kind: "snapshot_capture",
    withTree: opts.withTree,
    withScreenshot: opts.screenshot,
    viewportOnly: opts.viewportOnly,
    limit: opts.limit,
    format,
    quality: opts.quality,
    maxWidth: opts.maxWidth,
  })) as SnapshotCaptureResponse;

  const payload: Record<string, unknown> = {};
  // Gate annotation on a tree that we just populated THIS call. Without the
  // flag, an extension hiccup that returned `screenshot` but no `tree` would
  // re-use stale refs from a prior snapshot and paint badges onto the wrong
  // bitmap — misleading rather than crashing.
  let justPopulated = false;

  if (opts.withTree && captureResp.tree) {
    const prunedTree = prune(captureResp.tree, {
      limit: opts.limit,
      viewportOnly: opts.viewportOnly,
      detail: opts.detail,
    });
    populateRefs(ctx.session, prunedTree, captureResp.tree, tabId);
    payload.tree = prunedTree;
    justPopulated = true;
  }

  let imageBase64 = captureResp.screenshot?.dataBase64;
  let imageFormat: "png" | "jpeg" =
    captureResp.screenshot?.format ?? format;
  let resizedTo = captureResp.screenshot?.resizedTo;

  // Hop 2 (conditional): annotate. Skip when there are no refs to badge —
  // a graceful no-op rather than an empty-rects round trip.
  if (
    opts.screenshot &&
    imageBase64 &&
    justPopulated &&
    ctx.session.lastSnapshotRefs.size > 0
  ) {
    const rawRects: Array<{
      ref: string;
      rect: { x: number; y: number; w: number; h: number };
    }> = [];
    for (const [ref, meta] of ctx.session.lastSnapshotRefs) {
      if (!meta.rect) continue;
      rawRects.push({ ref, rect: meta.rect });
    }
    if (rawRects.length > 0) {
      // Containment-based parent suppression. A rect that fully contains
      // another annotated rect gets `drawStroke:false` so the extension only
      // draws the badge, not the giant outer border. See containment.ts.
      const drawStrokeFlags = computeDrawStroke(rawRects);
      const rects = rawRects.map((r, i) => ({
        ...r,
        drawStroke: drawStrokeFlags[i]!,
      }));
      const annotated = (await ctx.daemon.exec(tabId, {
        kind: "annotate_image",
        imageBase64,
        format: imageFormat,
        quality: opts.quality,
        rects,
        dpr: captureResp.dpr ?? 1,
        maxWidth: opts.maxWidth,
        constants: { ...VISUAL_CONSTANTS },
      })) as AnnotateImageResponse;
      imageBase64 = annotated.dataBase64;
      imageFormat = annotated.format;
      resizedTo = annotated.resizedTo ?? resizedTo;
    }
  }

  if (opts.screenshot && imageBase64) {
    payload.format = imageFormat;
    if (resizedTo) payload.resizedTo = resizedTo;
    // Save errors must never break the response — the image still returns
    // inline; the failure surfaces as a `saveError` field so the agent can
    // recover (try a different path, drop the save, etc.). Covers both
    // resolve-time errors (bad path, ".." segment, unknown extension when
    // somehow the schema didn't catch it) and write-time errors.
    if (resolveError) {
      payload.saveError = resolveError;
    } else if (savePath) {
      try {
        writeImage(savePath, imageBase64);
        payload.savedTo = savePath;
      } catch (err: any) {
        payload.saveError = err?.message ?? String(err);
      }
    }
    return {
      payload,
      image: {
        data: imageBase64,
        mimeType: imageFormat === "jpeg" ? "image/jpeg" : "image/png",
      },
    };
  }

  return { payload };
}
