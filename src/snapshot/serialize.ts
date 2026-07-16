/**
 * Compact indented-text serializer for a pruned accessibility tree.
 *
 * Replaces the verbose nested-JSON tree representation with a Playwright-style
 * indented outline — one line per node, two spaces per depth:
 *
 *   - WebArea "Wikipedia" [ref=1]
 *     - searchbox "Search Wikipedia" [ref=22]
 *     - button "Search" [ref=24]
 *     - row [ref=288] values: "Machine learning", "Symbolic", "Deep learning"
 *
 * Why text, not JSON: the per-node JSON scaffolding (`{"ref":…,"role":…,
 * "name":…,"children":[…]}`) dominates the token budget on real pages; the
 * outline drops it for a large reduction while staying trivially scannable for
 * `[ref=N]` handles. The MCP transport envelope stays JSON — action results
 * nest the snapshot under `payload.snapshot`, and the image-bearing envelope's
 * capture-result duck-type requires an object payload — so the outline rides as
 * a single string field, `payload.tree`. Structured counts live in
 * `payload.meta`; a recovery `notice` (when the pruner capped/fell back) is
 * inlined as the first line of the outline so the agent can't miss it.
 *
 * Node line grammar (deterministic field order, pinned by serialize.test.mjs):
 *   {indent}- {role}[ "{name}"][ [ref={ref}]][ = "{value}"]
 *     [ [checked] | [mixed]][ [selected]][ [disabled]][ [occluded]][ [level={n}]]
 *     [ values: "{v1}", "{v2}", …]
 * Names/values are whitespace-collapsed and have embedded double-quotes escaped.
 * The synthetic multi-root sentinel (ref "0") prints no [ref] tag — it mirrors
 * populateRefs, which never registers "0" as an actionable ref.
 */

import type { PrunedNode } from "./prune";

/** Collapse whitespace runs and escape embedded quotes for a quoted segment. */
export function quoted(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/"/g, '\\"');
}

/**
 * Format a node's fields — everything that follows the list bullet: role, an
 * optional quoted name, an optional `[ref=N]`, an optional `= "value"`, the
 * state flags, and a collapsed `values:` list. The node-line grammar lives here
 * exactly once, shared by the full-tree serializer (serializeNode) and the diff
 * serializer (diff.ts's added/removed lines), so the two can never drift.
 */
export function formatNodeFields(node: PrunedNode): string {
  let s = node.role;
  if (node.name !== undefined) {
    const name = quoted(node.name);
    if (name) s += ` "${name}"`;
  }
  // The synthetic root ("0") is a non-actionable wrapper — omit its ref so the
  // outline never advertises a handle populateRefs won't resolve.
  if (node.ref && node.ref !== "0") s += ` [ref=${node.ref}]`;
  if (node.value !== undefined) s += ` = "${quoted(node.value)}"`;
  if (node.checked === true) s += " [checked]";
  else if (node.checked === "mixed") s += " [mixed]";
  if (node.selected) s += " [selected]";
  if (node.disabled) s += " [disabled]";
  if (node.occluded) s += " [occluded]";
  if (node.level !== undefined) s += ` [level=${node.level}]`;
  if (node.values && node.values.length) {
    s += ` values: ${node.values.map((v) => `"${quoted(v)}"`).join(", ")}`;
  }
  // Partial table (cap ladder removed rows) — the count keeps it honest.
  if (node.rowsShown) {
    s += ` (showing ${node.rowsShown.shown} of ${node.rowsShown.total} rows)`;
  }
  // Cross-origin frame leaf — the walk couldn't traverse its document. Render a
  // loud, machine-readable boundary marker so the agent knows content exists
  // here that the default snapshot did not reach.
  if (node.crossOrigin) s += " [cross-origin frame — not descended]";
  // Phase 4b: descended cross-origin frame — its content follows as `fN:` refs.
  else if (node.frameDescended) s += " [cross-origin frame — descended]";
  return s;
}

/**
 * Identity-only lead for a node: role, optional name, optional ref. Used by the
 * diff serializer's "changed" lines, where the value/flags carried by
 * formatNodeFields would duplicate the field transitions that follow the lead.
 */
export function formatNodeIdentity(node: PrunedNode): string {
  let s = node.role;
  if (node.name !== undefined) {
    const name = quoted(node.name);
    if (name) s += ` "${name}"`;
  }
  if (node.ref && node.ref !== "0") s += ` [ref=${node.ref}]`;
  return s;
}

function serializeNode(node: PrunedNode, depth: number, out: string[]): void {
  out.push(`${"  ".repeat(depth)}- ${formatNodeFields(node)}`);
  if (node.children) {
    for (const child of node.children) serializeNode(child, depth + 1, out);
  }
}

/**
 * Serialize a pruned tree to the compact indented outline (no trailing newline).
 *
 * Trusted input: the node must be a well-formed `PrunedNode` as produced by
 * `prune()` (a `role` is always set; a data-collapse node carries `values` and
 * no `children` — the two are mutually exclusive). The serializer does not
 * defend against `null`/role-less nodes — `prune` is the only producer.
 */
export function serializeTree(node: PrunedNode): string {
  const out: string[] = [];
  serializeNode(node, 0, out);
  return out.join("\n");
}
