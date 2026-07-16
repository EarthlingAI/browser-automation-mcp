/**
 * Lossless distillation of a pruned accessibility tree — structural
 * compression that removes REDUNDANCY, never information. Runs as the pruner's
 * exit phase (prune.ts Pass 3), before the cap ladder, so every node the
 * ladder counts is already as compact as it can honestly be.
 *
 * Five rules, applied bottom-up (children first) at each node:
 *   1. Merge runs of adjacent leaf text children into one text node (names
 *      space-joined; the merged node carries the FIRST fragment's ref).
 *   2. Drop a leaf text child whose name equals the parent's name — the parent
 *      line already says it.
 *   3. Drop decorative images: nameless, childless image nodes. Likewise
 *      (3b) nameless, childless cells — layout-table scaffolding — EXCEPT in a
 *      table containing collapsed rows, where an expanded row's empty cell
 *      holds a column position the collapsed rows' `""` slots align to.
 *   4. Drop a name-repeating leaf generic child (same redundancy as rule 2 for
 *      generic wrappers that inherited their text's accessible name).
 *   5. Unwrap a single-child, unnamed, fact-free generic — the wrapper adds a
 *      depth level without saying anything. Never applied to the tree root.
 *
 * Rules 1–4 iterate to a FIXPOINT at each node: a drop can make two text
 * leaves newly adjacent, and a merge can produce a restating leaf — one pass
 * of each is not enough for idempotence.
 *
 * HARD SAFETY RULE (invariant #38): distillation never removes or merges a
 * node that carries a fact — value / checked / selected / disabled / level /
 * values / occluded / crossOrigin / frameDescended — or whose role is
 * interactive / navigational / data-bearing. Such nodes pass through
 * untouched; only pure text/structure redundancy is compressed.
 *
 * The whole pass is deterministic and idempotent: distill(distill(t)) equals
 * distill(t) (pinned by distill.test.mjs).
 */

import type { PrunedNode } from "./prune";
import {
  CELL_ROLES,
  DATA_ROLES,
  INTERACTIVE_ROLES,
  NAV_ROLES,
  TABLE_ROLES,
} from "./roles";

const TEXT_ROLES = new Set(["text", "StaticText"]);
const IMAGE_ROLES = new Set(["image", "img"]);
/**
 * Wrapper roles eligible for rule-5 unwrap — pure structure with no semantics.
 * Cell roles are included: a NAMELESS single-child cell is a layout slot around
 * its content (row collapse extracts `values:` before distillation, so cell
 * identity is only needed where a cell actually says something — a name, a
 * fact, or multiple children).
 */
const WRAPPER_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  ...CELL_ROLES,
]);

/**
 * A node that carries a fact the agent could act on or read — immune to every
 * distillation rule (invariant #38).
 */
function isFactBearing(n: PrunedNode): boolean {
  return (
    n.value !== undefined ||
    n.checked !== undefined ||
    n.selected !== undefined ||
    Boolean(n.disabled) ||
    n.level !== undefined ||
    Boolean(n.values && n.values.length) ||
    Boolean(n.occluded) ||
    Boolean(n.crossOrigin) ||
    Boolean(n.frameDescended) ||
    INTERACTIVE_ROLES.has(n.role) ||
    NAV_ROLES.has(n.role) ||
    DATA_ROLES.has(n.role)
  );
}

const isLeaf = (n: PrunedNode): boolean => !n.children || n.children.length === 0;

/** Mergeable/droppable text fragment: leaf text node carrying no facts. */
function isPlainTextLeaf(n: PrunedNode): boolean {
  return TEXT_ROLES.has(n.role) && isLeaf(n) && !isFactBearing(n);
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.trim() === b.trim();
}

/**
 * Distill a pruned tree. Returns a new tree (input nodes are shallow-copied
 * where modified); the root node is never removed, merged, or unwrapped.
 */
export function distill(tree: PrunedNode): PrunedNode {
  return distillNode(tree, true, hasCollapsedRow(tree));
}

/**
 * Does THIS table (recursion stops at nested tables) contain a row the pruner
 * collapsed to `values:`? When it does, an EXPANDED sibling row (a header with
 * sort buttons) must keep its empty cells — dropping them (rule 3b) would
 * desync the header's rendered cell positions from the collapsed rows' `""`
 * value slots, breaking the positional-alignment contract (#30/#40).
 */
function hasCollapsedRow(n: PrunedNode): boolean {
  if (n.role === "row" && n.values?.length) return true;
  if (!n.children) return false;
  return n.children.some(
    (c) => !TABLE_ROLES.has(c.role) && hasCollapsedRow(c),
  );
}

function distillNode(
  node: PrunedNode,
  isRoot: boolean,
  inCollapseTable: boolean,
): PrunedNode {
  if (!node.children || node.children.length === 0) return node;

  // Each table establishes its own alignment context — recompute at every
  // table boundary (nested tables collapse independently).
  if (TABLE_ROLES.has(node.role)) inCollapseTable = hasCollapsedRow(node);

  // Bottom-up: distill each child subtree first, so the rules below see the
  // children's final (already-compressed) shape.
  let children = node.children.map((c) =>
    distillNode(c, false, inCollapseTable),
  );

  const dropRules = (c: PrunedNode): boolean => {
    if (isFactBearing(c) || !isLeaf(c)) return true;
    // Rule 2 + 4: leaf text/generic child restating the parent's name.
    if (
      (TEXT_ROLES.has(c.role) || WRAPPER_ROLES.has(c.role)) &&
      sameName(c.name, node.name)
    )
      return false;
    // Rule 3: decorative image — nameless and childless says nothing.
    if (IMAGE_ROLES.has(c.role) && !c.name?.trim()) return false;
    // Rule 3b: nameless, childless cell in an EXPANDED row — pure layout-table
    // scaffolding — EXCEPT inside a table with collapsed rows, where the empty
    // cell holds a column position the collapsed rows' `""` slots align to
    // (see hasCollapsedRow).
    if (CELL_ROLES.has(c.role) && !c.name?.trim() && !inCollapseTable)
      return false;
    return true;
  };

  // Rule 1 (merge adjacent plain-text leaves; the merged node keeps the first
  // fragment's ref) interacts with rules 2–4: a drop can make two text leaves
  // newly adjacent, and a merge can produce a leaf that restates the parent's
  // name. Iterate to a fixpoint so distill(distill(t)) === distill(t) — each
  // pass that changes anything strictly shrinks the array, so it terminates.
  let prevLen = -1;
  while (children.length !== prevLen) {
    prevLen = children.length;
    children = mergeAdjacentText(children).filter(dropRules);
  }

  const out: PrunedNode = { ...node };
  if (children.length) out.children = children;
  else delete out.children;

  // Rule 5 — unwrap a single-child, unnamed, fact-free generic wrapper. The
  // root is never unwrapped (the snapshot must keep its document anchor).
  if (
    !isRoot &&
    WRAPPER_ROLES.has(out.role) &&
    !out.name?.trim() &&
    !isFactBearing(out) &&
    out.children?.length === 1
  ) {
    return out.children[0]!;
  }
  return out;
}

function mergeAdjacentText(children: PrunedNode[]): PrunedNode[] {
  const out: PrunedNode[] = [];
  for (const child of children) {
    const prev = out[out.length - 1];
    if (prev && isPlainTextLeaf(prev) && isPlainTextLeaf(child)) {
      const a = prev.name?.trim() ?? "";
      const b = child.name?.trim() ?? "";
      const merged = [a, b].filter(Boolean).join(" ");
      if (merged) prev.name = merged;
      continue;
    }
    // Copy before any in-place name merge so the caller's tree is untouched.
    out.push(isPlainTextLeaf(child) ? { ...child } : child);
  }
  return out;
}
