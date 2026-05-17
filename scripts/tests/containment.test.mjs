// `computeDrawStroke` — containment-based parent-bbox suppression for the
// annotated screenshot pipeline. Pure function; no canvas/extension needed.

import test from "node:test";
import assert from "node:assert/strict";
import { computeDrawStroke } from "../../dist/test-exports.mjs";

const r = (x, y, w, h) => ({ rect: { x, y, w, h } });

test("single rect → drawStroke:[true]", () => {
  assert.deepEqual(computeDrawStroke([r(0, 0, 100, 100)]), [true]);
});

test("two non-overlapping rects → both stroked", () => {
  assert.deepEqual(
    computeDrawStroke([r(0, 0, 50, 50), r(200, 200, 50, 50)]),
    [true, true],
  );
});

test("parent fully contains child → parent suppressed, child stroked", () => {
  // a (0,0,100,100) strictly contains b (10,10,20,20).
  const out = computeDrawStroke([r(0, 0, 100, 100), r(10, 10, 20, 20)]);
  assert.deepEqual(out, [false, true]);
});

test("three-level nesting → only the innermost leaf is stroked", () => {
  // root contains mid contains leaf.
  const out = computeDrawStroke([
    r(0, 0, 100, 100),
    r(10, 10, 60, 60),
    r(20, 20, 20, 20),
  ]);
  assert.deepEqual(out, [false, false, true]);
});

test("identical rects → both stroked (strict containment, not equal-bounds)", () => {
  const out = computeDrawStroke([r(0, 0, 100, 100), r(0, 0, 100, 100)]);
  assert.deepEqual(out, [true, true]);
});

test("partial overlap → both stroked (no full containment)", () => {
  const out = computeDrawStroke([r(0, 0, 60, 60), r(40, 40, 60, 60)]);
  assert.deepEqual(out, [true, true]);
});

test("edge-shared rect that is NOT strictly inside → both stroked", () => {
  // b touches a's right edge → not strictly inside (b.x + b.w === aRight).
  const out = computeDrawStroke([r(0, 0, 100, 100), r(50, 0, 50, 100)]);
  assert.deepEqual(out, [true, true]);
});

test("zero-area rect inside a parent → parent still suppressed", () => {
  // Even a degenerate 0x0 child triggers strict containment if its position
  // is strictly inside the parent. The extension's MIN_ANNOTATABLE_PX guard
  // will drop the child's own draw; this test pins the bridge-side logic.
  const out = computeDrawStroke([r(0, 0, 100, 100), r(50, 50, 0, 0)]);
  // b.x(50) > a.x(0) && b.y(50) > a.y(0) && b.x+w(50) < aRight(100) → true.
  assert.deepEqual(out, [false, true]);
});

test("WebArea-root-strokes-viewport regression: viewport-sized root suppressed", () => {
  // Reproduces the Suno live-test observation that motivated this feature:
  // WebArea root spans the whole viewport, and most named children sit
  // inside it. Without suppression every screenshot has a red border around
  // the whole image, which is visual noise the agent never benefits from.
  const root = r(0, 0, 1920, 1080);
  const lyrics = r(500, 120, 600, 200);
  const button = r(1000, 350, 100, 40);
  const sidebar = r(0, 0, 250, 1080); // edge-shared with root → root still contains it (250 < 1920).
  // Sidebar shares x:0/y:0 edges with root → NOT strictly inside, so it
  // alone wouldn't suppress root. But lyrics is strictly inside → suppress.
  const out = computeDrawStroke([root, lyrics, button, sidebar]);
  assert.equal(out[0], false, "WebArea root should be suppressed");
  assert.equal(out[1], true, "lyrics stroke kept (no children)");
  assert.equal(out[2], true, "button stroke kept");
  assert.equal(out[3], true, "sidebar stroke kept (no children)");
});

test("empty input → empty array", () => {
  assert.deepEqual(computeDrawStroke([]), []);
});
