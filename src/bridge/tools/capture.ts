/**
 * Unified capture orchestrator — the single core of every "look at the page"
 * call in this MCP. Shared by:
 *
 *   - `browser_snapshot`        (observe.ts)    — withTree:true; capture hop fires
 *                                                  when `screenshot !== "off"`.
 *   - `replaySnapshot` auto-snap (registry.ts)   — replays the last params verbatim
 *                                                  (withTree:true); save_to_path always off.
 *
 * The `withTree:false` path (tree-less raw capture) is still supported by this
 * function but has no tool caller today — kept as a deliberate capability of the
 * capture contract and pinned by a direct test in `replay.test.mjs`.
 *
 * Two extension hops:
 *
 *   1. `snapshot_capture` — atomic tree + screenshot in one debugger cycle.
 *      Eliminates the layout-shift race a sequential snapshot-then-screenshot
 *      would have on SPAs (Suno, ChatGPT) that fire hydration mid-call. The
 *      screenshot half fires only when `screenshot !== "off"`.
 *
 *   2. `annotate_image` (conditional) — only fired when `screenshot ===
 *      "annotated"` AND there's a tree AND `lastSnapshotRefs` is populated.
 *      The `screenshot:"raw"` mode (Round 10) skips this hop and lets the
 *      captured bytes flow straight through. Annotation runs in the SW's
 *      OffscreenCanvas (no page injection, no CSP exposure).
 *
 * Returns a `CaptureResult` shape: `{ payload, image? }`. `registry.ts`'s
 * `registerTool` wrapper detects the shape and extracts the image into a
 * native MCP image content block alongside the text payload.
 */

import {
  prune,
  type PrunedNode,
  type PruneMeta,
  RawNode,
} from "../../snapshot/prune";
import { serializeTree } from "../../snapshot/serialize";
import { serializeDiff } from "../../snapshot/diff";
import type { TabId } from "../../protocol";
import {
  type ImagePayload,
  populateRefs,
  type ToolContext,
} from "../registry";
import { computeDrawStroke } from "./containment";
import { resolveSavePath, writeImage } from "./save";
import { VISUAL_CONSTANTS } from "./visual";

/**
 * Tri-state screenshot mode (Round 10):
 *
 *   "off"        — no image, tree only (cheapest; the default)
 *   "annotated"  — tree + image with red ref badges painted over each rect
 *   "raw"        — tree + image with NO badges (clean pixels alongside the tree)
 *
 * Promoted from a boolean to a 3-state enum so the agent can get a clean
 * screenshot (no badges) from browser_snapshot itself — no separate tool. The
 * annotate hop fires only when `screenshot === "annotated"`; for `"raw"` the
 * captured bytes flow straight through to the image block.
 */
export type ScreenshotMode = "off" | "annotated" | "raw";

export interface CaptureOpts {
  detail: "standard" | "full";
  limit: number;
  viewportOnly: boolean;
  screenshot: ScreenshotMode;
  // No `format` here — Round 7 removed the agent-facing param. Format is
  // derived from `save_to_path`'s file extension when a string; otherwise
  // defaults to JPEG (see save.ts::resolveSavePath).
  quality: number;
  maxWidth?: number;
  /** false → no save (default). true → auto-named in outputs_dir. String → explicit path. */
  save_to_path: boolean | string;
  /** False for `browser_snapshot(screenshot:"raw", withTree:false)` paths — skip the tree walk entirely. */
  withTree: boolean;
  /**
   * CP5: when true (the auto-snapshot replay path), emit a diff against the
   * previous pruned tree of this tab instead of the full outline — provided a
   * comparable prior tree exists and the delta is actually smaller than the full
   * outline. Explicit `browser_snapshot` leaves this false (default) and always
   * returns full. Either way the new tree becomes the next diff baseline.
   */
  allowDiff?: boolean;
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
   * `withTree:false` standalone path doesn't need it — no rect scaling. */
  cssViewport?: { w: number; h: number };
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

  // Round 10: `screenshot` is tri-state — capture pixels when the agent asked
  // for either annotated OR raw; skip the screenshot hop entirely on "off".
  const wantImage = opts.screenshot !== "off";

  // Hop 1: atomic snapshot + screenshot.
  const captureResp = (await ctx.daemon.exec(tabId, {
    kind: "snapshot_capture",
    withTree: opts.withTree,
    withScreenshot: wantImage,
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
    // CP3: serialize the tree to the compact indented outline (a string) and
    // surface the structured meta separately. The pruner's recovery `notice`
    // (cap/fallback) is inlined as the outline's first line so it can't be
    // missed; the same notice stays machine-readable in `payload.meta`. The
    // transport envelope stays JSON (action results nest this under
    // `payload.snapshot`); only the tree representation goes to text.
    const { meta, ...rest } = prunedTree;
    const newTree = rest as PrunedNode;
    // CP5: on the auto-snapshot path (allowDiff), serialize a diff against the
    // previous pruned tree of THIS tab instead of the full outline — but never
    // when the diff would be larger than the full tree (a full-page navigation
    // turns over every ref, so the delta is all-removed + all-added). An
    // explicit browser_snapshot leaves allowDiff false → always full. `meta.mode`
    // records what was actually returned so the agent can tell at a glance.
    const prior =
      opts.allowDiff && ctx.session.lastPrunedTreeTabId === tabId
        ? ctx.session.lastPrunedTree
        : undefined;
    const snapMeta: PruneMeta = { ...(meta ?? {}) };
    const fullBody = serializeTree(newTree);
    let body: string;
    if (prior) {
      const diffBody = serializeDiff(prior, newTree);
      if (diffBody.length < fullBody.length) {
        body = diffBody;
        snapMeta.mode = "diff";
      } else {
        body = fullBody;
        snapMeta.mode = "full";
      }
    } else {
      body = fullBody;
      snapMeta.mode = "full";
    }
    payload.tree = meta?.notice ? `NOTE: ${meta.notice}\n${body}` : body;
    payload.meta = snapMeta;
    // Refresh the baseline for the NEXT auto-snapshot diff (CP5).
    ctx.session.lastPrunedTree = newTree;
    ctx.session.lastPrunedTreeTabId = tabId;
    justPopulated = true;
  }

  let imageBase64 = captureResp.screenshot?.dataBase64;
  let imageFormat: "png" | "jpeg" =
    captureResp.screenshot?.format ?? format;
  let resizedTo = captureResp.screenshot?.resizedTo;

  // Hop 2 (conditional): annotate. Round 10: fires ONLY for `screenshot ===
  // "annotated"`. For `"raw"`, the captured bytes flow straight through —
  // clean pixels alongside the tree. Also skips when there are no refs to
  // badge (graceful no-op rather than an empty-rects round trip).
  if (
    opts.screenshot === "annotated" &&
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
        // {w:0, h:0} defensive fallback — the extension's scale formula
        // short-circuits to identity when either dimension is 0, so the
        // capture itself doesn't crash if helpers ever return a synthetic
        // root (missing document.body). The fallback path logs a breadcrumb
        // extension-side so the failure is visible.
        cssViewport: captureResp.cssViewport ?? { w: 0, h: 0 },
        maxWidth: opts.maxWidth,
        constants: { ...VISUAL_CONSTANTS },
      })) as AnnotateImageResponse;
      imageBase64 = annotated.dataBase64;
      imageFormat = annotated.format;
      resizedTo = annotated.resizedTo ?? resizedTo;
    }
  }

  if (wantImage && imageBase64) {
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
