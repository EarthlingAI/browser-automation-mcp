// Wire-shape verification for the two new ExtCommands. Mocks the daemon and
// asserts that runUnifiedCapture sends exactly the right payload — including
// the full VISUAL_CONSTANTS object on the annotate_image hop.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  runUnifiedCapture,
  VISUAL_CONSTANTS,
} from "../../dist/test-exports.mjs";

function makeCtx(daemonResponses) {
  const calls = [];
  const responses = [...daemonResponses];
  const daemon = {
    sessionId: "test-snapshot-capture",
    async exec(tabId, command) {
      calls.push({ tabId, command });
      if (responses.length === 0) {
        throw new Error(`unexpected daemon.exec call: ${command.kind}`);
      }
      return responses.shift();
    },
  };
  return { ctx: { daemon, session: new BridgeSession() }, calls };
}

const TREE_ONE_BUTTON = {
  role: "WebArea",
  name: "T",
  depth: 0,
  dpr: 1.5,
  children: [
    {
      nodeId: "1",
      role: "button",
      name: "Click me",
      depth: 1,
      rect: { x: 100, y: 200, w: 120, h: 40 },
      inViewport: true,
      children: [],
    },
  ],
};

test("snapshot_capture command carries the unified-capture options verbatim", async () => {
  const { ctx, calls } = makeCtx([
    {
      tree: TREE_ONE_BUTTON,
      screenshot: { format: "jpeg", dataBase64: "raw", resizedTo: undefined },
      dpr: 1.5,
    },
    { format: "jpeg", dataBase64: "annotated" },
  ]);
  ctx.session.lastLeasedTab = 11;
  await runUnifiedCapture(ctx, 11, {
    detail: "standard",
    limit: 250,
    viewportOnly: false,
    screenshot: true,
    format: "jpeg",
    quality: 85,
    maxWidth: 1600,
    save_to_path: false,
    withTree: true,
  });
  const cap = calls[0].command;
  assert.equal(cap.kind, "snapshot_capture");
  assert.equal(cap.withTree, true);
  assert.equal(cap.withScreenshot, true);
  assert.equal(cap.viewportOnly, false);
  assert.equal(cap.limit, 250);
  assert.equal(cap.format, "jpeg");
  assert.equal(cap.quality, 85);
  assert.equal(cap.maxWidth, 1600);
});

test("annotate_image command carries imageBase64, rects, dpr, and the full constants", async () => {
  const { ctx, calls } = makeCtx([
    {
      tree: TREE_ONE_BUTTON,
      screenshot: { format: "jpeg", dataBase64: "raw-bytes", resizedTo: undefined },
      dpr: 1.5,
    },
    { format: "jpeg", dataBase64: "annotated-bytes" },
  ]);
  ctx.session.lastLeasedTab = 11;
  await runUnifiedCapture(ctx, 11, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: true,
    format: "jpeg",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 2);
  const ann = calls[1].command;
  assert.equal(ann.kind, "annotate_image");
  assert.equal(ann.imageBase64, "raw-bytes");
  assert.equal(ann.format, "jpeg");
  assert.equal(ann.dpr, 1.5);
  assert.ok(Array.isArray(ann.rects));
  assert.ok(ann.rects.length >= 1, "should have at least the button ref");
  const firstRect = ann.rects[0];
  assert.ok(firstRect.ref);
  assert.equal(firstRect.rect.x, 100);
  assert.equal(firstRect.rect.y, 200);
  assert.equal(firstRect.rect.w, 120);
  assert.equal(firstRect.rect.h, 40);
  // Constants must match the bridge-side source of truth — a missing key
  // would surface as undefined paint mid-draw on the extension side.
  for (const k of Object.keys(VISUAL_CONSTANTS)) {
    assert.equal(ann.constants[k], VISUAL_CONSTANTS[k], `constants.${k} mismatch`);
  }
});

test("screenshot:false → only one hop (no annotate_image)", async () => {
  const { ctx, calls } = makeCtx([
    { tree: TREE_ONE_BUTTON, screenshot: undefined, dpr: 1.5 },
  ]);
  ctx.session.lastLeasedTab = 1;
  const out = await runUnifiedCapture(ctx, 1, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: false,
    format: "jpeg",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(out.image, undefined);
  assert.ok(out.payload.tree);
});
