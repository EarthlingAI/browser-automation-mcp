/**
 * Internal surface exposed only to the test harness in `scripts/tests/`.
 * The production MCP bundle does not import this file — it exists solely so
 * Node's `--test` runner can exercise pure helpers without standing up a
 * daemon or extension.
 *
 * Re-export anything tests need here. Never import this from runtime code.
 */

export { prune, type RawNode, type PrunedNode } from "./snapshot/prune";
export { BridgeSession } from "./bridge/session";
export {
  toolResult,
  toolError,
  populateRefs,
  resolveRef,
  replaySnapshot,
  updateSnapshotParams,
  type ImagePayload,
} from "./bridge/registry";
export { registerTabTools } from "./bridge/tools/tabs";
export { registerObserveTools } from "./bridge/tools/observe";
export { registerInteractTools } from "./bridge/tools/interact";
export { coerceToArray, coerceLiteralNumber, coerceBoolean } from "./bridge/tools/coerce";
export {
  resolveSavePath,
  getOutputsDir,
  saveToPathSchema,
} from "./bridge/tools/save";
export { VISUAL_CONSTANTS } from "./bridge/tools/visual";
export { runUnifiedCapture, type CaptureOpts, type CaptureResult } from "./bridge/tools/capture";
export { BUILD_STAMP, SERVER_INSTRUCTIONS } from "./bridge/meta";
export { inferExtTimeout } from "./daemon/timeouts";
