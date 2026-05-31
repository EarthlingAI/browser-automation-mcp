// `replaySnapshot` — auto-snapshot pipeline. Mock-daemon test asserting that
// the unified-capture orchestrator forwards every visual param the user
// opted into (detail/limit/viewportOnly/screenshot/quality/maxWidth) AND
// that save_to_path is hard-coded to false (saving is per-call, never a
// session mode). Round 7: `format` is no longer a SnapshotParams field —
// runUnifiedCapture derives it from save_to_path (false → JPEG).

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  replaySnapshot,
  updateSnapshotParams,
  runUnifiedCapture,
} from "../../dist/test-exports.mjs";

// CP5 fixtures — every node carries a nodeId so prune uses it verbatim as the
// ref (no String(n+1) fallback, which can collide with a real nodeId on a
// nodeId-less synthetic root). T2 = T1 plus a second button, so the diff
// against T1's pruned baseline is a single "+ button" line.
const T1 = {
  nodeId: "100",
  role: "WebArea",
  name: "App",
  depth: 0,
  cssViewport: { w: 1280, h: 720 },
  children: [
    {
      nodeId: "1",
      role: "button",
      name: "Open",
      depth: 1,
      rect: { x: 10, y: 20, w: 80, h: 30 },
      inViewport: true,
      children: [],
    },
  ],
};
const T2 = {
  ...T1,
  children: [
    ...T1.children,
    {
      nodeId: "2",
      role: "button",
      name: "Save",
      depth: 1,
      rect: { x: 100, y: 20, w: 80, h: 30 },
      inViewport: true,
      children: [],
    },
  ],
};
const STD_PARAMS = {
  detail: "standard",
  limit: 1500,
  viewportOnly: false,
  screenshot: "off",
  quality: 70,
};

function makeCtx({ daemonResponses, sessionInit }) {
  const calls = [];
  const responses = [...daemonResponses];
  const session = new BridgeSession();
  if (sessionInit) sessionInit(session);
  const daemon = {
    sessionId: "test-replay",
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

const TREE_WITH_REFS = {
  role: "WebArea",
  name: "Test",
  depth: 0,
  cssViewport: { w: 1280, h: 720 },
  children: [
    {
      nodeId: "1",
      role: "button",
      name: "Submit",
      depth: 1,
      rect: { x: 10, y: 20, w: 80, h: 30 },
      inViewport: true,
      children: [],
    },
  ],
};

test("replaySnapshot forwards all visual params and pins save_to_path:false", async () => {
  const { ctx, calls, session } = makeCtx({
    daemonResponses: [
      // snapshot_capture
      {
        tree: TREE_WITH_REFS,
        screenshot: {
          format: "jpeg",
          dataBase64: "raw-shot",
          resizedTo: undefined,
        },
        cssViewport: { w: 1280, h: 720 },
      },
      // annotate_image
      { format: "jpeg", dataBase64: "annotated-shot" },
    ],
  });
  updateSnapshotParams(ctx.session, {
    tabId: 7,
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: "annotated",
    quality: 60,
    maxWidth: 1280,
  });
  session.lastLeasedTab = 7;

  const out = await replaySnapshot(ctx);
  assert.ok(out, "replaySnapshot should return a CaptureResult");
  assert.ok(out.payload, "CaptureResult must have a payload");
  assert.ok(out.image, "screenshot:\"annotated\" should produce an image block");

  // Hop 1 — snapshot_capture must forward the visual params verbatim.
  assert.equal(calls.length, 2);
  const hop1 = calls[0];
  assert.equal(hop1.tabId, 7);
  assert.equal(hop1.command.kind, "snapshot_capture");
  assert.equal(hop1.command.withTree, true);
  assert.equal(hop1.command.withScreenshot, true);
  assert.equal(hop1.command.format, "jpeg");
  assert.equal(hop1.command.quality, 60);
  assert.equal(hop1.command.maxWidth, 1280);
  assert.equal(hop1.command.viewportOnly, true);
  assert.equal(hop1.command.limit, 500);

  // Hop 2 — annotate_image must include rects + cssViewport + the full constants object.
  const hop2 = calls[1];
  assert.equal(hop2.command.kind, "annotate_image");
  assert.equal(hop2.command.imageBase64, "raw-shot");
  assert.equal(hop2.command.format, "jpeg");
  assert.deepEqual(hop2.command.cssViewport, { w: 1280, h: 720 });
  assert.equal(hop2.command.maxWidth, 1280);
  assert.ok(Array.isArray(hop2.command.rects));
  assert.ok(hop2.command.rects.length > 0, "rects should be populated from session refs");
  assert.ok(hop2.command.constants);
  assert.equal(hop2.command.constants.BADGE_FILL, "#FF4444");

  // Image carries the ANNOTATED bytes, not the raw capture.
  assert.equal(out.image.data, "annotated-shot");
  assert.equal(out.image.mimeType, "image/jpeg");
});

test("replaySnapshot never persists save_to_path — even after a save'd snapshot", async () => {
  // The unified-capture orchestrator is called with save_to_path:false from
  // replaySnapshot regardless of any session state. This guards against the
  // "long session quietly fills outputs/" failure mode.
  const { ctx, calls, session } = makeCtx({
    daemonResponses: [
      { tree: TREE_WITH_REFS, screenshot: undefined, cssViewport: { w: 1280, h: 720 } },
    ],
  });
  updateSnapshotParams(ctx.session, {
    tabId: 1,
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: "off",
    quality: 70,
  });
  session.lastLeasedTab = 1;

  const out = await replaySnapshot(ctx);
  // No screenshot was requested, so no save can have happened — but also the
  // payload must not contain a savedTo field even if one was somehow leaked.
  assert.equal(out.payload.savedTo, undefined);
  assert.equal(out.payload.saveError, undefined);
  // Single hop only — no annotation when screenshot:"off".
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.withScreenshot, false);
});

test("runUnifiedCapture skips annotation hop when there are no refs", async () => {
  // Edge case: empty tree → no refs → no rects → annotate_image would be a
  // no-op round trip. Verify it's not even called.
  const { ctx, calls } = makeCtx({
    daemonResponses: [
      {
        tree: { role: "WebArea", name: "Empty", depth: 0, children: [] },
        screenshot: { format: "jpeg", dataBase64: "raw", resizedTo: undefined },
        cssViewport: { w: 1280, h: 720 },
      },
    ],
    sessionInit: (s) => {
      s.lastLeasedTab = 42;
    },
  });
  const out = await runUnifiedCapture(ctx, 42, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: "annotated",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 1, "annotate_image should NOT fire when refs are empty");
  assert.equal(calls[0].command.kind, "snapshot_capture");
  // Raw screenshot still surfaces.
  assert.equal(out.image.data, "raw");
});

test("replaySnapshot error path preserves structured fields (kind/recovery/hint/leasedBy/since)", async () => {
  // A failing daemon hop must surface every recovery-relevant field so the
  // host agent's error UX stays actionable. Mirrors `toolError`'s contract.
  const session = new BridgeSession();
  session.lastLeasedTab = 99;
  const error = Object.assign(new Error("extension not connected"), {
    kind: "extension_disconnected",
    recovery: "reload the Browser Automation Bridge extension at chrome://extensions",
    hint: "service worker idle-died",
    leasedBy: "agent-a",
    since: "2026-05-17T12:00:00Z",
  });
  const ctx = {
    daemon: {
      sessionId: "test-error-replay",
      async exec() {
        throw error;
      },
    },
    session,
  };
  updateSnapshotParams(ctx.session, {
    tabId: 99,
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: "off",
    quality: 70,
  });
  const stub = await replaySnapshot(ctx);
  assert.equal(stub.error, "extension not connected");
  assert.equal(stub.kind, "extension_disconnected");
  assert.match(stub.recovery, /chrome:\/\/extensions/);
  assert.equal(stub.hint, "service worker idle-died");
  assert.equal(stub.leasedBy, "agent-a");
  assert.equal(stub.since, "2026-05-17T12:00:00Z");
});

test("runUnifiedCapture: withTree:false + screenshot:\"raw\" → tree-less raw capture (one hop)", async () => {
  // The unified pipeline still supports a tree-less raw capture (withTree:false
  // + screenshot:"raw"): one hop, no tree in the payload, raw bytes. No tool
  // currently reaches this path (browser_snapshot and the auto-snapshot replay
  // both pass withTree:true), but the capability is a deliberate part of the
  // capture contract — keep this test pinning it so a refactor that breaks it
  // fails here, not silently.
  const { ctx, calls } = makeCtx({
    daemonResponses: [
      {
        screenshot: { format: "png", dataBase64: "px", resizedTo: undefined },
      },
    ],
    sessionInit: (s) => {
      s.lastLeasedTab = 5;
    },
  });
  // No format arg — default (jpeg) is overridden by the daemon's "png" reply
  // shape; the bridge trusts the format the extension actually used.
  const out = await runUnifiedCapture(ctx, 5, {
    detail: "standard",
    limit: 0,
    viewportOnly: true,
    screenshot: "raw",
    quality: 70,
    save_to_path: false,
    withTree: false,
  });
  assert.equal(calls.length, 1, "no annotate_image hop on screenshot:\"raw\"");
  assert.equal(calls[0].command.withTree, false);
  assert.equal(calls[0].command.withScreenshot, true);
  assert.equal(out.payload.tree, undefined);
  assert.equal(out.image.data, "px", "image carries the raw capture bytes verbatim");
  assert.equal(out.image.mimeType, "image/png");
});

test("runUnifiedCapture: screenshot:\"annotated\" + withTree:false → annotation hop still skipped (defence in depth)", async () => {
  // Even though `withTree:false` makes a tree-less capture safe regardless of
  // the enum, this test guards against a future refactor that changes the
  // gate. Currently the annotate hop is skipped because `justPopulated`
  // never flips true without a tree — but a code change that drops that
  // condition would silently re-introduce annotation on a tree-less call.
  const { ctx, calls } = makeCtx({
    daemonResponses: [
      {
        screenshot: { format: "jpeg", dataBase64: "raw-bytes", resizedTo: undefined },
      },
    ],
    sessionInit: (s) => {
      s.lastLeasedTab = 6;
    },
  });
  const out = await runUnifiedCapture(ctx, 6, {
    detail: "standard",
    limit: 0,
    viewportOnly: true,
    screenshot: "annotated",
    quality: 70,
    save_to_path: false,
    withTree: false,
  });
  assert.equal(calls.length, 1, "annotation must NOT fire when there is no tree");
  assert.equal(out.image.data, "raw-bytes");
});

// ─── CP5: diff snapshots on the auto-snapshot path ──────────────────
//
// replaySnapshot passes allowDiff:true, so an auto-snapshot returns a diff
// against the prior pruned tree of the same tab (when one exists and the delta
// is smaller than the full outline); the first auto-snapshot of a tab, or an
// explicit browser_snapshot (allowDiff unset), returns full. meta.mode records
// which path was taken.

test("auto-snapshot: first call returns full (no prior), second call returns a diff", async () => {
  const { ctx, session } = makeCtx({
    daemonResponses: [
      { tree: T1, screenshot: undefined, cssViewport: { w: 1280, h: 720 } },
      { tree: T2, screenshot: undefined, cssViewport: { w: 1280, h: 720 } },
    ],
  });
  updateSnapshotParams(ctx.session, { tabId: 7, ...STD_PARAMS });
  session.lastLeasedTab = 7;

  const first = await replaySnapshot(ctx);
  assert.equal(first.payload.meta.mode, "full", "first snapshot of the tab has no prior → full");
  assert.ok(first.payload.tree.startsWith("- "), "full outline starts with a node bullet");

  const second = await replaySnapshot(ctx);
  assert.equal(second.payload.meta.mode, "diff", "second snapshot diffs against the stored baseline");
  assert.ok(second.payload.tree.startsWith("Δ "), `diff outline leads with the Δ header, got: ${second.payload.tree.slice(0, 30)}`);
  assert.match(second.payload.tree, /1 added, 0 removed, 0 changed/);
  assert.match(second.payload.tree, /\+ button "Save" \[ref=2\]/);
});

test("auto-snapshot falls back to full when the prior tree is for a DIFFERENT tab", async () => {
  const { ctx, session } = makeCtx({
    daemonResponses: [{ tree: T1, screenshot: undefined, cssViewport: { w: 1280, h: 720 } }],
    sessionInit: (s) => {
      // A baseline left over from a different tab must not diff against tab 7 —
      // page-side ref ids are per-tab.
      s.lastPrunedTree = { ref: "100", role: "WebArea", name: "App", children: [] };
      s.lastPrunedTreeTabId = 99;
    },
  });
  updateSnapshotParams(ctx.session, { tabId: 7, ...STD_PARAMS });
  session.lastLeasedTab = 7;

  const out = await replaySnapshot(ctx);
  assert.equal(out.payload.meta.mode, "full", "cross-tab prior is not comparable → full");
  assert.ok(out.payload.tree.startsWith("- "));
});

test("auto-snapshot falls back to full when the diff would be larger than the full outline", async () => {
  // Navigation churn: the prior tree shares only its root with the new tree, so
  // a diff is 5 removed + 1 added (long) while the full outline is 2 lines. The
  // size guard must pick full so the "diff" is never worse than a full snapshot.
  const bigPrior = {
    ref: "100",
    role: "WebArea",
    name: "App",
    children: [201, 202, 203, 204, 205].map((n) => ({
      ref: String(n),
      role: "button",
      name: `Old ${n}`,
      children: [],
    })),
  };
  const { ctx, session } = makeCtx({
    daemonResponses: [{ tree: T1, screenshot: undefined, cssViewport: { w: 1280, h: 720 } }],
    sessionInit: (s) => {
      s.lastPrunedTree = bigPrior;
      s.lastPrunedTreeTabId = 7;
    },
  });
  updateSnapshotParams(ctx.session, { tabId: 7, ...STD_PARAMS });
  session.lastLeasedTab = 7;

  const out = await replaySnapshot(ctx);
  assert.equal(out.payload.meta.mode, "full", "an oversized diff must fall back to full");
  assert.ok(out.payload.tree.startsWith("- "), "full outline, not a Δ diff");
});

test("explicit-style call (allowDiff unset) always returns full and refreshes the baseline", async () => {
  // browser_snapshot calls runUnifiedCapture WITHOUT allowDiff. Even with a
  // comparable prior tree present, it must serialize full — and still update
  // the baseline so the NEXT auto-snapshot diffs against this snapshot.
  const seedPrior = { ref: "100", role: "WebArea", name: "App", children: [] };
  const { ctx, session } = makeCtx({
    daemonResponses: [{ tree: T2, screenshot: undefined, cssViewport: { w: 1280, h: 720 } }],
    sessionInit: (s) => {
      s.lastPrunedTree = seedPrior;
      s.lastPrunedTreeTabId = 9;
      s.lastLeasedTab = 9;
    },
  });
  const out = await runUnifiedCapture(ctx, 9, {
    ...STD_PARAMS,
    save_to_path: false,
    withTree: true,
    // allowDiff intentionally omitted → explicit-snapshot semantics.
  });
  assert.equal(out.payload.meta.mode, "full", "explicit snapshot never diffs");
  assert.ok(out.payload.tree.startsWith("- "));
  assert.equal(session.lastPrunedTreeTabId, 9, "baseline tab tracked");
  assert.notEqual(session.lastPrunedTree, seedPrior, "baseline refreshed to the new tree");
  assert.match(out.payload.tree, /button "Save" \[ref=2\]/, "new tree was serialized in full");
});
