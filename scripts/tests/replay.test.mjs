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
  dpr: 2,
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
        dpr: 2,
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
    screenshot: true,
    quality: 60,
    maxWidth: 1280,
  });
  session.lastLeasedTab = 7;

  const out = await replaySnapshot(ctx);
  assert.ok(out, "replaySnapshot should return a CaptureResult");
  assert.ok(out.payload, "CaptureResult must have a payload");
  assert.ok(out.image, "screenshot:true should produce an image block");

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

  // Hop 2 — annotate_image must include rects + DPR + the full constants object.
  const hop2 = calls[1];
  assert.equal(hop2.command.kind, "annotate_image");
  assert.equal(hop2.command.imageBase64, "raw-shot");
  assert.equal(hop2.command.format, "jpeg");
  assert.equal(hop2.command.dpr, 2);
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
      { tree: TREE_WITH_REFS, screenshot: undefined, dpr: 1 },
    ],
  });
  updateSnapshotParams(ctx.session, {
    tabId: 1,
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: false,
    quality: 70,
  });
  session.lastLeasedTab = 1;

  const out = await replaySnapshot(ctx);
  // No screenshot was requested, so no save can have happened — but also the
  // payload must not contain a savedTo field even if one was somehow leaked.
  assert.equal(out.payload.savedTo, undefined);
  assert.equal(out.payload.saveError, undefined);
  // Single hop only — no annotation when screenshot:false.
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
        dpr: 1,
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
    screenshot: true,
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
    screenshot: false,
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

test("runUnifiedCapture: withTree:false skips tree pruning and annotation", async () => {
  // browser_screenshot's call path. One hop, no annotation, no tree in payload.
  const { ctx, calls } = makeCtx({
    daemonResponses: [
      {
        screenshot: { format: "png", dataBase64: "px", resizedTo: undefined },
        dpr: 1,
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
    screenshot: true,
    quality: 70,
    save_to_path: false,
    withTree: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.withTree, false);
  assert.equal(calls[0].command.withScreenshot, true);
  assert.equal(out.payload.tree, undefined);
  assert.equal(out.image.mimeType, "image/png");
});
