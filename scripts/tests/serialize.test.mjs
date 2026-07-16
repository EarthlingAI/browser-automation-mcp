// Compact-outline serializer tests (CP3). Pins the grammar — shape AND content
// — for serializeTree, the function that replaced JSON tree serialization with
// the indented `- role "name" [ref=N]` outline now shipped in payload.tree.

import test from "node:test";
import assert from "node:assert/strict";
import { serializeTree } from "../../dist/test-exports.mjs";

test("basic node — role, name, ref on one line; children indent two spaces", () => {
  const out = serializeTree({
    ref: "1",
    role: "WebArea",
    name: "Home",
    children: [{ ref: "5", role: "button", name: "Submit", children: [] }],
  });
  assert.equal(out, '- WebArea "Home" [ref=1]\n  - button "Submit" [ref=5]');
});

test("name whitespace runs are collapsed to single spaces", () => {
  // Real Wikipedia names carry \n\t\t runs from layout — collapse them.
  const out = serializeTree({ ref: "1", role: "link", name: "7\n\t\t\tFuture\n  section", children: [] });
  assert.equal(out, '- link "7 Future section" [ref=1]');
});

test("embedded double-quotes in a name are escaped", () => {
  const out = serializeTree({ ref: "1", role: "button", name: 'Say "hi"', children: [] });
  assert.equal(out, '- button "Say \\"hi\\"" [ref=1]');
});

test("value renders as = \"...\" after the ref", () => {
  const out = serializeTree({ ref: "7", role: "textbox", name: "Email", value: "a@b.com", children: [] });
  assert.equal(out, '- textbox "Email" [ref=7] = "a@b.com"');
});

test("state flags render in order: checked, selected, disabled, level", () => {
  const out = serializeTree({
    ref: "3",
    role: "checkbox",
    name: "Agree",
    checked: true,
    disabled: true,
    children: [],
  });
  assert.equal(out, '- checkbox "Agree" [ref=3] [checked] [disabled]');
});

test("checked:'mixed' renders [mixed], not [checked]", () => {
  const out = serializeTree({ ref: "3", role: "checkbox", checked: "mixed", children: [] });
  assert.equal(out, "- checkbox [ref=3] [mixed]");
});

test("selected + level both render, in field order", () => {
  const out = serializeTree({ ref: "9", role: "heading", name: "H", level: 2, selected: true, children: [] });
  assert.equal(out, '- heading "H" [ref=9] [selected] [level=2]');
});

test("occluded renders [occluded] after [disabled], before [level]", () => {
  const out = serializeTree({
    ref: "4",
    role: "button",
    name: "Ghost",
    disabled: true,
    occluded: true,
    level: 3,
    children: [],
  });
  assert.equal(out, '- button "Ghost" [ref=4] [disabled] [occluded] [level=3]');
});

test("values[] collapse renders joined, quoted, on one line", () => {
  const out = serializeTree({
    ref: "288",
    role: "row",
    values: ["Machine learning", "Symbolic", "Deep learning"],
    children: [],
  });
  assert.equal(out, '- row [ref=288] values: "Machine learning", "Symbolic", "Deep learning"');
});

test("rowsShown renders '(showing X of Y rows)' on the table line", () => {
  const out = serializeTree({
    ref: "40",
    role: "table",
    rowsShown: { shown: 6, total: 20 },
    children: [{ ref: "41", role: "row", values: ["a", "b"], children: [] }],
  });
  assert.equal(
    out,
    '- table [ref=40] (showing 6 of 20 rows)\n  - row [ref=41] values: "a", "b"',
  );
});

test("an empty-cell value renders as an empty quoted slot (column alignment)", () => {
  const out = serializeTree({
    ref: "41",
    role: "row",
    values: ["China", "", "17.5%"],
    children: [],
  });
  assert.equal(out, '- row [ref=41] values: "China", "", "17.5%"');
});

test("a node without a name omits the quoted segment", () => {
  const out = serializeTree({ ref: "11", role: "link", children: [] });
  assert.equal(out, "- link [ref=11]");
});

test("a whitespace-only name is treated as empty (no quotes)", () => {
  const out = serializeTree({ ref: "11", role: "generic", name: "  \n\t ", children: [] });
  assert.equal(out, "- generic [ref=11]");
});

test("the synthetic root (ref '0') prints no [ref] tag", () => {
  // populateRefs never registers "0" as an actionable ref — the outline must
  // not advertise a handle the agent can't act on.
  const out = serializeTree({
    ref: "0",
    role: "WebArea",
    children: [{ ref: "2", role: "link", name: "A", children: [] }],
  });
  assert.equal(out, '- WebArea\n  - link "A" [ref=2]');
});

test("nesting indents two spaces per depth", () => {
  const out = serializeTree({
    ref: "1",
    role: "WebArea",
    children: [
      { ref: "2", role: "list", children: [{ ref: "3", role: "listitem", name: "x", children: [] }] },
    ],
  });
  assert.equal(out, '- WebArea [ref=1]\n  - list [ref=2]\n    - listitem "x" [ref=3]');
});

test("a leaf with no children and no extra fields is just role + ref", () => {
  const out = serializeTree({ ref: "1", role: "WebArea" });
  assert.equal(out, "- WebArea [ref=1]");
});

test("cross-origin frame leaf renders a loud not-descended boundary marker", () => {
  const out = serializeTree({
    ref: "12",
    role: "iframe",
    name: "https://cc.sans.org/dispatch",
    crossOrigin: true,
    frameUrl: "https://cc.sans.org/dispatch",
    children: [],
  });
  assert.equal(
    out,
    '- iframe "https://cc.sans.org/dispatch" [ref=12] [cross-origin frame — not descended]',
  );
});

test("descended cross-origin frame (Phase 4b) renders the descended marker, not the recovery hint", () => {
  const out = serializeTree({
    ref: "12",
    role: "iframe",
    name: "https://cc.sans.org/dispatch",
    frameDescended: true,
    frameUrl: "https://cc.sans.org/dispatch",
    children: [{ ref: "f1:7", role: "region", name: "Learning Content", children: [] }],
  });
  assert.equal(
    out,
    '- iframe "https://cc.sans.org/dispatch" [ref=12] [cross-origin frame — descended]\n' +
      '  - region "Learning Content" [ref=f1:7]',
  );
});

test("crossOrigin takes precedence over frameDescended if both are set (mutually exclusive marker)", () => {
  // The extension clears crossOrigin on successful descent so only one is ever
  // set; this pins the serializer's else-if so a stale crossOrigin never
  // produces two markers on one line.
  const out = serializeTree({
    ref: "12",
    role: "iframe",
    name: "https://cc.sans.org/dispatch",
    crossOrigin: true,
    frameDescended: true,
    children: [],
  });
  assert.equal(
    out,
    '- iframe "https://cc.sans.org/dispatch" [ref=12] [cross-origin frame — not descended]',
  );
});
