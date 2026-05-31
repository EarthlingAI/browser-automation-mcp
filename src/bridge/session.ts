import { TabId } from "../protocol";
import type { ScreenshotMode } from "./tools/capture";
import type { PrunedNode } from "../snapshot/prune";

export interface SnapshotParams {
  tabId?: TabId;
  detail: "standard" | "full";
  limit: number;
  viewportOnly: boolean;
  // Round 10: tri-state — "off" | "annotated" | "raw". Replayed verbatim by
  // auto-snapshots so an agent that opted into "annotated" or "raw" keeps
  // getting the same flavour of image until it explicitly flips back to "off".
  screenshot: ScreenshotMode;
  // No `format` here (Round 7) — derived from `save_to_path`'s extension on
  // each call; defaults to JPEG when no save is requested.
  quality: number;
  maxWidth?: number;
}

export const DEFAULT_SNAPSHOT_PARAMS: SnapshotParams = {
  detail: "standard",
  // Keep in lockstep with browser_snapshot's schema default (observe.ts) — this
  // is what an action's auto-snapshot replays before any explicit snapshot has
  // set the session params.
  limit: 1500,
  // Round 7 default flip: viewportOnly is now false. The pruner ranks across
  // the WHOLE page (capped at `limit`) and auto-falls-back to viewport-only
  // only when the page exceeds 3 × effectiveLimit candidates.
  viewportOnly: false,
  screenshot: "off",
  quality: 70,
  // maxWidth intentionally undefined — native resolution by default.
};

/**
 * Per-ref metadata captured from the most recent snapshot. Used by
 * `resolveRef` in `registry.ts` to validate `ref` args before sending to the
 * daemon, and to compose actionable error messages naming the available refs
 * when an action targets a missing one.
 */
export interface RefMeta {
  role: string;
  name?: string;
  rect?: { x: number; y: number; w: number; h: number };
  tabId: TabId;
  snapshotAt: number;
}

export class BridgeSession {
  lastSnapshotParams: SnapshotParams = { ...DEFAULT_SNAPSHOT_PARAMS };
  lastLeasedTab?: TabId;
  /**
   * Refs from the MOST RECENT snapshot only — the fast-path "definitely
   * current" set. Repopulated wholesale on each snapshot. A ref here (with a
   * fresh `isStale=false`) is trusted without a liveness probe; it also drives
   * the annotation hop's rect list. The cumulative, non-evicting view lives in
   * `refRegistry`.
   */
  lastSnapshotRefs: Map<string, RefMeta> = new Map();
  /**
   * Cumulative ref → RefMeta across every snapshot of the CURRENT tab — the
   * source of truth for non-evicting resolution. A ref that dropped out of the
   * latest snapshot (pruner cap, scrolled out of viewport, hidden) still
   * resolves here, and the bridge confirms its element is live via a
   * `resolve_ref` probe before acting. Merged (never wholesale-cleared) by
   * `populateRefs` within a tab; reset only when the snapshot tab changes, so
   * one tab's refs never resolve against another's. Also backs the
   * nearby-refs error listing.
   */
  refRegistry: Map<string, RefMeta> = new Map();
  /**
   * Flipped to false after a successful snapshot and back to true after any
   * mutating action. It no longer invalidates refs wholesale (refs are stable
   * and non-evicting now) — it only gates the fast path: a ref in
   * `lastSnapshotRefs` skips the liveness probe iff `isStale` is false. Once an
   * action has fired, even current refs are re-verified live before reuse, and
   * only genuinely-gone elements error.
   */
  isStale = true;
  /**
   * The tab id the current snapshot refs are for. Used to clear `refRegistry`
   * on a tab change and to flag actions that target a different tab than the
   * last snapshot.
   */
  lastSnapshotTabId?: TabId;
  /**
   * The pruned tree from the most recent snapshot — the baseline the next
   * auto-snapshot diffs against (CP5). Refreshed by `runUnifiedCapture` on EVERY
   * snapshot (explicit OR auto): an explicit `browser_snapshot` returns the full
   * tree but still updates this baseline; an action's auto-snapshot diffs against
   * it then replaces it, so each action's diff reflects only what THAT action
   * changed since the prior snapshot.
   */
  lastPrunedTree?: PrunedNode;
  /**
   * The tab `lastPrunedTree` belongs to. Page-side ref ids are per-tab, so a
   * tree captured on a different tab is not ref-comparable — a mismatch forces
   * the auto-snapshot to fall back to a full serialization.
   */
  lastPrunedTreeTabId?: TabId;
}
