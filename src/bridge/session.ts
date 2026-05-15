import { TabId } from "../protocol";

export interface SnapshotParams {
  tabId?: TabId;
  detail: "standard" | "full";
  limit: number;
  viewportOnly: boolean;
  screenshot: boolean;
}

export const DEFAULT_SNAPSHOT_PARAMS: SnapshotParams = {
  detail: "standard",
  limit: 500,
  viewportOnly: true,
  screenshot: false,
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
