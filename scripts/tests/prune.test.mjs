// Pure-function tests for the Phase 5 snapshot v2 heuristics.
// Run via `npm test` from the package root.

import test from "node:test";
import assert from "node:assert/strict";
import { prune } from "../../dist/test-exports.mjs";

/**
 * Build a minimal RawNode tree from a compact shape. Defaults plug in the
 * boilerplate fields (depth, rect, inViewport, children:[]) so each test can
 * focus on the heuristic under exercise.
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

test("form-field boost ranks textbox-in-form above sidebar nav at the limit boundary", () => {
  // Build a page with 30 sidebar links + a form with a lyrics textarea.
  // With a tight limit, the textarea should still make the cut thanks to the
  // form-subtree boost (Issue #6 regression).
  const sidebar = node({
    nodeId: "s",
    role: "navigation",
    name: "Sidebar",
    depth: 1,
    rect: { x: 0, y: 0, w: 200, h: 800 },
    children: Array.from({ length: 30 }, (_, i) =>
      node({
        nodeId: `s-${i}`,
        role: "link",
        name: `Chat ${i}`,
        depth: 2,
        rect: { x: 0, y: 20 + i * 20, w: 180, h: 18 },
      }),
    ),
  });
  const form = node({
    nodeId: "f",
    role: "form",
    name: "Create song",
    depth: 1,
    rect: { x: 500, y: 100, w: 600, h: 400 },
    children: [
      node({
        nodeId: "lyrics",
        role: "textbox",
        name: "Lyrics",
        depth: 2,
        rect: { x: 500, y: 120, w: 600, h: 200 },
      }),
      node({
        nodeId: "create",
        role: "button",
        name: "Create",
        depth: 2,
        rect: { x: 1000, y: 350, w: 100, h: 40 },
      }),
    ],
  });
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [sidebar, form],
  });
  const out = prune(root, { limit: 12, viewportOnly: false });
  // The lyrics textbox and Create button must both appear despite 30
  // sidebar links being on the page.
  assert.ok(findByRef(out, "lyrics"), "lyrics textbox missing from snapshot");
  assert.ok(findByRef(out, "create"), "Create button missing from snapshot");
});

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

test("detail:'full' at low limit floors to 1000 and surfaces limit_adjusted", () => {
  // A deeply-nested chain of generic divs that, in full mode at a low limit,
  // would normally consume all slots with structural ancestors.
  let cursor = node({ nodeId: "deep-leaf", role: "button", name: "Click me" });
  for (let i = 0; i < 50; i++) {
    cursor = node({
      nodeId: `gen-${i}`,
      role: "generic",
      depth: 50 - i,
      children: [cursor],
    });
  }
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [cursor],
  });
  const out = prune(root, { detail: "full", limit: 30, viewportOnly: false });
  assert.equal(out.meta?.limit_adjusted, 1000);
  // The button must survive — at limit=30 with depth-first traversal it
  // wouldn't have, but the floor lets the interactive leaf through.
  assert.ok(findByRef(out, "deep-leaf"), "interactive leaf missing under full+floor");
});

test("viewportOnly default false: nodes below the fold are included", () => {
  // 30 buttons, half above the fold, half below. With the new default the
  // pruner should rank across the whole page (capped at limit:500).
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
  // No auto-fallback at this size (31 candidates is well under threshold).
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
  // total_candidates still reflects the FULL count (pre-filter) — 30 buttons
  // + the named WebArea root that survives the keep filter.
  assert.equal(out.meta?.total_candidates, 31);
  // Explicit viewportOnly:true → no viewport_fallback surfaced (caller asked).
  assert.equal(out.meta?.viewport_fallback, undefined);
});

test("auto-fallback engages when total_candidates exceeds 3× effectiveLimit", () => {
  // 50 candidates, half inside viewport. limit=10 → threshold=30 → 50 > 30
  // triggers auto-fallback.
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
  const out = prune(root, { limit: 10 });
  // 50 buttons + the named WebArea root.
  assert.equal(out.meta?.total_candidates, 51);
  assert.ok(out.meta?.viewport_fallback, "viewport_fallback meta missing");
  assert.equal(out.meta.viewport_fallback.active, true);
  assert.equal(out.meta.viewport_fallback.reason, "page_too_large");
  assert.equal(out.meta.viewport_fallback.threshold, 30);
  assert.equal(out.meta.viewport_fallback.total_candidates, 51);
  // Off-viewport nodes should be dropped post-fallback.
  for (let i = 25; i < 50; i++) {
    assert.equal(findByRef(out, `b-${i}`), null, `auto-fallback failed to drop off-viewport b-${i}`);
  }
});

test("explicit viewportOnly:true on huge page does NOT surface viewport_fallback", () => {
  // Same shape as the auto-fallback test but caller asked explicitly.
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
  // total_candidates still surfaces (50 buttons + named WebArea root).
  assert.equal(out.meta?.total_candidates, 51);
});

test("auto-fallback threshold uses effectiveLimit (full-mode floor honoured)", () => {
  // detail:'full' + limit:30 → effectiveLimit=1000 → threshold=3000 → 1500
  // candidates is UNDER threshold; no auto-fallback even with huge page.
  const children = Array.from({ length: 1500 }, (_, i) =>
    node({
      nodeId: `n-${i}`,
      role: "button",
      name: `N ${i}`,
      depth: 2,
      inViewport: i < 500,
      rect: { x: 10, y: 10 + i, w: 50, h: 18 },
    }),
  );
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children,
  });
  const out = prune(root, { detail: "full", limit: 30 });
  // limit_adjusted to 1000 → threshold 3000 → 1501 < 3000 → no auto-fallback.
  assert.equal(out.meta?.limit_adjusted, 1000);
  assert.equal(out.meta?.viewport_fallback, undefined);
  // 1500 buttons + the named WebArea root.
  assert.equal(out.meta?.total_candidates, 1501);
});

test("sidebar list with off-axis position is penalised vs central content", () => {
  // Sidebar = 10 same-role children at the LEFT (off-axis) edge.
  const sidebar = node({
    nodeId: "s",
    role: "list",
    depth: 1,
    rect: { x: 0, y: 0, w: 200, h: 800 },
    children: Array.from({ length: 10 }, (_, i) =>
      node({
        nodeId: `s-${i}`,
        role: "listitem",
        name: `Side ${i}`,
        depth: 2,
        rect: { x: 0, y: 20 + i * 20, w: 180, h: 18 },
        siblingSameRoleCount: 10,
      }),
    ),
  });
  // Central article with one big heading.
  const main = node({
    nodeId: "main",
    role: "main",
    depth: 1,
    rect: { x: 640, y: 100, w: 800, h: 600 },
    children: [
      node({
        nodeId: "h",
        role: "heading",
        name: "Center heading",
        depth: 2,
        rect: { x: 640, y: 100, w: 800, h: 50 },
      }),
    ],
  });
  const root = node({
    nodeId: "r",
    role: "WebArea",
    name: "Page",
    children: [sidebar, main],
  });
  // With a tight limit, the central heading must rank above several of the
  // off-axis sidebar items.
  const out = prune(root, { limit: 5, viewportOnly: false });
  assert.ok(findByRef(out, "h"), "central heading missing from snapshot");
});
