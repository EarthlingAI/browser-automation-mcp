// Tree-diff serializer tests (CP5). Pins the grammar — shape AND content — for
// serializeDiff, which renders the delta between two pruned trees (keyed by the
// stable+non-evicting ref) as the compact change outline returned on the
// auto-snapshot path. Classification: a ref only in `next` is added (+), a ref
// only in `prev` is removed (-), a ref in both with differing fields is changed
// (~). Unchanged refs are omitted entirely — the whole point of the diff.

import test from "node:test";
import assert from "node:assert/strict";
import { serializeDiff } from "../../dist/test-exports.mjs";

// Two-button base tree (synthetic root + two interactive children).
function tree(children) {
  return { ref: "1", role: "WebArea", name: "App", children };
}
const btn = (ref, name, extra = {}) => ({ ref, role: "button", name, children: [], ...extra });

test("added: a ref present only in next → + line + header count", () => {
  const prev = tree([btn("10", "Open")]);
  const next = tree([btn("10", "Open"), btn("11", "Save")]);
  const out = serializeDiff(prev, next);
  const lines = out.split("\n");
  assert.equal(lines[0], "Δ 1 added, 0 removed, 0 changed");
  assert.equal(lines[1], '+ button "Save" [ref=11]');
  assert.equal(lines.length, 2, "unchanged ref 10 and the root must not appear");
});

test("removed: a ref present only in prev → - line", () => {
  const prev = tree([btn("10", "Open"), btn("8", "Cancel")]);
  const next = tree([btn("10", "Open")]);
  const out = serializeDiff(prev, next);
  assert.equal(out, 'Δ 0 added, 1 removed, 0 changed\n- button "Cancel" [ref=8]');
});

test("changed (value): same ref, value transition → ~ line with old → new", () => {
  // prune drops an empty value (only sets `value` when truthy), so a textbox
  // that gains a value goes undefined → "a@b.com", rendered (none) → "a@b.com".
  const prev = tree([{ ref: "5", role: "textbox", name: "Email", children: [] }]);
  const next = tree([{ ref: "5", role: "textbox", name: "Email", value: "a@b.com", children: [] }]);
  const out = serializeDiff(prev, next);
  assert.equal(
    out,
    'Δ 0 added, 0 removed, 1 changed\n~ textbox "Email" [ref=5] value: (none) → "a@b.com"',
  );
});

test("changed (multi-field): name + checked transitions are semicolon-joined", () => {
  const prev = tree([{ ref: "3", role: "checkbox", name: "Old", checked: false, children: [] }]);
  const next = tree([{ ref: "3", role: "checkbox", name: "New", checked: true, children: [] }]);
  const out = serializeDiff(prev, next);
  assert.equal(
    out,
    'Δ 0 added, 0 removed, 1 changed\n~ checkbox "New" [ref=3] name: "Old" → "New"; checked: false → true',
  );
});

test("changed (state-only): disabled flips with no name/value change", () => {
  const prev = tree([btn("7", "Submit", { disabled: false })]);
  const next = tree([btn("7", "Submit", { disabled: true })]);
  const out = serializeDiff(prev, next);
  assert.equal(out, 'Δ 0 added, 0 removed, 1 changed\n~ button "Submit" [ref=7] disabled: false → true');
});

test("values[] transition renders both sides quoted", () => {
  const prev = tree([{ ref: "20", role: "row", values: ["a", "b"], children: [] }]);
  const next = tree([{ ref: "20", role: "row", values: ["a", "c"], children: [] }]);
  const out = serializeDiff(prev, next);
  assert.equal(out, 'Δ 0 added, 0 removed, 1 changed\n~ row [ref=20] values: "a", "b" → "a", "c"');
});

test("identical trees → Δ no changes (unchanged refs are omitted)", () => {
  const prev = tree([btn("10", "Open"), btn("11", "Save")]);
  const next = tree([btn("10", "Open"), btn("11", "Save")]);
  assert.equal(serializeDiff(prev, next), "Δ no changes");
});

test("synthetic root (ref '0') is never classified as added/removed", () => {
  // Both trees wrap their kids under the synthetic multi-root sentinel. The
  // root must be skipped on both sides — only the real children diff.
  const prev = { ref: "0", role: "WebArea", children: [btn("10", "A")] };
  const next = { ref: "0", role: "WebArea", children: [btn("10", "A"), btn("12", "B")] };
  const out = serializeDiff(prev, next);
  assert.equal(out, 'Δ 1 added, 0 removed, 0 changed\n+ button "B" [ref=12]');
});

test("deeply-nested added node is detected (flatten walks the whole tree)", () => {
  const prev = tree([{ ref: "30", role: "navigation", name: "Nav", children: [btn("31", "Home")] }]);
  const next = tree([
    { ref: "30", role: "navigation", name: "Nav", children: [btn("31", "Home"), btn("32", "About")] },
  ]);
  const out = serializeDiff(prev, next);
  assert.equal(out, 'Δ 1 added, 0 removed, 0 changed\n+ button "About" [ref=32]');
});

test("mixed added + removed + changed: header counts and group/marker order", () => {
  const prev = tree([
    btn("10", "Open"),
    btn("8", "Cancel"),
    { ref: "5", role: "textbox", name: "Q", value: "old", children: [] },
  ]);
  const next = tree([
    btn("10", "Open"), // unchanged → omitted
    btn("14", "Save"), // added
    { ref: "5", role: "textbox", name: "Q", value: "new", children: [] }, // changed
  ]);
  const out = serializeDiff(prev, next);
  const lines = out.split("\n");
  assert.equal(lines[0], "Δ 1 added, 1 removed, 1 changed");
  // Group order: added, then removed, then changed.
  assert.equal(lines[1], '+ button "Save" [ref=14]');
  assert.equal(lines[2], '- button "Cancel" [ref=8]');
  assert.equal(lines[3], '~ textbox "Q" [ref=5] value: "old" → "new"');
  assert.equal(lines.length, 4);
});

test("added lines sort by numeric ref (not string order)", () => {
  const prev = tree([btn("2", "Keep")]);
  const next = tree([btn("2", "Keep"), btn("100", "Big"), btn("9", "Small")]);
  const out = serializeDiff(prev, next);
  const lines = out.split("\n");
  // Numeric sort: 9 before 100 (string sort would put "100" first).
  assert.equal(lines[1], '+ button "Small" [ref=9]');
  assert.equal(lines[2], '+ button "Big" [ref=100]');
});
