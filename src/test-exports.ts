/**
 * Internal surface exposed only to the test harness in `scripts/tests/`.
 * The production MCP bundle does not import this file — it exists solely so
 * Node's `--test` runner can exercise pure helpers without standing up a
 * daemon or extension.
 *
 * Re-export anything tests need here. Never import this from runtime code.
 */

export { prune, type RawNode, type PrunedNode } from "./snapshot/prune";
export {
  BridgeSession,
  type RefMeta,
  DEFAULT_SNAPSHOT_PARAMS,
} from "./bridge/session";
export {
  toolResult,
  toolError,
  populateRefs,
  resolveRef,
} from "./bridge/registry";
export { registerTabTools } from "./bridge/tools/tabs";
export { registerObserveTools } from "./bridge/tools/observe";
export { registerInteractTools } from "./bridge/tools/interact";
