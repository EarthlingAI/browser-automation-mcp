/**
 * Accessibility tree pruner — deterministic, document-order, facts-only.
 *
 * Input: a raw a11y tree as produced by the extension's in-DOM walker.
 * Output: a filtered + losslessly-distilled + capped tree in document order,
 * with refs that map 1:1 to the page-side nodeIds.
 *
 * Pipeline (fully deterministic — no scoring, no salience ranking anywhere):
 *   1. collect — DFS preorder walk applying the facts-only keep-rules
 *      (interactive ∪ nav ∪ data roles ∪ any named node; `detail:"full"` keeps
 *      everything), cookie-banner collapse, aria-hidden/inert skip.
 *   2. build   — reconstruct the kept nodes into a tree (nearest kept ancestor).
 *   3. distill — lossless structural compression (see distill.ts): merges and
 *      unwraps redundancy without ever removing a fact-bearing node.
 *   4. cap ladder — if the distilled tree still exceeds `limit`: first retry
 *      scoped to the viewport (`meta.viewport_fallback`), then a document-order
 *      prefix cut (`meta.truncated`). Every reduction is LOUD — a
 *      machine-readable meta twin plus a `notice` naming the exact recovery
 *      levers (`limit`, `scope`, `viewportOnly`, `save_tree_to_path`).
 */

import { distill } from "./distill";
import {
  CELL_ROLES,
  DATA_ROLES,
  INTERACTIVE_ROLES,
  NAV_ROLES,
  TABLE_ROLES,
} from "./roles";

export interface RawNode {
  nodeId?: string;
  role: string;
  name?: string;
  description?: string;
  value?: string;
  checked?: boolean | "mixed";
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  rect?: { x: number; y: number; w: number; h: number };
  inViewport?: boolean;
  depth: number;
  // Extra flags surfaced by helpers.js (extension-side a11y walker). Used by
  // the pruner's deterministic filters — cookie-banner collapse, a11y-hidden
  // filtering, position-fixed overlay detection.
  ariaHidden?: boolean;
  inert?: boolean;
  /** Top-layer `<dialog open>` marker from helpers.js. Not consumed by the
   * pruner today — carried on the raw tree for the modal/environment-awareness
   * work that reads it bridge-side. */
  dialogModal?: boolean;
  position?: string;
  /**
   * Set by helpers.js when this interactive element is NOT the topmost
   * hit-tested element at its own centre — a ghost/under-layer node (e.g. a
   * stale carousel slide kept mounted under the active one). Passed through to
   * the pruned tree and serialized as a loud `[occluded]` flag — the agent
   * sees the fact instead of the node silently ranking lower.
   */
  occluded?: boolean;
  /**
   * Set by helpers.js on a child-frame node whose document could not be
   * traversed (cross-origin SecurityError, too-deep nesting, or unloaded). The
   * subtree is a single leaf; `frameUrl` carries the frame's src. The
   * serializer renders a recovery hint so the boundary is loud.
   */
  crossOrigin?: boolean;
  frameUrl?: string;
  /**
   * Phase 4b: set on a cross-origin frame leaf AFTER its subtree was descended
   * and spliced in (executeScript into the OOPIF's realm). The `crossOrigin`
   * flag is cleared on success so only `frameDescended` remains — the serializer
   * renders "descended" instead of the "not descended" recovery hint.
   */
  frameDescended?: boolean;
  /**
   * Per-walk frame summary, set ONLY on the tree root by helpers.js — every
   * child frame the walk encountered and whether it was descended (same-origin)
   * or skipped (cross-origin / too-deep / unloaded). The pruner passes this
   * through: `runUnifiedCapture` reads `tree.frames` and surfaces it as
   * `meta.frames` so skipped frames are loud (invariant #20).
   */
  frames?: Array<{ url: string; descended: boolean }>;
  /**
   * Page CSS-pixel viewport (`window.innerWidth` × `innerHeight`) at snapshot
   * time. Set on the tree root only by `helpers.js::__mcpA11y`. The pruner
   * does not consume this — it's a passthrough: the extension's
   * `doSnapshotCapture` reads `tree.cssViewport` and re-surfaces it at the
   * `snapshot_capture` response's top level, where `runUnifiedCapture` picks
   * it up and forwards it to the `annotate_image` hop. Declared here so the
   * helpers.js assignment has a typed shape to mirror.
   */
  cssViewport?: { w: number; h: number };
  children: RawNode[];
}

export interface PrunedNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  checked?: boolean | "mixed";
  selected?: boolean;
  disabled?: boolean;
  level?: number;
  /** Interactive element hidden under another layer at its own centre (see
   * RawNode.occluded). Serialized as `[occluded]`. */
  occluded?: boolean;
  values?: string[];
  /**
   * Set on a table/grid/treegrid node when the cap ladder (viewport fallback
   * or prefix cut) removed some of its rows — the serializer appends
   * `(showing X of Y rows)` so a partial table is loud. Rendering annotation
   * only: deliberately NOT diff-tracked (row added/removed lines already
   * convey row churn).
   */
  rowsShown?: { shown: number; total: number };
  /** Cross-origin child-frame leaf — see RawNode.crossOrigin. The serializer
   * renders a recovery hint next to it. */
  crossOrigin?: boolean;
  /** Cross-origin frame whose subtree WAS descended (Phase 4b). */
  frameDescended?: boolean;
  frameUrl?: string;
  children?: PrunedNode[];
}

export interface PruneOptions {
  limit?: number;
  viewportOnly?: boolean;
  detail?: "standard" | "full";
}

export interface PruneMeta {
  /**
   * Node count of the full-page tree after keep-filtering and distillation but
   * BEFORE any viewport fallback or prefix cut — i.e. how many nodes a snapshot
   * with a sufficient `limit` would return. Always surfaced so the agent can
   * tell whether the returned tree is the whole page.
   */
  total_candidates?: number;
  /**
   * Set only when the pruner auto-engaged viewport-only mode because the
   * distilled full-page tree exceeded `limit` AND the caller did not pass
   * `viewportOnly:true` explicitly. The agent can react by scrolling, raising
   * `limit`, scoping to a subtree, or offloading the full tree to a file.
   */
  viewport_fallback?: {
    active: true;
    reason: "page_too_large";
    threshold: number;
    total_candidates: number;
  };
  /**
   * Set only when the tree was cut to a document-order prefix because it still
   * exceeded `limit` after the viewport fallback (or the fallback was skipped).
   * `total` is the node count of the tree that was cut (the viewport-scoped
   * count when the fallback engaged); `first_omitted_ref` is the ref of the
   * first node in document order that did NOT fit — the agent can scope
   * straight to its region to see what follows.
   */
  truncated?: {
    shown: number;
    total: number;
    first_omitted_ref?: string;
  };
  /**
   * Agent-actionable recovery hint, set whenever the pruner returned less than
   * the full tree — the one channel the agent reads to know what it didn't see
   * and how to get it. Surfaced inline as the first line of the serialized
   * outline (see snapshot/serialize.ts) so it can't be missed. Every entry in
   * the cap ladder writes a machine-readable meta twin alongside it
   * (viewport_fallback / truncated).
   */
  notice?: string;
  /**
   * The ref this snapshot was scoped to, when the caller passed `scope`. Set
   * by `runUnifiedCapture` (not `prune` — scoping selects the raw subtree
   * before the pruner runs). Everything in the tree — and `total_candidates` —
   * is relative to this subtree.
   */
  scope?: string;
  /**
   * Snapshot mode — "full" (the whole pruned tree) or "diff" (only what changed
   * since the previous snapshot of this tab). Set by runUnifiedCapture (the diff
   * layer in CP5), NOT by prune() — prune always produces a full tree; the
   * capture orchestrator decides whether to serialize it whole or as a delta.
   * Explicit browser_snapshot is always "full"; an action's auto-snapshot is
   * "diff" when a comparable prior tree exists and the delta is smaller than the
   * full outline, else "full".
   */
  mode?: "diff" | "full";
  /**
   * Child-frame summary surfaced from the raw tree root (helpers.js sets it
   * during the walk). Lists every child frame and whether the snapshot
   * descended it. Set by `runUnifiedCapture` (not `prune` — it lives on the raw
   * root, which the pruner doesn't carry through), and only when ≥1 child frame
   * exists. Makes a skipped cross-origin frame loud (invariant #20).
   */
  frames?: Array<{ url: string; descended: boolean }>;
}

const COOKIE_BANNER_NAME_RE =
  /(cookie|consent|gdpr|privacy preference|privacy setting)/i;
const COOKIE_BANNER_ROLES = new Set([
  "dialog",
  "alertdialog",
  "region",
  "banner",
]);

interface Candidate {
  node: RawNode;
  parentIdx: number;
}

export function prune(
  root: RawNode,
  opts: PruneOptions = {},
): PrunedNode & { meta?: PruneMeta } {
  const limit = opts.limit ?? 1500;
  const explicitViewportOnly = opts.viewportOnly === true;
  const detail = opts.detail ?? "standard";

  // Full-page pass first, always — `total_candidates` reports the whole page's
  // distilled size even when the output is ultimately viewport-scoped, so the
  // agent can tell how much page exists beyond what it sees.
  const full = buildDistilled(root, detail, false);
  const total_candidates = full.count;

  const meta: PruneMeta = { total_candidates };
  const notices: string[] = [];

  let tree: PrunedNode;
  let count: number;
  if (explicitViewportOnly) {
    // The caller asked for viewport scoping — no fallback meta/notice needed.
    ({ tree, count } = buildDistilled(root, detail, true));
  } else {
    ({ tree, count } = full);
    if (count > limit) {
      // Cap ladder step 1: retry scoped to the viewport. Skipped when the
      // viewport subset is EMPTY (e.g. the page scrolled past all semantic
      // content) — a prefix of the full tree beats an empty snapshot — and when
      // it wouldn't reduce anything (everything already in-viewport): a no-op
      // "scoped to the viewport" claim would be dishonest noise.
      // "Empty" here means root-only (count ≤ 1): the document root always
      // survives the viewport gate, so a page scrolled past all semantic
      // content yields a bare-root tree, not a literally empty one.
      const vp = buildDistilled(root, detail, true);
      if (vp.count > 1 && vp.count < count) {
        tree = vp.tree;
        count = vp.count;
        meta.viewport_fallback = {
          active: true,
          reason: "page_too_large",
          threshold: limit,
          total_candidates,
        };
        notices.push(
          `This page is large — ${total_candidates} nodes after pruning, over 'limit' (${limit}) — so the snapshot is scoped to the in-viewport subset. To reach the rest: scroll and re-snapshot, raise 'limit', scope to a subtree with scope:"<ref>", or write the full tree to a file with save_tree_to_path:true.`,
        );
      } else if (vp.count <= 1) {
        notices.push(
          `This page is large (${total_candidates} nodes, over 'limit' ${limit}) and its in-viewport subset is empty, so the snapshot shows the whole page truncated in document order.`,
        );
      }
      // else: everything is already in-viewport — the viewport pass wouldn't
      // reduce anything, so fall straight through to the prefix cut.
    }
  }

  // Cap ladder step 2: document-order prefix cut. Preorder prefix ⇒ every kept
  // node's ancestors are kept; the cut point is named so the agent can scope
  // straight to the region that follows it.
  if (count > limit) {
    const cut = capToPrefix(tree, limit);
    tree = cut.tree;
    meta.truncated = {
      shown: Math.min(limit, count),
      total: count,
      ...(cut.firstOmittedRef !== undefined
        ? { first_omitted_ref: cut.firstOmittedRef }
        : {}),
    };
    notices.push(
      `Showing the first ${meta.truncated.shown} of ${count} nodes in document order — the first omitted node is [ref=${cut.firstOmittedRef ?? "?"}]. To recover the rest: raise 'limit' (now ${limit}), scope to a subtree with scope:"<ref>", pass viewportOnly:true, or write the full tree to a file with save_tree_to_path:true.`,
    );
  }

  // Table row-count annotation: any table whose rows were removed by the cap
  // ladder says so on its own line — `(showing X of Y rows)` — so a partial
  // table can never masquerade as a complete one.
  annotateRowsShown(tree, full.tree);

  if (notices.length) meta.notice = notices.join(" ");
  const out = tree as PrunedNode & { meta?: PruneMeta };
  out.meta = meta;
  return out;
}

/**
 * Compare each table/grid node in the FINAL tree against its counterpart in the
 * full (pre-ladder) tree by ref; where the ladder removed rows, stamp
 * `rowsShown {shown, total}`. Row counts span the whole subtree (rowgroups
 * nest between a table and its rows in full mode). No-op when the final tree
 * IS the full tree (shown always equals total).
 */
function annotateRowsShown(finalTree: PrunedNode, fullTree: PrunedNode): void {
  const totals = new Map<string, number>();
  (function collectTotals(n: PrunedNode): void {
    if (TABLE_ROLES.has(n.role)) totals.set(n.ref, countRows(n));
    if (n.children) for (const c of n.children) collectTotals(c);
  })(fullTree);
  (function stamp(n: PrunedNode): void {
    if (TABLE_ROLES.has(n.role)) {
      const total = totals.get(n.ref);
      if (total !== undefined) {
        const shown = countRows(n);
        if (shown < total) n.rowsShown = { shown, total };
      }
    }
    if (n.children) for (const c of n.children) stamp(c);
  })(finalTree);
}

/**
 * A collapsed node's textContent-fallback name is just its children's text
 * mashed together — printing it next to `values:` doubles the line. Drop the
 * name ONLY when it IS that mash: whitespace-stripped, the name must equal the
 * concatenation of the values. An AUTHORED label (an aria-label saying
 * something the cells don't) fails the equality and is kept. A per-value
 * `includes` containment test is NOT enough — short cell values ("1","0","2")
 * are substrings of almost any label ("2010 Olympics…"), silently deleting
 * authored names on ordinary numeric data grids.
 */
function dropNameRestatedByValues(node: PrunedNode): void {
  if (!node.name || !node.values?.length) return;
  const strip = (s: string) => s.replace(/\s+/g, "");
  if (strip(node.name) === strip(node.values.join(""))) delete node.name;
}

/**
 * Rows in THIS table only — recursion descends through rowgroups but stops at
 * nested tables, which carry their own independent `rowsShown` annotation.
 * Counting through them would report an outer count that is numerically false.
 */
function countRows(n: PrunedNode): number {
  let count = n.role === "row" ? 1 : 0;
  if (n.children)
    for (const c of n.children)
      if (!TABLE_ROLES.has(c.role)) count += countRows(c);
  return count;
}

/**
 * One deterministic pipeline pass: collect (keep-rules, DFS preorder) → build
 * (nearest-kept-ancestor tree) → distill (lossless compression). `count` is the
 * number of candidate-derived nodes in the distilled tree (the synthetic
 * multi-root sentinel "0" is not counted). Called once for the full page and —
 * only when the cap ladder engages — once more viewport-scoped; two full passes
 * beat threading a filter through incremental state (determinism over
 * cleverness).
 */
function buildDistilled(
  root: RawNode,
  detail: "standard" | "full",
  viewportFilter: boolean,
): { tree: PrunedNode; count: number } {
  // Pass 1: DFS preorder collect. Candidate order IS document order — the
  // array index doubles as the document-order rank, and a kept node's children
  // attach to it (or to its nearest kept ancestor when it was filtered).
  const candidates: Candidate[] = [];
  collect(root, -1, detail, candidates);

  // Viewport gate at pick time (not collect time) so parentIdx references stay
  // stable for the tree-build step. `nearestSelectedAncestor` naturally skips
  // filtered candidates. The document root (candidate 0) always survives the
  // gate: its page-side rect sits at the document top, so once the page is
  // scrolled it reads as out-of-viewport and the tree would degrade into a
  // rootless forest — losing the page title and churning diffs with a phantom
  // "- WebArea" removal on every scroll.
  const selected: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (!viewportFilter || i === 0 || candidates[i]!.node.inViewport !== false)
      selected.push(i);
  }

  // Refs map 1:1 to the page-side nodeId so the in-page `findByRef` can resolve
  // them to the exact element the agent saw in this snapshot. Synthetic root
  // (no nodeId) keeps "0".
  const selectedSet = new Set(selected);
  const idxToRef = new Map<number, string>();
  for (const idx of selected)
    idxToRef.set(idx, candidates[idx]!.node.nodeId ?? String(idx + 1));

  function nearestSelectedAncestor(idx: number): number | -1 {
    let walk = candidates[idx]!.parentIdx;
    while (walk >= 0) {
      if (selectedSet.has(walk)) return walk;
      walk = candidates[walk]!.parentIdx;
    }
    return -1;
  }

  const childrenOf = new Map<number, number[]>();
  for (const idx of selected) {
    const parent = nearestSelectedAncestor(idx);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(idx);
  }

  /**
   * A "simple" cell can be represented by its name alone: a cell-role node
   * whose kept descendants are all plain text — no interactive control, no
   * nested structure the agent might need a ref for.
   */
  function isSimpleCell(idx: number): boolean {
    if (!CELL_ROLES.has(candidates[idx]!.node.role)) return false;
    const stack = [...(childrenOf.get(idx) ?? [])];
    while (stack.length) {
      const i = stack.pop()!;
      const role = candidates[i]!.node.role;
      if (role !== "text" && role !== "StaticText") return false;
      stack.push(...(childrenOf.get(i) ?? []));
    }
    return true;
  }

  function build(idx: number, isRoot: boolean): PrunedNode {
    const c = candidates[idx]!;
    const node: PrunedNode = {
      ref: idxToRef.get(idx)!,
      role: c.node.role,
    };
    if (c.node.name?.trim()) node.name = c.node.name.trim();
    if (c.node.value) node.value = c.node.value;
    if (c.node.checked !== undefined) node.checked = c.node.checked;
    if (c.node.selected !== undefined) node.selected = c.node.selected;
    if (c.node.disabled) node.disabled = true;
    if (c.node.level !== undefined) node.level = c.node.level;
    if (c.node.occluded) node.occluded = true;
    if (c.node.crossOrigin) {
      node.crossOrigin = true;
      if (c.node.frameUrl) node.frameUrl = c.node.frameUrl;
    }
    if (c.node.frameDescended) {
      node.frameDescended = true;
      if (c.node.frameUrl) node.frameUrl = c.node.frameUrl;
    }

    const children = childrenOf.get(idx) ?? [];
    if (children.length === 0) return node;

    // Row collapse (table-aware): a row whose kept children are ALL simple
    // cells collapses to `values:` — one entry per cell in document order,
    // empty-name cells contributing "" so columns stay positionally aligned
    // across rows (header rows collapse too, giving column association by
    // position). A row with any interactive/structured cell — e.g. a header
    // cell holding a sort button, or a data cell holding a link — stays
    // expanded so those controls keep targetable refs. The pruned ROOT never
    // collapses: `scope:"<rowRef>"` must always recover the cell refs.
    if (!isRoot && c.node.role === "row" && children.every(isSimpleCell)) {
      node.values = children.map(
        (i) => candidates[i]!.node.name?.trim() ?? "",
      );
      dropNameRestatedByValues(node);
      return node;
    }

    // Data-collapse: data-role parent with ≥2 text-only children → values:[...]
    if (DATA_ROLES.has(c.node.role)) {
      const childNodes = children.map((i) => candidates[i]!.node);
      const textKids = childNodes.filter(
        (n) => n.role === "text" || n.role === "StaticText",
      );
      const nonTextKids = childNodes.filter(
        (n) => n.role !== "text" && n.role !== "StaticText",
      );
      if (textKids.length >= 2 && nonTextKids.length === 0) {
        const values = textKids
          .map((n) => n.name?.trim())
          .filter((s): s is string => Boolean(s));
        if (values.length) {
          node.values = values;
          dropNameRestatedByValues(node);
        }
        return node;
      }
    }
    node.children = children.map((i) => build(i, false));
    return node;
  }

  // Synthesize root if root itself wasn't kept
  const roots = childrenOf.get(-1) ?? [];
  let tree: PrunedNode;
  if (roots.length === 1) {
    tree = build(roots[0]!, true);
  } else {
    tree = {
      ref: "0",
      role: root.role ?? "WebArea",
      children: roots.map((i) => build(i, false)),
    };
  }

  // Pass 3: lossless distillation — merges/unwraps redundant structure. Never
  // removes a fact-bearing node (see distill.ts's hard safety rule).
  tree = distill(tree);
  return { tree, count: countNodes(tree) };
}

/**
 * DFS preorder candidate collection. Applies (in order): aria-hidden/inert
 * skip, cookie-banner collapse (subtree → one targetable placeholder
 * candidate, in document order), and the facts-only keep-rules — standard mode
 * keeps everything interactive/navigational/data-bearing plus ANY named node;
 * `detail:"full"` keeps every node. Filtered nodes pass their parentIdx down so
 * their kept descendants re-parent to the nearest kept ancestor.
 */
function collect(
  node: RawNode,
  parentIdx: number,
  detail: "standard" | "full",
  candidates: Candidate[],
): void {
  // a11y-hidden / inert subtrees: the user can't interact with them, so the
  // agent shouldn't waste tokens enumerating them.
  if (node.ariaHidden || node.inert) return;

  // Cookie banner collapse: detect the wrapper by name + role + fixed
  // position. Replace the entire subtree with a single placeholder so the
  // agent can dismiss it intentionally without flooding their context with
  // its 30-checkbox guts.
  if (
    COOKIE_BANNER_ROLES.has(node.role) &&
    (node.position === "fixed" || node.position === "sticky") &&
    node.name &&
    COOKIE_BANNER_NAME_RE.test(node.name)
  ) {
    candidates.push({
      node: {
        nodeId: node.nodeId,
        role: "banner",
        name: `${node.name} (collapsed; cookie consent overlay)`,
        depth: node.depth,
        rect: node.rect,
        inViewport: node.inViewport,
        children: [],
      },
      parentIdx,
    });
    return;
  }

  // Facts-only keep-rules. Standard mode includes the whole SEMANTIC tree:
  // anything interactive/navigational/data-bearing, plus ANY named node —
  // including named landmarks/containers (region/main/navigation/list/group
  // with an aria-label). Table structure (table/grid + cell roles) is kept
  // even unnamed: the table node anchors the `(showing X of Y rows)`
  // annotation and is the natural scope target, and an EMPTY cell must occupy
  // its column slot or the row-collapse `values:` lists would misalign across
  // rows. Other unnamed structural nodes (generic divs, unlabeled wrappers)
  // stay out of standard mode — they add depth without signal; `detail:"full"`
  // is the escape hatch for the truly-complete tree.
  const keep =
    detail === "full" ||
    INTERACTIVE_ROLES.has(node.role) ||
    NAV_ROLES.has(node.role) ||
    DATA_ROLES.has(node.role) ||
    CELL_ROLES.has(node.role) ||
    TABLE_ROLES.has(node.role) ||
    Boolean(node.name && node.name.trim());

  let idx = parentIdx;
  if (keep) {
    idx = candidates.length;
    candidates.push({ node, parentIdx });
  }
  for (const child of node.children) collect(child, idx, detail, candidates);
}

/** Count candidate-derived nodes (the synthetic "0" sentinel is not counted). */
function countNodes(tree: PrunedNode): number {
  let n = tree.ref === "0" ? 0 : 1;
  if (tree.children) for (const c of tree.children) n += countNodes(c);
  return n;
}

/**
 * Document-order prefix cut: keep the first `limit` nodes in preorder (the
 * synthetic "0" sentinel is free). A preorder prefix always contains every kept
 * node's ancestors, so the result is a well-formed tree. Returns the ref of the
 * first omitted node so the caller's notice can name the exact cut point.
 */
function capToPrefix(
  tree: PrunedNode,
  limit: number,
): { tree: PrunedNode; firstOmittedRef?: string } {
  let remaining = limit;
  let firstOmittedRef: string | undefined;

  function walk(node: PrunedNode): PrunedNode | null {
    if (node.ref !== "0") {
      if (remaining <= 0) {
        if (firstOmittedRef === undefined) firstOmittedRef = node.ref;
        return null;
      }
      remaining--;
    }
    const out: PrunedNode = { ...node };
    delete out.children;
    if (node.children) {
      const kept: PrunedNode[] = [];
      for (const child of node.children) {
        const k = walk(child);
        if (k) kept.push(k);
        // Budget exhausted — the first omitted ref is recorded; every later
        // preorder node is omitted too, so stop descending.
        else break;
      }
      if (kept.length) out.children = kept;
    }
    return out;
  }

  return { tree: walk(tree)!, firstOmittedRef };
}
