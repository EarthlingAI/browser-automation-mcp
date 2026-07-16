// Per-session element registry tests.
//
// Phase 4 introduced BridgeSession.lastSnapshotRefs (Map<ref, RefMeta>) plus a
// resolveRef helper that throws actionable errors when a ref is missing. CP2
// (non-evicting refs) added a cumulative `refRegistry` so a ref resolves while
// its element exists even after it falls out of a later snapshot, plus a
// `refNeedsVerification` gate + a liveness round-trip in execOnLeasedTab.
// These tests exercise populate / lookup / no-snapshot / fresh-miss /
// non-eviction / liveness paths.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  populateRefs,
  resolveRef,
  refNeedsVerification,
  execOnLeasedTab,
} from "../../dist/test-exports.mjs";

function rawNode(spec) {
  const { children = [], ...rest } = spec;
  return { ...rest, children };
}

// Minimal mock daemon — records every exec and replays a queued response, so
// the execOnLeasedTab liveness path can be exercised without a real extension.
function makeCtx({ daemonResponses = [], sessionInit } = {}) {
  const calls = [];
  const responses = [...daemonResponses];
  const session = new BridgeSession();
  if (sessionInit) sessionInit(session);
  const daemon = {
    sessionId: "test-registry",
    takeEnv: () => undefined,
    peekEnv: () => undefined,
    async exec(tabId, command) {
      calls.push({ tabId, command });
      if (responses.length === 0) {
        throw new Error(`unexpected daemon.exec call: ${command.kind}`);
      }
      return responses.shift();
    },
  };
  return { ctx: { daemon, session }, calls, session };
}

// A pruned node that carries a matching raw node (rect) for populateRefs.
function prunedChild(ref, role, name) {
  return { ref, role, name, children: [] };
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
  // The cumulative registry mirrors the latest snapshot on first populate.
  assert.equal(session.refRegistry.size, 2);
  const five = resolveRef(session, "5");
  assert.equal(five.role, "button");
  assert.equal(five.name, "Submit");
  assert.deepEqual(five.rect, { x: 10, y: 10, w: 100, h: 40 });
  assert.equal(five.tabId, 1234);
});

test("resolveRef throws a no-snapshot error when the registry is empty", () => {
  const session = new BridgeSession();
  // Fresh session: nothing snapshotted yet → empty cumulative registry.
  assert.throws(
    () => resolveRef(session, "5"),
    /no snapshot/i,
    "should report no-snapshot when nothing has been captured yet",
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

test("ref survives a snapshot that did not include it (non-evicting registry)", () => {
  const session = new BridgeSession();
  // Snapshot 1 on tab 1 shows refs 5 and 7.
  populateRefs(
    session,
    { ref: "0", role: "WebArea", children: [prunedChild("5", "button", "Submit"), prunedChild("7", "textbox", "Lyrics")] },
    undefined,
    1,
  );
  // Snapshot 2 on the SAME tab drops 5 (e.g. it scrolled past the cap) and adds 9.
  populateRefs(
    session,
    { ref: "0", role: "WebArea", children: [prunedChild("7", "textbox", "Lyrics"), prunedChild("9", "link", "Help")] },
    undefined,
    1,
  );
  // 5 is gone from the latest snapshot but still resolvable via the registry.
  assert.equal(session.lastSnapshotRefs.has("5"), false, "5 dropped from latest snapshot");
  assert.equal(session.refRegistry.has("5"), true, "5 retained in cumulative registry");
  const five = resolveRef(session, "5");
  assert.equal(five.role, "button", "non-evicting resolve returns the carried-forward meta");
  // A carried-forward ref must be liveness-verified before acting; a freshly
  // current ref (7) is trusted directly.
  assert.equal(refNeedsVerification(session, "5"), true, "out-of-snapshot ref needs verification");
  assert.equal(refNeedsVerification(session, "7"), false, "current+fresh ref skips verification");
});

test("switching the snapshot tab resets the cumulative registry", () => {
  const session = new BridgeSession();
  populateRefs(session, { ref: "0", role: "WebArea", children: [prunedChild("5", "button", "A")] }, undefined, 1);
  // A snapshot on a different tab starts a fresh ref namespace (page-side ids
  // are per-tab) — tab 1's refs must not resolve against tab 2.
  populateRefs(session, { ref: "0", role: "WebArea", children: [prunedChild("3", "link", "B")] }, undefined, 2);
  assert.equal(session.refRegistry.has("5"), false, "old tab's refs dropped on tab change");
  assert.equal(session.refRegistry.has("3"), true);
  assert.throws(() => resolveRef(session, "5"), /not found|nearby/i);
});

test("execOnLeasedTab fires a liveness probe for an out-of-snapshot ref and proceeds when live", async () => {
  const { ctx, calls } = makeCtx({
    daemonResponses: [
      { name: "Submit", role: "button", tag: "BUTTON", rect: { x: 0, y: 0, w: 10, h: 10 } }, // resolve_ref → live
      { clicked: "5" }, // click
    ],
    sessionInit: (s) => {
      // Make ref 5 known-but-not-current: snapshot it, then re-snapshot the
      // same tab without it.
      populateRefs(s, { ref: "0", role: "WebArea", children: [prunedChild("5", "button", "Submit")] }, undefined, 1);
      populateRefs(s, { ref: "0", role: "WebArea", children: [prunedChild("9", "link", "Help")] }, undefined, 1);
      s.lastLeasedTab = 1;
    },
  });
  const out = await execOnLeasedTab(ctx, 1, { kind: "click", ref: "5" });
  assert.deepEqual(out, { clicked: "5" }, "action proceeds when the probe confirms the element is live");
  assert.equal(calls.length, 2, "one liveness probe + the action");
  assert.equal(calls[0].command.kind, "resolve_ref");
  assert.equal(calls[0].command.ref, "5");
  assert.equal(calls[1].command.kind, "click");
});

test("execOnLeasedTab errors (and fires NO action) when the liveness probe says gone", async () => {
  const { ctx, calls } = makeCtx({
    daemonResponses: [null], // resolve_ref → element gone
    sessionInit: (s) => {
      populateRefs(s, { ref: "0", role: "WebArea", children: [prunedChild("5", "button", "Submit")] }, undefined, 1);
      populateRefs(s, { ref: "0", role: "WebArea", children: [prunedChild("9", "link", "Help")] }, undefined, 1);
      s.lastLeasedTab = 1;
    },
  });
  let err;
  try {
    await execOnLeasedTab(ctx, 1, { kind: "click", ref: "5" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw when the element is gone");
  assert.match(err.message, /no longer exists|removed/i, "gone error explains the element vanished");
  assert.match(err.message, /nearby/i, "gone error still lists nearby refs for recovery");
  const nearbyList = err.message.split("Available refs nearby:")[1] ?? "";
  assert.doesNotMatch(nearbyList, /\b5 \(/, "the gone ref must not be suggested as a nearby alternative to itself");
  assert.match(nearbyList, /\b9 \(/, "a still-live carried-forward ref is offered for recovery");
  assert.equal(calls.length, 1, "only the probe ran — the action never fired");
  assert.equal(calls[0].command.kind, "resolve_ref");
});

test("execOnLeasedTab blocks a ref-action that targets a different tab than the last snapshot", async () => {
  // Page-side ref ids are per-tab; acting on a ref while targeting a tab other
  // than the snapshot tab must fail fast with the cross-tab message — before
  // any daemon hop (no probe, no action).
  const { ctx, calls } = makeCtx({
    sessionInit: (s) => {
      populateRefs(s, { ref: "0", role: "WebArea", children: [prunedChild("5", "button", "Submit")] }, undefined, 1);
      s.lastLeasedTab = 1;
    },
  });
  let err;
  try {
    await execOnLeasedTab(ctx, 2, { kind: "click", ref: "5" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw on a cross-tab ref action");
  assert.match(err.message, /captured on tab 1 but this action targets tab 2/);
  assert.equal(calls.length, 0, "no daemon hop fires for a cross-tab ref");
});
