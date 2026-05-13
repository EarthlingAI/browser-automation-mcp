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

export class BridgeSession {
  lastSnapshotParams: SnapshotParams = { ...DEFAULT_SNAPSHOT_PARAMS };
  lastLeasedTab?: TabId;
}
