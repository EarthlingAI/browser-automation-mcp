// Per-session element registry tests.
//
// Phase 4 introduced BridgeSession.lastSnapshotRefs (Map<ref, RefMeta>) plus a
// resolveRef helper that throws actionable errors when a ref is missing.
// These tests exercise populate / lookup / stale / fresh-miss paths without
// going through the daemon or extension.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  populateRefs,
  resolveRef,
} from "../../dist/test-exports.mjs";

function rawNode(spec) {
  const { children = [], ...rest } = spec;
  return { ...rest, children };
}

test("populateRefs hydrates the session map from a pruned tree", () => {
  const session = new BridgeSession();
  // Pretend the pruner returned: one root, two children with refs 5 and 7.
  const pruned = {
    ref: "0",
    role: "WebArea",
    children: [
      { ref: "5", role: "button", name: "Submit", children: [] },
      { ref: "7", role: "textbox", name: "Lyrics", children: [] },
    ],
  };
  const raw = rawNode({
    nodeId: undefined,
    role: "WebArea",
    depth: 0,
    children: [
      rawNode({
        nodeId: "5",
        role: "button",
        name: "Submit",
        depth: 1,
        rect: { x: 10, y: 10, w: 100, h: 40 },
      }),
      rawNode({
        nodeId: "7",
        role: "textbox",
        name: "Lyrics",
        depth: 1,
        rect: { x: 10, y: 60, w: 300, h: 80 },
      }),
    ],
  });
  populateRefs(session, pruned, raw, 1234);
  assert.equal(session.isStale, false);
  assert.equal(session.lastSnapshotTabId, 1234);
  assert.equal(session.lastSnapshotRefs.size, 2);
  const five = resolveRef(session, "5");
  assert.equal(five.role, "button");
  assert.equal(five.name, "Submit");
  assert.deepEqual(five.rect, { x: 10, y: 10, w: 100, h: 40 });
  assert.equal(five.tabId, 1234);
});

test("resolveRef throws stale-error when isStale is true", () => {
  const session = new BridgeSession();
  // Fresh session: empty map + isStale=true.
  assert.throws(
    () => resolveRef(session, "5"),
    /stale|no snapshot/i,
    "stale path should fire when no snapshot has been taken",
  );
});

test("resolveRef throws fresh-state-miss with nearby refs listed", () => {
  const session = new BridgeSession();
  const pruned = {
    ref: "0",
    role: "WebArea",
    children: [
      { ref: "10", role: "button", name: "Save", children: [] },
      { ref: "11", role: "button", name: "Cancel", children: [] },
      { ref: "12", role: "button", name: "Delete", children: [] },
      { ref: "30", role: "link", name: "Help", children: [] },
    ],
  };
  populateRefs(session, pruned, undefined, 1);
  let err;
  try {
    resolveRef(session, "13");
  } catch (e) {
    err = e;
  }
  assert.ok(err, "resolveRef should throw on missing ref");
  // Listed refs should be the closest by numeric proximity. 12 is closest;
  // 11, 10, and 30 follow. The error must NOT use the stale-path message.
  assert.doesNotMatch(err.message, /stale/i, "fresh-miss should not say stale");
  assert.match(err.message, /Available refs nearby/);
  assert.match(err.message, /12 \(button 'Delete'\)/);
});
