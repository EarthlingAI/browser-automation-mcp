// Pure-function tests for the deterministic snapshot pruner: facts-only
// keep-rules, document order, the loud cap ladder (viewport fallback → prefix
// cut), and flag passthrough. Run via `npm test` from the package root.

import test from "node:test";
import assert from "node:assert/strict";
import { prune } from "../../dist/test-exports.mjs";

/**
 * Build a minimal RawNode tree from a compact shape. Defaults plug in the
 * boilerplate fields (depth, rect, inViewport, children:[]) so each test can
 * focus on the behaviour under exercise.
 */
function node(spec) {
  const {
    nodeId,
    role,
    name,
    depth = 0,
    rect = { x: 200, y: 200, w: 200, h: 40 },
    inViewport = true,
    children = [],
    ...rest
  } = spec;
  return {
    nodeId,
    role,
    name,
    depth,
    rect,
    inViewport,
    children,
    ...rest,
  };
}

function findByRef(tree, ref) {
  if (tree.ref === ref) return tree;
  for (const c of tree.children ?? []) {
    const m = findByRef(c, ref);
    if (m) return m;
  }
  return null;
}

function flatten(tree) {
  const out = [tree];
  for (const c of tree.children ?? []) out.push(...flatten(c));
  return out;
}

// ── Facts-only keep-rules ────────────────────────────────────────────────────

test("cookie banner collapses to a single placeholder", () => {
  // Build a OneTrust-style consent banner subtree with 20 children. The
  // pruner should collapse it to one placeholder.
  const banner = node({
    nodeId: "ot",
    role: "dialog",
    name: "Cookie Consent Preferences",
    position: "fixed",
    depth: 1,
    rect: { x: 0, y: 600, w: 1920, h: 480 },
    children: Array.from({ length: 20 }, (_, i) =>
      node({
        nodeId: `ot-${i}`,
        role: "button",
        name: `Pref ${i}`,
        depth: 2,
      }),
    ),
  });
  const article = node({
    nodeId: "a",
    role: "main",
    name: "Article",
    depth: 1,
    rect: { x: 200, y: 0, w: 800, h: 600 },
    children: [
      node({
        nodeId: "h",
        role: "heading",
        name: "Welcome",
        depth: 2,
      }),
    ],
  });
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [banner, article],
  });
  const out = prune(root, { limit: 100, viewportOnly: false });
  const flat = flatten(out);
  // None of the original cookie-banner buttons should make it through.
  for (let i = 0; i < 20; i++) {
    assert.equal(
      flat.find((n) => n.ref === `ot-${i}`),
      undefined,
      `cookie banner child ot-${i} leaked through prune`,
    );
  }
  // Exactly one placeholder, with role "banner" and the (collapsed) hint.
  const placeholder = flat.find((n) => n.ref === "ot");
  assert.ok(placeholder, "cookie banner placeholder missing");
  assert.equal(placeholder.role, "banner");
  assert.match(placeholder.name ?? "", /collapsed/i);
});

test("aria-hidden subtrees are pruned", () => {
  const hidden = node({
    nodeId: "h",
    role: "region",
    name: "Off-screen drawer",
    ariaHidden: true,
    depth: 1,
    children: [
      node({ nodeId: "h-btn", role: "button", name: "Inside hidden", depth: 2 }),
    ],
  });
  const visible = node({
    nodeId: "v",
    role: "button",
    name: "Visible button",
    depth: 1,
  });
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [hidden, visible],
  });
  const out = prune(root, { limit: 50, viewportOnly: false });
  assert.equal(findByRef(out, "h-btn"), null, "aria-hidden child leaked through");
  assert.ok(findByRef(out, "v"), "visible button missing");
});

test("named container/landmark is kept (widening) but unnamed structure is not", () => {
  // A named landmark wrapping an interactive item, plus an unnamed generic
  // wrapper. Standard mode keeps the named landmark (structure) while the
  // unnamed wrapper stays out — its kept child re-parents up to the root.
  const named = node({
    nodeId: "region",
    role: "region",
    name: "Comments",
    depth: 1,
    children: [node({ nodeId: "c1", role: "button", name: "Reply", depth: 2 })],
  });
  const unnamed = node({
    nodeId: "wrap",
    role: "generic",
    depth: 1,
    children: [node({ nodeId: "c2", role: "button", name: "Share", depth: 2 })],
  });
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [named, unnamed],
  });
  const out = prune(root, { viewportOnly: false });
  // Named landmark kept, with its interactive child nested under it.
  const region = findByRef(out, "region");
  assert.ok(region, "named region landmark dropped (widening regression)");
  assert.ok(
    (region.children ?? []).some((c) => c.ref === "c1"),
    "region's interactive child not nested under it",
  );
  // Unnamed generic wrapper NOT kept — but its child still surfaces.
  assert.equal(findByRef(out, "wrap"), null, "unnamed generic wrapper leaked into standard mode");
  assert.ok(findByRef(out, "c2"), "interactive child of unnamed wrapper lost");
});

test("within budget, every fact-bearing node is kept — nothing is dropped", () => {
  // 40 named buttons of wildly varying size, all in viewport, well under the
  // default limit. There is no ranking: everything fact-bearing survives.
  const children = Array.from({ length: 40 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      rect: { x: 10, y: 10 + i * 15, w: 10 + (i % 5) * 200, h: 18 },
    }),
  );
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children });
  const out = prune(root); // default limit 1500 → all within budget
  for (let i = 0; i < 40; i++)
    assert.ok(findByRef(out, `b-${i}`), `b-${i} dropped within budget`);
  // Nothing capped → no recovery notice, no cap-ladder meta.
  assert.equal(out.meta?.notice, undefined, "notice set when nothing was capped");
  assert.equal(out.meta?.viewport_fallback, undefined);
  assert.equal(out.meta?.truncated, undefined);
});

// ── Document order ───────────────────────────────────────────────────────────

test("output is in document order — a tiny first sibling stays ahead of a huge later one", () => {
  // The old salience scorer would sort the big button first; document order
  // keeps DOM order regardless of size or name.
  const small = node({
    nodeId: "small",
    role: "button",
    name: "Small",
    depth: 1,
    rect: { x: 100, y: 100, w: 50, h: 20 },
  });
  const big = node({
    nodeId: "big",
    role: "button",
    name: "Big",
    depth: 1,
    rect: { x: 200, y: 200, w: 800, h: 600 },
  });
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [small, big],
  });
  const out = prune(root);
  const order = (out.children ?? []).map((c) => c.ref);
  assert.deepEqual(order, ["small", "big"], "children must appear in document order");
});

test("prefix cut keeps the document-order head, not a salience selection", () => {
  // 10 buttons in document order; limit 4 (root + first 3 buttons). The kept
  // set must be exactly the preorder prefix.
  const children = Array.from({ length: 10 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      rect: { x: 100, y: 100 + i * 20, w: 100 + (9 - i) * 50, h: 18 },
    }),
  );
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children });
  const out = prune(root, { limit: 4 });
  const refs = flatten(out).map((n) => n.ref);
  assert.deepEqual(refs, ["r", "b-0", "b-1", "b-2"], "prefix cut must keep the document-order head");
  assert.equal(out.meta?.truncated?.shown, 4);
  assert.equal(out.meta?.truncated?.total, 11);
  assert.equal(out.meta?.truncated?.first_omitted_ref, "b-3");
});

// ── Viewport handling ────────────────────────────────────────────────────────

test("viewportOnly default false: nodes below the fold are included", () => {
  // 30 buttons, half above the fold, half below. The pruner spans the whole
  // page (capped at the default limit:1500).
  const children = Array.from({ length: 30 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      // First 15 inside viewport, last 15 outside (inViewport:false).
      inViewport: i < 15,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children,
  });
  // No viewportOnly arg → default false.
  const out = prune(root);
  // Below-the-fold buttons should make it in.
  assert.ok(findByRef(out, "b-25"), "below-fold button missing when viewportOnly defaults to false");
  // Meta surfaces total_candidates always (30 buttons + the named WebArea root).
  assert.equal(out.meta?.total_candidates, 31);
  // No fallback at this size (31 is under the limit).
  assert.equal(out.meta?.viewport_fallback, undefined);
});

test("viewportOnly:true filters out non-viewport nodes", () => {
  const children = Array.from({ length: 30 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      inViewport: i < 15,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children,
  });
  const out = prune(root, { viewportOnly: true });
  // Off-viewport buttons should be dropped.
  for (let i = 15; i < 30; i++) {
    assert.equal(findByRef(out, `b-${i}`), null, `off-viewport b-${i} leaked when viewportOnly:true`);
  }
  // total_candidates still reflects the FULL page count (pre-filter) — 30
  // buttons + the named WebArea root that survives the keep filter.
  assert.equal(out.meta?.total_candidates, 31);
  // Explicit viewportOnly:true → no viewport_fallback surfaced (caller asked).
  assert.equal(out.meta?.viewport_fallback, undefined);
});

test("viewport filter always keeps the document root, even when scrolled out", () => {
  // On a scrolled page the root's rect sits at the document top, so the page
  // side reports it out-of-viewport. Dropping it would degrade the tree into a
  // rootless forest (losing the page title) and churn diffs with a phantom
  // "- WebArea" removal on every scroll — the root must survive the gate.
  const children = Array.from({ length: 10 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 1,
      inViewport: i < 5,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Scrolled Page",
    inViewport: false,
    children,
  });
  const out = prune(root, { viewportOnly: true });
  const kept = findByRef(out, "r");
  assert.ok(kept, "document root dropped by the viewport filter");
  assert.equal(kept.name, "Scrolled Page");
  // The gate still applies to everything else.
  for (let i = 5; i < 10; i++)
    assert.equal(findByRef(out, `b-${i}`), null, `off-viewport b-${i} leaked`);
});

test("explicit viewportOnly:true never surfaces viewport_fallback, even over-limit", () => {
  // Same shape as the auto-fallback test but the caller asked explicitly.
  const children = Array.from({ length: 50 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      inViewport: i < 25,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children,
  });
  const out = prune(root, { limit: 10, viewportOnly: true });
  // viewport_fallback only fires on auto-engagement — explicit request is
  // already the desired state and doesn't need surfacing.
  assert.equal(out.meta?.viewport_fallback, undefined);
  // total_candidates still surfaces the full-page count (50 + named root).
  assert.equal(out.meta?.total_candidates, 51);
  // The in-viewport subset (26) still exceeds limit:10 → prefix cut applies.
  assert.equal(out.meta?.truncated?.shown, 10);
  assert.equal(out.meta?.truncated?.total, 26);
});

// ── Cap ladder ───────────────────────────────────────────────────────────────

test("viewport fallback engages when the distilled tree exceeds limit", () => {
  // 50 candidates, half inside viewport. limit=30 → 51 > 30 triggers the
  // fallback; the in-viewport subset (26) fits → no prefix cut.
  const children = Array.from({ length: 50 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      inViewport: i < 25,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children,
  });
  const out = prune(root, { limit: 30 });
  // 50 buttons + the named WebArea root.
  assert.equal(out.meta?.total_candidates, 51);
  assert.ok(out.meta?.viewport_fallback, "viewport_fallback meta missing");
  assert.equal(out.meta.viewport_fallback.active, true);
  assert.equal(out.meta.viewport_fallback.reason, "page_too_large");
  assert.equal(out.meta.viewport_fallback.threshold, 30);
  assert.equal(out.meta.viewport_fallback.total_candidates, 51);
  // In-viewport subset fits within limit → no prefix cut.
  assert.equal(out.meta?.truncated, undefined);
  // Off-viewport nodes should be dropped post-fallback.
  for (let i = 25; i < 50; i++) {
    assert.equal(findByRef(out, `b-${i}`), null, `viewport fallback failed to drop off-viewport b-${i}`);
  }
  // In-viewport nodes all present.
  for (let i = 0; i < 25; i++) {
    assert.ok(findByRef(out, `b-${i}`), `in-viewport b-${i} missing after fallback`);
  }
  assert.ok(out.meta?.notice, "fallback must be loud");
});

test("viewport fallback then prefix cut when even the viewport subset overflows", () => {
  const children = Array.from({ length: 50 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      inViewport: i < 25,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children });
  const out = prune(root, { limit: 10 });
  assert.ok(out.meta?.viewport_fallback, "fallback engages first");
  assert.ok(out.meta?.truncated, "prefix cut applies after fallback");
  // truncated.total is the count of the tree that was cut (viewport subset:
  // 25 in-viewport buttons + the in-viewport root = 26), not the full page.
  assert.equal(out.meta.truncated.total, 26);
  assert.equal(out.meta.truncated.shown, 10);
  assert.equal(flatten(out).filter((n) => n.ref !== undefined).length, 10);
});

test("over-budget prefix cut is loud: meta.truncated + first-omitted ref + recovery levers", () => {
  // 18 in-viewport buttons, tight limit:10 — everything is in the viewport so
  // the fallback is a no-op and is skipped; this is a pure prefix cut.
  const children = Array.from({ length: 18 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      inViewport: true,
      rect: { x: 100, y: 100 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children });
  const out = prune(root, { limit: 10 });
  // 18 buttons + the named WebArea root = 19 candidates; capped to 10.
  assert.equal(out.meta?.total_candidates, 19);
  assert.equal(flatten(out).filter((n) => n.ref !== undefined).length, 10);
  // A no-op viewport pass must not claim it scoped anything.
  assert.equal(out.meta?.viewport_fallback, undefined, "no-op viewport fallback must not surface");
  assert.equal(out.meta?.truncated?.shown, 10);
  assert.equal(out.meta?.truncated?.total, 19);
  assert.equal(out.meta?.truncated?.first_omitted_ref, "b-9");
  // Loud + actionable: names the cut point and every recovery lever.
  assert.ok(out.meta?.notice, "no recovery notice on an over-budget cap");
  assert.match(out.meta.notice, /first omitted/i);
  assert.match(out.meta.notice, /limit/i);
  assert.match(out.meta.notice, /scope/);
  assert.match(out.meta.notice, /save_tree_to_path/);
  assert.match(out.meta.notice, /viewportOnly/);
});

test("empty in-viewport subset skips the fallback and prefix-cuts the full tree", () => {
  // Everything scrolled out of the viewport: the fallback would return an
  // empty snapshot, so the ladder skips it and cuts the full tree instead.
  const children = Array.from({ length: 20 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 2,
      inViewport: false,
      rect: { x: 100, y: 2000 + i * 20, w: 100, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    inViewport: false,
    children,
  });
  const out = prune(root, { limit: 5 });
  assert.equal(out.meta?.viewport_fallback, undefined, "empty viewport subset must not engage the fallback");
  assert.equal(out.meta?.truncated?.shown, 5);
  assert.equal(out.meta?.truncated?.total, 21);
  assert.match(out.meta?.notice ?? "", /viewport/i, "notice must say why the fallback was skipped");
  assert.ok(findByRef(out, "b-0"), "prefix of the FULL tree must be returned");
});

// ── Table-aware rendering ────────────────────────────────────────────────────

const cell = (nodeId, name, extra = {}) =>
  node({ nodeId, role: "cell", name, depth: 3, ...extra });

test("row of simple cells collapses to values — rowheader included, empty cell keeps its column slot", () => {
  const row = node({
    nodeId: "row1",
    role: "row",
    depth: 2,
    children: [
      node({ nodeId: "rh", role: "rowheader", name: "China", depth: 3 }),
      cell("c1", "1,412,000,000"),
      cell("c2", undefined), // empty cell — must contribute "" for alignment
      cell("c3", "17.5%"),
    ],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [row] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const out = prune(root, { limit: 100 });
  const pRow = findByRef(out, "row1");
  assert.ok(pRow, "row missing");
  assert.deepEqual(pRow.values, ["China", "1,412,000,000", "", "17.5%"]);
  assert.equal(pRow.children, undefined, "collapsed row must not keep cell children");
  // The unnamed table node is kept — it anchors scope + the rows annotation.
  assert.ok(findByRef(out, "t"), "unnamed table node must be kept");
});

test("header row collapses too (positional column association), but a sort button keeps it expanded", () => {
  const plainHeader = node({
    nodeId: "hrow",
    role: "row",
    depth: 2,
    children: [
      node({ nodeId: "h1", role: "columnheader", name: "Country", depth: 3 }),
      node({ nodeId: "h2", role: "columnheader", name: "Population", depth: 3 }),
    ],
  });
  const sortableHeader = node({
    nodeId: "srow",
    role: "row",
    depth: 2,
    children: [
      node({ nodeId: "s1", role: "columnheader", name: "Country", depth: 3 }),
      node({
        nodeId: "s2",
        role: "columnheader",
        name: "Population",
        depth: 3,
        children: [node({ nodeId: "sort", role: "button", name: "Sort", depth: 4 })],
      }),
    ],
  });
  const table = node({
    nodeId: "t",
    role: "table",
    depth: 1,
    children: [plainHeader, sortableHeader],
  });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const out = prune(root, { limit: 100 });
  assert.deepEqual(findByRef(out, "hrow").values, ["Country", "Population"]);
  const sortable = findByRef(out, "srow");
  assert.equal(sortable.values, undefined, "row with an interactive cell must stay expanded");
  assert.ok(findByRef(out, "sort"), "sort button must keep a targetable ref");
});

test("a cell containing a link keeps the row expanded (refs stay targetable)", () => {
  const row = node({
    nodeId: "row1",
    role: "row",
    depth: 2,
    children: [
      node({
        nodeId: "c1",
        role: "cell",
        name: "China",
        depth: 3,
        children: [node({ nodeId: "lnk", role: "link", name: "China", depth: 4 })],
      }),
      cell("c2", "1,412,000,000"),
    ],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [row] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const out = prune(root, { limit: 100 });
  const pRow = findByRef(out, "row1");
  assert.equal(pRow.values, undefined, "link-bearing row must stay expanded");
  assert.ok(findByRef(out, "lnk"), "link inside the cell must survive with a ref");
});

test("a row that IS the pruned root never collapses — scoping to a row recovers its cell refs", () => {
  // Simulates scope:"<rowRef>" — the raw subtree handed to prune() is the row.
  const row = node({
    nodeId: "row1",
    role: "row",
    depth: 0,
    children: [
      node({ nodeId: "rh", role: "rowheader", name: "China", depth: 1 }),
      cell("c1", "1,412,000,000", { depth: 1 }),
    ],
  });
  const out = prune(row, { limit: 100 });
  assert.equal(out.ref, "row1");
  assert.equal(out.values, undefined, "root row must not collapse");
  assert.ok(findByRef(out, "rh"), "rowheader ref must be recoverable");
  assert.ok(findByRef(out, "c1"), "cell ref must be recoverable");
});

test("rowsShown annotates a table whose rows were cut by the ladder", () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    node({
      nodeId: `row-${i}`,
      role: "row",
      depth: 2,
      children: [cell(`a-${i}`, `Name ${i}`), cell(`b-${i}`, `${i * 100}`)],
    }),
  );
  const table = node({ nodeId: "t", role: "table", depth: 1, children: rows });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  // Collapsed tree = root + table + 20 rows = 22 nodes; limit 8 → prefix cut
  // keeps root, table, and the first 6 rows.
  const out = prune(root, { limit: 8 });
  assert.ok(out.meta?.truncated, "ladder must have cut");
  const pTable = findByRef(out, "t");
  assert.deepEqual(pTable.rowsShown, { shown: 6, total: 20 });
  // Kept rows are the document-order head.
  assert.ok(findByRef(out, "row-0") && findByRef(out, "row-5"));
  assert.equal(findByRef(out, "row-6"), null);
});

test("a collapsed row's textContent-mashed name is dropped (values already carry it)", () => {
  const row = node({
    nodeId: "row1",
    role: "row",
    name: "China1,412,000,000", // textContent fallback = cells mashed together
    depth: 2,
    children: [cell("c1", "China"), cell("c2", "1,412,000,000")],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [row] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const pRow = findByRef(prune(root, { limit: 100 }), "row1");
  assert.deepEqual(pRow.values, ["China", "1,412,000,000"]);
  assert.equal(pRow.name, undefined, "restated name must be dropped");
});

test("a collapsed row's AUTHORED label survives (says something the cells don't)", () => {
  const row = node({
    nodeId: "row1",
    role: "row",
    name: "Most populous country", // aria-label-style authored name
    depth: 2,
    children: [cell("c1", "China"), cell("c2", "1,412,000,000")],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [row] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const pRow = findByRef(prune(root, { limit: 100 }), "row1");
  assert.equal(pRow.name, "Most populous country");
  assert.deepEqual(pRow.values, ["China", "1,412,000,000"]);
});

test("an uncut table gets no rowsShown annotation", () => {
  const rows = Array.from({ length: 3 }, (_, i) =>
    node({
      nodeId: `row-${i}`,
      role: "row",
      depth: 2,
      children: [cell(`a-${i}`, `Name ${i}`), cell(`b-${i}`, `${i}`)],
    }),
  );
  const table = node({ nodeId: "t", role: "table", depth: 1, children: rows });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const out = prune(root, { limit: 100 });
  assert.equal(findByRef(out, "t").rowsShown, undefined);
});

test("an AUTHORED label containing cell values as substrings survives (short numeric cells)", () => {
  // Regression: the old per-value `includes` containment dropped this label —
  // "1","0","2" are each substrings of "2010". The mash test is now equality
  // of the whitespace-stripped name vs the concatenated values.
  const row = node({
    nodeId: "row1",
    role: "row",
    name: "2010 Olympics medal results",
    depth: 2,
    children: [cell("c1", "1"), cell("c2", "0"), cell("c3", "2")],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [row] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const pRow = findByRef(prune(root, { limit: 100 }), "row1");
  assert.equal(pRow.name, "2010 Olympics medal results", "authored label must survive");
  assert.deepEqual(pRow.values, ["1", "0", "2"]);
});

test("a whitespace-separated textContent mash is still dropped (stripped equality)", () => {
  const row = node({
    nodeId: "row1",
    role: "row",
    name: "China 1,412,000,000", // mash with a space between cell texts
    depth: 2,
    children: [cell("c1", "China"), cell("c2", "1,412,000,000")],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [row] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const pRow = findByRef(prune(root, { limit: 100 }), "row1");
  assert.equal(pRow.name, undefined, "whitespace-variant mash must still drop");
});

test("rowsShown counts THIS table's rows only — a nested table is not double-counted", () => {
  // Outer table: 2 own rows; the second row's cell wraps an inner 10-row table.
  const innerRows = Array.from({ length: 10 }, (_, i) =>
    node({
      nodeId: `in-${i}`,
      role: "row",
      depth: 5,
      children: [node({ nodeId: `ic-${i}`, role: "cell", name: `v${i}`, depth: 6 })],
    }),
  );
  const inner = node({ nodeId: "inner", role: "table", depth: 4, children: innerRows });
  const outer = node({
    nodeId: "outer",
    role: "table",
    depth: 1,
    children: [
      node({ nodeId: "or-0", role: "row", depth: 2, children: [cell("oc-0", "first")] }),
      node({
        nodeId: "or-1",
        role: "row",
        depth: 2,
        children: [node({ nodeId: "oc-1", role: "cell", name: "wrap", depth: 3, children: [inner] })],
      }),
    ],
  });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [outer] });
  // Cut low enough to drop inner rows; the OUTER total must stay 2, not 12.
  const out = prune(root, { limit: 9 });
  assert.ok(out.meta?.truncated, "ladder must have cut");
  const pOuter = findByRef(out, "outer");
  assert.ok(
    !pOuter.rowsShown || pOuter.rowsShown.total === 2,
    `outer table must not count nested-table rows (got ${JSON.stringify(pOuter.rowsShown)})`,
  );
  const pInner = findByRef(out, "inner");
  if (pInner?.rowsShown) {
    assert.equal(pInner.rowsShown.total, 10, "inner table counts its own rows");
  }
});

test("an expanded header row's EMPTY cell survives when the table has collapsed rows (values alignment)", () => {
  // Header stays expanded (sort button) and has an empty corner columnheader;
  // data rows collapse with a leading rowheader slot. Distill rule 3b must NOT
  // drop the empty header cell — its position aligns with the data rows' first
  // value slot.
  const header = node({
    nodeId: "hrow",
    role: "row",
    depth: 2,
    children: [
      node({ nodeId: "h0", role: "columnheader", name: undefined, depth: 3 }), // empty corner
      node({ nodeId: "h1", role: "columnheader", name: "Name", depth: 3 }),
      node({
        nodeId: "h2",
        role: "columnheader",
        name: "Age",
        depth: 3,
        children: [node({ nodeId: "sort", role: "button", name: "Sort", depth: 4 })],
      }),
    ],
  });
  const dataRow = node({
    nodeId: "drow",
    role: "row",
    depth: 2,
    children: [
      node({ nodeId: "rh", role: "rowheader", name: "r1", depth: 3 }),
      cell("d1", "Alice"),
      cell("d2", "30"),
    ],
  });
  const table = node({ nodeId: "t", role: "table", depth: 1, children: [header, dataRow] });
  const root = node({ nodeId: "r", role: "WebArea", name: "Page", children: [table] });
  const out = prune(root, { limit: 100 });
  assert.deepEqual(findByRef(out, "drow").values, ["r1", "Alice", "30"]);
  const pHeader = findByRef(out, "hrow");
  assert.equal(pHeader.values, undefined, "sort button keeps the header expanded");
  assert.ok(findByRef(out, "h0"), "empty corner header cell must keep its column position");
  assert.equal(pHeader.children.length, 3, "header renders one node per column");
});

// ── Flag passthrough ─────────────────────────────────────────────────────────

test("occluded passes through to the pruned node (fact, not a penalty)", () => {
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Slide",
    children: [
      node({ nodeId: "live", role: "button", name: "Next" }),
      node({ nodeId: "ghost", role: "button", name: "Next", occluded: true }),
    ],
  });
  const out = prune(root, { limit: 50 });
  // Both survive — occlusion is reported, never used to drop or reorder.
  assert.equal(findByRef(out, "live").occluded, undefined);
  assert.equal(findByRef(out, "ghost").occluded, true);
  const order = (out.children ?? []).map((c) => c.ref);
  assert.deepEqual(order, ["live", "ghost"], "occlusion must not reorder");
});

test("occlusion never changes inclusion or position — same ref set/order with or without the flag", () => {
  // Contract clause 2: occlusion is a PURE fact — it must never add or remove a
  // node and never reorder. Pruning two trees that differ ONLY in whether a
  // mid-list node is occluded must yield the identical ref set in the identical
  // document order (the occluded run only gains a boolean field).
  const build = (occludeMiddle) =>
    node({
      nodeId: "r",
      role: "WebArea",
      name: "Slides",
      children: Array.from({ length: 8 }, (_, i) =>
        node({
          nodeId: `b-${i}`,
          role: "button",
          name: `Ctrl ${i}`,
          depth: 1,
          rect: { x: 100, y: 100 + i * 20, w: 120, h: 18 },
          ...(occludeMiddle && i === 4 ? { occluded: true } : {}),
        }),
      ),
    });
  const plain = flatten(prune(build(false), { limit: 100 })).map((n) => n.ref);
  const withOcc = flatten(prune(build(true), { limit: 100 })).map((n) => n.ref);
  assert.deepEqual(withOcc, plain, "occlusion must not add, remove, or reorder any node");
});

// ── Cap-ladder determinism & viewport-gate guard (contract clause 4) ─────────

test("cap ladder is a pure function — identical inputs yield byte-identical output", () => {
  // Contract clause 4: which nodes survive is a pure function of (tree, limit,
  // viewport) — no scores, no tie-breaking heuristics, no run-to-run variation.
  // Pruning the same tree twice must produce structurally identical trees AND
  // identical cap-ladder meta.
  const makeTree = () =>
    node({
      nodeId: "r",
      role: "WebArea",
      name: "Page",
      children: Array.from({ length: 40 }, (_, i) =>
        node({
          nodeId: `b-${i}`,
          role: "button",
          name: `Btn ${i}`,
          depth: 1,
          inViewport: i < 20,
          rect: { x: 100, y: 100 + i * 20, w: 100 + (i % 7) * 40, h: 18 },
        }),
      ),
    });
  const a = prune(makeTree(), { limit: 15 });
  const b = prune(makeTree(), { limit: 15 });
  assert.deepEqual(
    flatten(a).map((n) => n.ref),
    flatten(b).map((n) => n.ref),
    "kept ref set/order must be deterministic across identical runs",
  );
  assert.deepEqual(a.meta?.truncated, b.meta?.truncated, "truncated meta must be deterministic");
  assert.deepEqual(
    a.meta?.viewport_fallback,
    b.meta?.viewport_fallback,
    "viewport_fallback meta must be deterministic",
  );
  assert.equal(a.meta?.notice, b.meta?.notice, "recovery notice must be deterministic");
});

test("viewport retry is declined when the in-viewport subset is only the bare document root", () => {
  // Contract clause 4(a): the viewport retry engages only if it leaves MORE than
  // the bare document root. Here every real node is scrolled out of view, so the
  // viewport subset would collapse to just the root — a useless snapshot. The
  // ladder must decline the fallback and prefix-cut the FULL tree instead, so
  // the agent still sees the document-order head rather than an empty page.
  const children = Array.from({ length: 20 }, (_, i) =>
    node({
      nodeId: `b-${i}`,
      role: "button",
      name: `Btn ${i}`,
      depth: 1,
      inViewport: false, // all below/above the fold
      rect: { x: 100, y: 3000 + i * 20, w: 100, h: 18 },
    }),
  );
  // The root itself IS in the viewport (page top visible) — so the viewport
  // subset is non-empty, but contains ONLY the root.
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    inViewport: true,
    children,
  });
  const out = prune(root, { limit: 5 });
  assert.equal(
    out.meta?.viewport_fallback,
    undefined,
    "root-only viewport subset must not engage the fallback",
  );
  assert.ok(out.meta?.truncated, "the ladder must fall through to a prefix cut of the full tree");
  // A prefix cut of the FULL tree surfaces real content, not just the root.
  assert.ok(findByRef(out, "b-0"), "prefix of the FULL tree must include document-order content");
  assert.equal(out.meta.truncated.total, 21, "cut total is the full tree (root + 20), not the viewport subset");
});

test("cross-origin frame leaf passes crossOrigin + frameUrl through to the pruned tree", () => {
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Course",
    children: [
      node({
        nodeId: "f",
        role: "iframe",
        name: "https://cc.sans.org/dispatch",
        crossOrigin: true,
        frameUrl: "https://cc.sans.org/dispatch",
      }),
    ],
  });
  const out = prune(root, { limit: 50 });
  const leaf = findByRef(out, "f");
  assert.ok(leaf, "named cross-origin leaf is kept");
  assert.equal(leaf.crossOrigin, true);
  assert.equal(leaf.frameUrl, "https://cc.sans.org/dispatch");
});

test("descended cross-origin frame (Phase 4b) passes frameDescended + frameUrl through, not crossOrigin", () => {
  // After executeScript splices the OOPIF subtree, the extension clears
  // crossOrigin and sets frameDescended; the spliced fN: children ride along.
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Course",
    children: [
      node({
        nodeId: "f",
        role: "iframe",
        name: "https://cc.sans.org/dispatch",
        frameDescended: true,
        frameUrl: "https://cc.sans.org/dispatch",
        children: [
          node({ nodeId: "f1:7", role: "region", name: "Learning Content" }),
        ],
      }),
    ],
  });
  const out = prune(root, { limit: 50 });
  const leaf = findByRef(out, "f");
  assert.ok(leaf, "descended cross-origin frame is kept");
  assert.equal(leaf.frameDescended, true);
  assert.equal(leaf.crossOrigin, undefined, "crossOrigin must not leak onto a descended frame");
  assert.equal(leaf.frameUrl, "https://cc.sans.org/dispatch");
  assert.ok(findByRef(out, "f1:7"), "spliced fN: child survives the prune");
});
