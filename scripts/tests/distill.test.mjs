// Lossless-distillation tests (snapshot/distill.ts). Pins the five rules, the
// hard safety rule (invariant #38 — fact-bearing nodes are immune), root
// immunity, ref retention on merge, and idempotence.

import test from "node:test";
import assert from "node:assert/strict";
import { distill } from "../../dist/test-exports.mjs";

const textNode = (ref, name) => ({ ref, role: "text", name, children: [] });
const n = (spec) => ({ children: [], ...spec });

function flatten(tree) {
  const out = [tree];
  for (const c of tree.children ?? []) out.push(...flatten(c));
  return out;
}

// ── Rule 1: merge adjacent text children ────────────────────────────────────

test("adjacent leaf text children merge into one, space-joined, keeping the FIRST ref", () => {
  const out = distill(
    n({
      ref: "1",
      role: "paragraph",
      name: "P",
      children: [textNode("2", "Machine learning"), textNode("3", "is a field"), textNode("4", "of AI")],
    }),
  );
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].ref, "2", "merged node must carry the first fragment's ref");
  assert.equal(out.children[0].name, "Machine learning is a field of AI");
});

test("a non-text node between text runs breaks the merge", () => {
  const out = distill(
    n({
      ref: "1",
      role: "paragraph",
      name: "P",
      children: [
        textNode("2", "before"),
        n({ ref: "3", role: "link", name: "anchor" }),
        textNode("4", "after"),
      ],
    }),
  );
  assert.equal(out.children.length, 3, "link must not be merged over");
  assert.equal(out.children[0].name, "before");
  assert.equal(out.children[2].name, "after");
});

test("a fact-bearing text node never merges (invariant #38)", () => {
  const out = distill(
    n({
      ref: "1",
      role: "paragraph",
      name: "P",
      children: [textNode("2", "plain"), { ...textNode("3", "selected text"), selected: true }],
    }),
  );
  assert.equal(out.children.length, 2, "selected text node must survive unmerged");
  assert.equal(out.children[1].selected, true);
});

// ── Rule 2: text child restating the parent's name ──────────────────────────

test("a leaf text child whose name equals the parent's name is dropped", () => {
  const out = distill(
    n({
      ref: "1",
      role: "heading",
      name: "Welcome",
      children: [textNode("2", "Welcome")],
    }),
  );
  assert.equal(out.children, undefined, "redundant text child must be dropped");
  assert.equal(out.name, "Welcome");
});

test("a text child with a DIFFERENT name is kept", () => {
  const out = distill(
    n({ ref: "1", role: "heading", name: "Welcome", children: [textNode("2", "Subtitle")] }),
  );
  assert.equal(out.children.length, 1);
});

// ── Rule 3: decorative images ────────────────────────────────────────────────

test("a nameless childless image is dropped; a named one is kept", () => {
  const out = distill(
    n({
      ref: "1",
      role: "figure",
      name: "F",
      children: [
        n({ ref: "2", role: "image" }),
        n({ ref: "3", role: "img", name: "Diagram of the pipeline" }),
      ],
    }),
  );
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].ref, "3", "named image must survive");
});

// ── Rule 4: name-repeating generic leaf ──────────────────────────────────────

test("a leaf generic child restating the parent's name is dropped", () => {
  const out = distill(
    n({
      ref: "1",
      role: "listitem",
      name: "Item one",
      children: [n({ ref: "2", role: "generic", name: "Item one" })],
    }),
  );
  assert.equal(out.children, undefined);
});

// ── Rule 5: unwrap single-child unnamed generics ─────────────────────────────

test("a single-child unnamed fact-free generic unwraps to its child", () => {
  const out = distill(
    n({
      ref: "1",
      role: "main",
      name: "M",
      children: [
        n({
          ref: "2",
          role: "generic",
          children: [n({ ref: "3", role: "button", name: "Go" })],
        }),
      ],
    }),
  );
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].ref, "3", "wrapper must unwrap to the button");
  assert.equal(out.children[0].role, "button");
});

test("chained wrappers unwrap transitively in one pass", () => {
  const out = distill(
    n({
      ref: "1",
      role: "main",
      name: "M",
      children: [
        n({
          ref: "2",
          role: "generic",
          children: [
            n({
              ref: "3",
              role: "generic",
              children: [n({ ref: "4", role: "button", name: "Go" })],
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(out.children[0].ref, "4");
});

test("a NAMED generic wrapper is not unwrapped", () => {
  const out = distill(
    n({
      ref: "1",
      role: "main",
      name: "M",
      children: [
        n({
          ref: "2",
          role: "generic",
          name: "Card",
          children: [n({ ref: "3", role: "button", name: "Go" })],
        }),
      ],
    }),
  );
  assert.equal(out.children[0].ref, "2", "named wrapper must stay");
});

test("a multi-child generic wrapper is not unwrapped", () => {
  const out = distill(
    n({
      ref: "1",
      role: "main",
      name: "M",
      children: [
        n({
          ref: "2",
          role: "generic",
          children: [
            n({ ref: "3", role: "button", name: "A" }),
            n({ ref: "4", role: "button", name: "B" }),
          ],
        }),
      ],
    }),
  );
  assert.equal(out.children[0].ref, "2");
  assert.equal(out.children[0].children.length, 2);
});

// ── Invariant #38: fact-bearing nodes are immune to every rule ───────────────

test("fact-bearing leaves are never dropped even when name-redundant or nameless", () => {
  const root = n({
    ref: "1",
    role: "region",
    name: "Card",
    children: [
      // Name-redundant BUT interactive → immune to rule 2/4.
      n({ ref: "2", role: "button", name: "Card" }),
      // Nameless image BUT carries a value → immune to rule 3.
      n({ ref: "3", role: "image", value: "chart.png" }),
      // Name-redundant text BUT occluded → immune.
      { ...textNode("4", "Card"), occluded: true },
      // Single-child generic BUT disabled → immune to rule 5.
      n({ ref: "5", role: "generic", disabled: true, children: [n({ ref: "6", role: "button", name: "X" })] }),
    ],
  });
  const out = distill(root);
  for (const ref of ["2", "3", "4", "5", "6"])
    assert.ok(flatten(out).some((x) => x.ref === ref), `fact-bearing node ${ref} must survive`);
});

test("data-role nodes (row/listitem) and values-collapsed nodes are immune", () => {
  const out = distill(
    n({
      ref: "1",
      role: "table",
      name: "T",
      children: [
        n({ ref: "2", role: "row", values: ["a", "b"] }),
        n({ ref: "3", role: "listitem", name: "T" }), // name-redundant but data role
      ],
    }),
  );
  assert.equal(out.children.length, 2);
});

// ── Root immunity ────────────────────────────────────────────────────────────

test("the root is never unwrapped even when it qualifies", () => {
  const root = n({
    ref: "0",
    role: "generic",
    children: [n({ ref: "2", role: "button", name: "Only" })],
  });
  const out = distill(root);
  assert.equal(out.ref, "0", "root must survive");
  assert.equal(out.children[0].ref, "2");
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test("distill is idempotent: distill(distill(t)) equals distill(t)", () => {
  const t = n({
    ref: "1",
    role: "main",
    name: "M",
    children: [
      textNode("2", "a"),
      textNode("3", "b"),
      n({ ref: "4", role: "generic", children: [textNode("5", "M")] }),
      n({ ref: "6", role: "image" }),
      n({ ref: "7", role: "generic", children: [n({ ref: "8", role: "button", name: "Go" })] }),
    ],
  });
  const once = distill(t);
  const twice = distill(once);
  assert.deepEqual(twice, once);
});

test("distill does not mutate its input tree", () => {
  const t = n({
    ref: "1",
    role: "main",
    name: "M",
    children: [textNode("2", "a"), textNode("3", "b")],
  });
  const snapshot = JSON.stringify(t);
  distill(t);
  assert.equal(JSON.stringify(t), snapshot, "input must be untouched");
});

test("idempotence under rule interaction: a dropped image between text runs re-merges in ONE call", () => {
  // Regression: dropping the nameless image (rule 3) makes "hello"/"world"
  // newly adjacent; a single merge-then-filter pass left them unmerged, so
  // distill(distill(t)) differed from distill(t). Rules now iterate to a
  // fixpoint per node.
  const t = n({
    ref: "1",
    role: "main",
    name: "M",
    children: [
      textNode("2", "hello"),
      n({ ref: "3", role: "image" }), // nameless decorative image — dropped
      textNode("4", "world"),
    ],
  });
  const once = distill(t);
  assert.equal(once.children.length, 1, "texts must merge across the dropped image in one call");
  assert.equal(once.children[0].name, "hello world");
  assert.equal(once.children[0].ref, "2");
  assert.deepEqual(distill(once), once, "idempotent");
});

test("idempotence under rule interaction: a merge producing a parent-restating leaf drops in ONE call", () => {
  const t = n({
    ref: "1",
    role: "heading",
    name: "Machine learning",
    children: [textNode("2", "Machine"), textNode("3", "learning")],
  });
  const once = distill(t);
  assert.equal(once.children, undefined, "merged restating leaf must drop in the same call");
  assert.deepEqual(distill(once), once, "idempotent");
});
