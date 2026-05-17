import { TabId } from "../protocol";
import type { ScreenshotMode } from "./tools/capture";

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
  limit: 500,
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
   * Map of ref → RefMeta from the most recent successful snapshot, scoped per
   * bridge session. Populated by `browser_snapshot` (and by replaySnapshot).
   * Cleared/repopulated wholesale on each snapshot.
   */
  lastSnapshotRefs: Map<string, RefMeta> = new Map();
  /**
   * Stale flag flipped to false after a successful snapshot and back to true
   * after any action tool fires. Drives the "your refs may be from a prior
   * page state" branch in resolveRef's error messages.
   */
  isStale = true;
  /**
   * The tab id the current lastSnapshotRefs are for. Used so that switching
   * tabs and then targeting a ref from the OLD tab produces a clearer error.
   */
  lastSnapshotTabId?: TabId;
}
