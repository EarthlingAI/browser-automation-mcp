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
  cssViewport: { w: 1024, h: 768 },
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
      cssViewport: { w: 1024, h: 768 },
    },
    { format: "jpeg", dataBase64: "annotated" },
  ]);
  ctx.session.lastLeasedTab = 11;
  // Round 7: no `format` arg — derived from save_to_path (false → JPEG).
  await runUnifiedCapture(ctx, 11, {
    detail: "standard",
    limit: 250,
    viewportOnly: false,
    screenshot: "annotated",
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
  // Format defaults to jpeg when save_to_path:false (no extension to infer from).
  assert.equal(cap.format, "jpeg");
  assert.equal(cap.quality, 85);
  assert.equal(cap.maxWidth, 1600);
});

test("annotate_image command carries imageBase64, rects, cssViewport, and the full constants", async () => {
  const { ctx, calls } = makeCtx([
    {
      tree: TREE_ONE_BUTTON,
      screenshot: { format: "jpeg", dataBase64: "raw-bytes", resizedTo: undefined },
      cssViewport: { w: 1024, h: 768 },
    },
    { format: "jpeg", dataBase64: "annotated-bytes" },
  ]);
  ctx.session.lastLeasedTab = 11;
  await runUnifiedCapture(ctx, 11, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: "annotated",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 2);
  const ann = calls[1].command;
  assert.equal(ann.kind, "annotate_image");
  assert.equal(ann.imageBase64, "raw-bytes");
  // Format flows through both hops — inferred from save_to_path:false → jpeg.
  assert.equal(ann.format, "jpeg");
  assert.deepEqual(ann.cssViewport, { w: 1024, h: 768 });
  assert.ok(Array.isArray(ann.rects));
  assert.ok(ann.rects.length >= 1, "should have at least the button ref");
  const firstRect = ann.rects[0];
  assert.ok(firstRect.ref);
  assert.equal(firstRect.rect.x, 100);
  assert.equal(firstRect.rect.y, 200);
  assert.equal(firstRect.rect.w, 120);
  assert.equal(firstRect.rect.h, 40);
  // Round 7: each rect carries a drawStroke flag (containment suppression).
  assert.equal(typeof firstRect.drawStroke, "boolean");
  // Constants must match the bridge-side source of truth — a missing key
  // would surface as undefined paint mid-draw on the extension side.
  for (const k of Object.keys(VISUAL_CONSTANTS)) {
    assert.equal(ann.constants[k], VISUAL_CONSTANTS[k], `constants.${k} mismatch`);
  }
});

test("screenshot:\"off\" → only one hop (no annotate_image)", async () => {
  const { ctx, calls } = makeCtx([
    { tree: TREE_ONE_BUTTON, screenshot: undefined, cssViewport: { w: 1024, h: 768 } },
  ]);
  ctx.session.lastLeasedTab = 1;
  const out = await runUnifiedCapture(ctx, 1, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: "off",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(out.image, undefined);
  assert.ok(out.payload.tree);
});

// ─── scale formula regression test ─────────────────────────────────
//
// Mirrors the production scale formula in
// `browser-extension/background.js::doAnnotateImage`:
//
//   if (c.maxWidth && bmp.width > c.maxWidth) {
//     imgW = c.maxWidth;
//     imgH = Math.round(bmp.height * c.maxWidth / bmp.width);
//   }
//   scaleX = imgW / cssViewport.w;
//   scaleY = imgH / cssViewport.h;
//
// Pixel-coords for a rect at (cssX, cssY) land at
// (Math.round(cssX * scaleX), Math.round(cssY * scaleY)). KEEP IN SYNC.
// The production code is 5 lines and lives in a service worker that can't
// easily import shared modules — so we duplicate intentionally and rely on
// this matrix + the live-test gate to catch drift.
function computeScale({ cssViewport, bmpW, bmpH, maxWidth }) {
  let imgW = bmpW;
  let imgH = bmpH;
  if (maxWidth && bmpW > maxWidth) {
    imgW = maxWidth;
    imgH = Math.round(bmpH * (maxWidth / bmpW));
  }
  const cssW = cssViewport && cssViewport.w > 0 ? cssViewport.w : imgW;
  const cssH = cssViewport && cssViewport.h > 0 ? cssViewport.h : imgH;
  return { scaleX: imgW / cssW, scaleY: imgH / cssH, imgW, imgH };
}

test("scale formula: badge coords are pixel-accurate across DPR × maxWidth combinations", () => {
  const cases = [
    {
      name: "(a) DPR=1, no resize",
      cssViewport: { w: 1920, h: 1080 },
      bmpW: 1920,
      bmpH: 1080,
      maxWidth: undefined,
      expectedScaleX: 1,
      expectedScaleY: 1,
      probe: { cssX: 100, cssY: 200, expCanvasX: 100, expCanvasY: 200 },
    },
    {
      name: "(b) DPR=2, no resize",
      cssViewport: { w: 1920, h: 1080 },
      bmpW: 3840,
      bmpH: 2160,
      maxWidth: undefined,
      expectedScaleX: 2,
      expectedScaleY: 2,
      probe: { cssX: 100, cssY: 200, expCanvasX: 200, expCanvasY: 400 },
    },
    {
      name: "(c) DPR=0.8, maxWidth=1280 (the bug case)",
      cssViewport: { w: 2397, h: 1137 },
      bmpW: 1918, // = 2397 * 0.8
      bmpH: 909, // = 1137 * 0.8
      maxWidth: 1280,
      expectedScaleX: 1280 / 2397,
      expectedScaleY: Math.round(909 * (1280 / 1918)) / 1137,
      probe: {
        cssX: 1352,
        cssY: 12,
        expCanvasX: Math.round(1352 * (1280 / 2397)),
        expCanvasY: Math.round(12 * (Math.round(909 * (1280 / 1918)) / 1137)),
      },
    },
    {
      name: "(d) DPR=1, maxWidth=640",
      cssViewport: { w: 1280, h: 960 },
      bmpW: 1280,
      bmpH: 960,
      maxWidth: 640,
      expectedScaleX: 0.5,
      expectedScaleY: 0.5,
      probe: { cssX: 1000, cssY: 800, expCanvasX: 500, expCanvasY: 400 },
    },
    {
      name: "(e) DPR=2, maxWidth=1024",
      cssViewport: { w: 1024, h: 768 },
      bmpW: 2048,
      bmpH: 1536,
      maxWidth: 1024,
      expectedScaleX: 1,
      expectedScaleY: 1,
      probe: { cssX: 256, cssY: 64, expCanvasX: 256, expCanvasY: 64 },
    },
  ];
  for (const c of cases) {
    const { scaleX, scaleY } = computeScale(c);
    assert.ok(
      Math.abs(scaleX - c.expectedScaleX) < 1e-6,
      `${c.name} scaleX: expected ${c.expectedScaleX}, got ${scaleX}`,
    );
    assert.ok(
      Math.abs(scaleY - c.expectedScaleY) < 1e-6,
      `${c.name} scaleY: expected ${c.expectedScaleY}, got ${scaleY}`,
    );
    const canvasX = Math.round(c.probe.cssX * scaleX);
    const canvasY = Math.round(c.probe.cssY * scaleY);
    assert.ok(
      Math.abs(canvasX - c.probe.expCanvasX) < 1.5,
      `${c.name} canvasX: expected ${c.probe.expCanvasX}, got ${canvasX}`,
    );
    assert.ok(
      Math.abs(canvasY - c.probe.expCanvasY) < 1.5,
      `${c.name} canvasY: expected ${c.probe.expCanvasY}, got ${canvasY}`,
    );
  }
});

test("scale formula: empty cssViewport falls back to identity scale", () => {
  const { scaleX, scaleY } = computeScale({
    cssViewport: { w: 0, h: 0 },
    bmpW: 1280,
    bmpH: 720,
    maxWidth: undefined,
  });
  assert.equal(scaleX, 1);
  assert.equal(scaleY, 1);
});

// ─── tri-state screenshot mode (Round 10) ───────────────────────────
//
// Promoted `screenshot` from boolean to enum: "off" | "annotated" | "raw".
// Each value must drive runUnifiedCapture down a distinct path:
//   "off"        → no screenshot hop, no image in result
//   "annotated"  → screenshot hop + annotate hop, image carries badged bytes
//   "raw"        → screenshot hop only, image carries raw captured bytes
//                  (no annotate_image round trip even though refs exist)

test("screenshot:\"off\" → snapshot_capture hop sets withScreenshot:false, no image returned", async () => {
  const { ctx, calls } = makeCtx([
    { tree: TREE_ONE_BUTTON, screenshot: undefined, cssViewport: { w: 1024, h: 768 } },
  ]);
  ctx.session.lastLeasedTab = 1;
  const out = await runUnifiedCapture(ctx, 1, {
    detail: "standard",
    limit: 500,
    viewportOnly: false,
    screenshot: "off",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 1, "only the snapshot_capture hop should fire");
  assert.equal(calls[0].command.withScreenshot, false);
  assert.equal(out.image, undefined, "no image block on screenshot:\"off\"");
  assert.ok(out.payload.tree, "tree still returns");
  // CP3: the tree is now the compact indented-text outline (a string), not a
  // nested JSON object, and structured meta is surfaced separately.
  assert.equal(typeof out.payload.tree, "string", "tree is the compact text outline");
  assert.match(
    out.payload.tree,
    /- button "Click me" \[ref=1\]/,
    "outline carries the button line with its ref",
  );
  assert.ok(out.payload.meta, "structured meta is surfaced separately from the tree");
  assert.equal(typeof out.payload.meta.total_candidates, "number", "meta keeps total_candidates");
});

test("screenshot:\"annotated\" → 2 hops, image carries annotated bytes", async () => {
  const { ctx, calls } = makeCtx([
    {
      tree: TREE_ONE_BUTTON,
      screenshot: { format: "jpeg", dataBase64: "raw-bytes", resizedTo: undefined },
      cssViewport: { w: 1024, h: 768 },
    },
    { format: "jpeg", dataBase64: "annotated-bytes" },
  ]);
  ctx.session.lastLeasedTab = 2;
  const out = await runUnifiedCapture(ctx, 2, {
    detail: "standard",
    limit: 500,
    viewportOnly: false,
    screenshot: "annotated",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 2, "snapshot_capture + annotate_image");
  assert.equal(calls[0].command.withScreenshot, true);
  assert.equal(calls[1].command.kind, "annotate_image");
  assert.equal(out.image.data, "annotated-bytes", "image carries the annotated bytes");
});

test("screenshot:\"raw\" → 1 hop only, image carries the raw capture bytes (no annotate)", async () => {
  // The discriminator: refs are present (TREE_ONE_BUTTON has an interactive
  // button) so a buggy gate that fires the annotate hop on \"refs > 0\" would
  // round-trip a second time. Round 10 gates on the enum value, not refs.
  const { ctx, calls } = makeCtx([
    {
      tree: TREE_ONE_BUTTON,
      screenshot: { format: "jpeg", dataBase64: "raw-bytes", resizedTo: undefined },
      cssViewport: { w: 1024, h: 768 },
    },
  ]);
  ctx.session.lastLeasedTab = 3;
  const out = await runUnifiedCapture(ctx, 3, {
    detail: "standard",
    limit: 500,
    viewportOnly: false,
    screenshot: "raw",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.equal(calls.length, 1, "annotate_image must NOT fire on screenshot:\"raw\"");
  assert.equal(calls[0].command.withScreenshot, true);
  assert.equal(out.image.data, "raw-bytes", "image carries the unannotated capture bytes");
  assert.ok(out.payload.tree, "tree still returns alongside the raw image");
});

// ── scope (per-call subtree drill-down) ──────────────────────────────────────

const TREE_NESTED = {
  nodeId: "root",
  role: "WebArea",
  name: "T",
  depth: 0,
  cssViewport: { w: 1024, h: 768 },
  children: [
    {
      nodeId: "10",
      role: "region",
      name: "Sidebar",
      depth: 1,
      inViewport: true,
      children: [
        { nodeId: "11", role: "button", name: "Menu", depth: 2, inViewport: true, children: [] },
      ],
    },
    {
      nodeId: "20",
      role: "region",
      name: "Main",
      depth: 1,
      inViewport: true,
      children: [
        { nodeId: "21", role: "button", name: "Go", depth: 2, inViewport: true, children: [] },
        { nodeId: "f1:5", role: "button", name: "InFrame", depth: 2, inViewport: true, children: [] },
      ],
    },
  ],
};

function treeOpts(extra = {}) {
  return {
    detail: "standard",
    limit: 500,
    viewportOnly: false,
    screenshot: "off",
    quality: 70,
    save_to_path: false,
    withTree: true,
    ...extra,
  };
}

test("scope selects the raw subtree: out-of-scope refs absent, meta.scope surfaced", async () => {
  const { ctx } = makeCtx([{ tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } }]);
  ctx.session.lastLeasedTab = 7;
  ctx.session.lastSnapshotTabId = 7; // scope requires a prior snapshot of the SAME tab
  const out = await runUnifiedCapture(ctx, 7, treeOpts({ scope: "20" }));
  assert.match(out.payload.tree, /\[ref=21\]/, "in-scope child present");
  assert.ok(!out.payload.tree.includes("[ref=11]"), "out-of-scope node must be absent");
  assert.ok(!out.payload.tree.includes("Sidebar"), "out-of-scope region must be absent");
  assert.equal(out.payload.meta.scope, "20");
  // lastSnapshotRefs is scope-only (the annotation-hop rect source).
  assert.ok(ctx.session.lastSnapshotRefs.has("21"));
  assert.ok(!ctx.session.lastSnapshotRefs.has("11"));
});

test("scope accepts an fN: ref (cross-origin splice)", async () => {
  const { ctx } = makeCtx([{ tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } }]);
  ctx.session.lastLeasedTab = 7;
  ctx.session.lastSnapshotTabId = 7;
  const out = await runUnifiedCapture(ctx, 7, treeOpts({ scope: "f1:5", includeCrossOriginFrames: true }));
  assert.match(out.payload.tree, /InFrame/);
  assert.equal(out.payload.meta.scope, "f1:5");
});

test("a scoped snapshot does NOT update the diff baseline (lastPrunedTree)", async () => {
  const { ctx } = makeCtx([
    { tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } },
    { tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } },
  ]);
  ctx.session.lastLeasedTab = 7;
  // Full snapshot establishes the baseline…
  await runUnifiedCapture(ctx, 7, treeOpts());
  const baseline = ctx.session.lastPrunedTree;
  assert.ok(baseline, "full snapshot must set the baseline");
  // …a scoped snapshot must leave it untouched.
  await runUnifiedCapture(ctx, 7, treeOpts({ scope: "20" }));
  assert.equal(ctx.session.lastPrunedTree, baseline, "scoped snapshot must not replace the baseline");
  assert.equal(ctx.session.lastPrunedTreeTabId, 7);
});

test("scope not found → actionable error naming the recovery paths", async () => {
  const { ctx } = makeCtx([{ tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } }]);
  ctx.session.lastLeasedTab = 7;
  ctx.session.lastSnapshotTabId = 7;
  await assert.rejects(
    runUnifiedCapture(ctx, 7, treeOpts({ scope: "999" })),
    (err) => {
      assert.match(err.message, /scope ref 999 not found/);
      assert.match(err.message, /removed/);
      assert.match(err.message, /includeCrossOriginFrames/);
      assert.match(err.message, /without 'scope'/);
      return true;
    },
  );
});

// Cross-tab guard: page-side ids are per-tab and collide across tabs, so a
// scope ref from another tab (or with no prior snapshot at all) must error
// loudly instead of silently scoping to the wrong element.
test("scope on a tab that was not last-snapshotted → cross-tab error, no silent wrong subtree", async () => {
  const { ctx } = makeCtx([{ tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } }]);
  ctx.session.lastLeasedTab = 7;
  ctx.session.lastSnapshotTabId = 3; // ref "20" was minted on tab 3
  await assert.rejects(
    runUnifiedCapture(ctx, 7, treeOpts({ scope: "20" })),
    (err) => {
      assert.match(err.message, /tab 3/);
      assert.match(err.message, /browser_snapshot on tab 7 first/);
      return true;
    },
  );
});

test("scope with no prior snapshot at all → actionable error", async () => {
  const { ctx } = makeCtx([{ tree: TREE_NESTED, screenshot: undefined, cssViewport: { w: 1024, h: 768 } }]);
  ctx.session.lastLeasedTab = 7;
  await assert.rejects(
    runUnifiedCapture(ctx, 7, treeOpts({ scope: "20" })),
    /no tab/,
  );
});

// CP3 — the pruner's recovery notice (set on any cap-ladder reduction) must be
// inlined as the outline's first line, prefixed "NOTE: ". limit:1 on a 2-node
// tree trips the ladder deterministically with no real page.
test("meta.notice is inlined as the outline's first line (NOTE: prefix)", async () => {
  const { ctx } = makeCtx([
    { tree: TREE_ONE_BUTTON, screenshot: undefined, cssViewport: { w: 1024, h: 768 } },
  ]);
  ctx.session.lastLeasedTab = 5;
  const out = await runUnifiedCapture(ctx, 5, {
    detail: "standard",
    limit: 1,
    viewportOnly: false,
    screenshot: "off",
    quality: 70,
    save_to_path: false,
    withTree: true,
  });
  assert.ok(out.payload.meta.truncated, "prefix cut surfaces meta.truncated");
  assert.equal(out.payload.meta.truncated.shown, 1);
  assert.equal(out.payload.meta.truncated.total, 2);
  assert.match(out.payload.meta.notice, /first omitted/i, "meta carries the recovery notice");
  assert.ok(
    out.payload.tree.startsWith("NOTE: "),
    `outline must lead with the NOTE: line, got: ${out.payload.tree.slice(0, 40)}`,
  );
  assert.match(out.payload.tree.split("\n")[0], /first omitted/i, "NOTE: line carries the notice text");
});
