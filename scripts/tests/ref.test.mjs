// Ref grammar chokepoint (Phase 4). parseRef / formatRef / compareRefs are the
// single definition of "what a ref looks like" — a bare numeric main-frame ref
// or a cross-origin `fN:localId` OOPIF ref. These pin the round-trip and the
// (frameId, localId) tuple order that replaced the bare `Number(a)-Number(b)`
// sort (which returned NaN for any `fN:` ref).

import test from "node:test";
import assert from "node:assert/strict";
import { parseRef, formatRef, compareRefs } from "../../dist/test-exports.mjs";

test("parseRef: a bare numeric ref is frame 0", () => {
  assert.deepEqual(parseRef("5"), { frameId: 0, localId: 5 });
  assert.deepEqual(parseRef("0"), { frameId: 0, localId: 0 });
  assert.deepEqual(parseRef("142"), { frameId: 0, localId: 142 });
});

test("parseRef: an fN:localId ref carries the frame id", () => {
  assert.deepEqual(parseRef("f2:5"), { frameId: 2, localId: 5 });
  assert.deepEqual(parseRef("f10:3"), { frameId: 10, localId: 3 });
});

test("parseRef: a malformed ref yields NaN localId (caller's fallback signal)", () => {
  assert.equal(Number.isNaN(parseRef("abc").localId), true);
  // `f2:` (missing local id) does not match the frame grammar → bare-parse → NaN
  assert.equal(Number.isNaN(parseRef("f2:").localId), true);
});

test("formatRef: inverse of parseRef; frame 0 stays bare", () => {
  assert.equal(formatRef(0, 5), "5");
  assert.equal(formatRef(2, 5), "f2:5");
  assert.equal(formatRef(10, 3), "f10:3");
});

test("formatRef ∘ parseRef round-trips both forms", () => {
  for (const ref of ["5", "0", "142", "f2:5", "f10:3"]) {
    const p = parseRef(ref);
    assert.equal(formatRef(p.frameId, p.localId), ref);
  }
});

test("compareRefs: bare numeric order matches the old numeric subtraction", () => {
  // Same behaviour the diff sort had before for main-frame refs.
  assert.ok(compareRefs("8", "12") < 0);
  assert.ok(compareRefs("12", "8") > 0);
  assert.equal(compareRefs("5", "5"), 0);
  const refs = ["12", "2", "100", "8", "1"];
  refs.sort(compareRefs);
  assert.deepEqual(refs, ["1", "2", "8", "12", "100"]);
});

test("compareRefs: frame id is the primary key, local id the secondary", () => {
  // Main-frame refs (frame 0) sort before any cross-origin frame.
  const refs = ["f2:1", "5", "f1:9", "f1:2", "1"];
  refs.sort(compareRefs);
  assert.deepEqual(refs, ["1", "5", "f1:2", "f1:9", "f2:1"]);
});

test("compareRefs: a malformed ref sorts last instead of poisoning the order", () => {
  const refs = ["5", "abc", "2"];
  refs.sort(compareRefs);
  assert.deepEqual(refs, ["2", "5", "abc"]);
});
