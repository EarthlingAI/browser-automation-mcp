/**
 * Compact tree-diff serializer (CP5 — the differentiator).
 *
 * Given the previous and current pruned trees of the SAME tab, emit only what
 * changed, keyed by the stable+non-evicting ref (invariant #10): a given element
 * keeps ONE ref across snapshots, so a ref present in both trees is the same
 * element — letting us classify every ref as added / removed / changed and skip
 * the (usually vast) unchanged remainder. This is the high-frequency
 * auto-snapshot payload: after a click the agent mostly wants "what did that
 * change", not the whole tree re-printed.
 *
 * Output grammar (one line per change, reusing the CP3 node-line fields):
 *
 *   Δ 2 added, 1 removed, 1 changed
 *   + button "Save" [ref=12]
 *   - link "Cancel" [ref=8]
 *   ~ textbox "Email" [ref=5] value: "" → "a@b.com"
 *
 * Added/removed lines carry the full node fields (formatNodeFields) so the agent
 * sees the new/gone element's state. A changed line carries the identity lead
 * (formatNodeIdentity) plus the field transitions (`field: old → new`,
 * "; "-joined) — printing the full fields there would duplicate the transitions.
 * An all-quiet diff is the single line `Δ no changes` (a genuine result: the
 * action produced no observable a11y delta). The header counts and each group
 * are sorted by numeric ref for determinism.
 *
 * Like serialize.ts this returns a STRING for `payload.tree`; the transport
 * envelope stays JSON (invariant #30). `runUnifiedCapture` owns the decision of
 * WHEN to diff (auto-snapshot with a comparable prior tree) vs serialize full,
 * and never lets a diff be larger than the full outline (full-page navigation
 * turns over every ref) — this module just renders the delta it's handed.
 */

import type { PrunedNode } from "./prune";
import { formatNodeFields, formatNodeIdentity, quoted } from "./serialize";
import { compareRefs } from "./ref";

/** Flatten a pruned tree to ref → node, skipping the synthetic root ("0"). */
function flattenByRef(node: PrunedNode, map: Map<string, PrunedNode>): void {
  if (node.ref && node.ref !== "0") map.set(node.ref, node);
  if (node.children) for (const c of node.children) flattenByRef(c, map);
}

/** Render an optional string field for a transition (undefined → "(none)"). */
function fmtStr(v: string | undefined): string {
  return v === undefined ? "(none)" : `"${quoted(v)}"`;
}

/** Render a flag/level field for a transition (booleans, "mixed", numbers, bare). */
function fmtFlag(v: boolean | "mixed" | number | undefined): string {
  return v === undefined ? "(none)" : String(v);
}

function valuesEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true; // both undefined (or same ref)
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function fmtValues(v?: string[]): string {
  if (!v || !v.length) return "(none)";
  return v.map((x) => `"${quoted(x)}"`).join(", ");
}

/**
 * Field-level transitions between two nodes sharing a ref. Compares the same
 * fields the serializer renders (role, name, value, checked, selected, disabled,
 * occluded, level, values). selected/disabled/occluded are normalized to
 * booleans so an undefined↔false jitter isn't reported as a change; checked
 * keeps its raw tri-state ("mixed" is meaningful). Structural change (gained/lost children)
 * surfaces as the children's own added/removed lines, not here. `rowsShown` is
 * deliberately NOT diff-tracked — it's a rendering annotation of the cap
 * ladder, and row add/remove lines already convey row churn.
 */
function describeChanges(prev: PrunedNode, next: PrunedNode): string[] {
  const out: string[] = [];
  if (prev.role !== next.role) out.push(`role: ${prev.role} → ${next.role}`);
  if (prev.name !== next.name)
    out.push(`name: ${fmtStr(prev.name)} → ${fmtStr(next.name)}`);
  if (prev.value !== next.value)
    out.push(`value: ${fmtStr(prev.value)} → ${fmtStr(next.value)}`);
  if (prev.checked !== next.checked)
    out.push(`checked: ${fmtFlag(prev.checked)} → ${fmtFlag(next.checked)}`);
  if (Boolean(prev.selected) !== Boolean(next.selected))
    out.push(`selected: ${Boolean(prev.selected)} → ${Boolean(next.selected)}`);
  if (Boolean(prev.disabled) !== Boolean(next.disabled))
    out.push(`disabled: ${Boolean(prev.disabled)} → ${Boolean(next.disabled)}`);
  // occluded false→true is a real event: a layer now covers this element at its
  // own centre (a modal/overlay slid over the agent's button).
  if (Boolean(prev.occluded) !== Boolean(next.occluded))
    out.push(`occluded: ${Boolean(prev.occluded)} → ${Boolean(next.occluded)}`);
  if (prev.level !== next.level)
    out.push(`level: ${fmtFlag(prev.level)} → ${fmtFlag(next.level)}`);
  if (!valuesEqual(prev.values, next.values))
    out.push(`values: ${fmtValues(prev.values)} → ${fmtValues(next.values)}`);
  return out;
}

// Sort by the (frameId, localId) tuple via the ref chokepoint — NOT a bare
// `Number(a.ref)-Number(b.ref)`, which returns NaN for any cross-origin `fN:`
// ref and leaves the sort order undefined. `ref` is always set on a flattened
// node ("0" synthetic root is excluded by flattenByRef), so the `?? ""` is only
// to satisfy the optional-field type.
const byRef = (a: PrunedNode, b: PrunedNode): number =>
  compareRefs(a.ref ?? "", b.ref ?? "");

/**
 * Serialize the delta between two pruned trees of the same tab to the compact
 * change outline. Returns `Δ no changes` when nothing changed.
 */
export function serializeDiff(prev: PrunedNode, next: PrunedNode): string {
  const prevMap = new Map<string, PrunedNode>();
  const nextMap = new Map<string, PrunedNode>();
  flattenByRef(prev, prevMap);
  flattenByRef(next, nextMap);

  const added: PrunedNode[] = [];
  const changed: Array<{ node: PrunedNode; changes: string[] }> = [];
  for (const [ref, node] of nextMap) {
    const before = prevMap.get(ref);
    if (!before) {
      added.push(node);
      continue;
    }
    const changes = describeChanges(before, node);
    if (changes.length) changed.push({ node, changes });
  }
  const removed: PrunedNode[] = [];
  for (const [ref, node] of prevMap) {
    if (!nextMap.has(ref)) removed.push(node);
  }

  if (!added.length && !removed.length && !changed.length) return "Δ no changes";

  added.sort(byRef);
  removed.sort(byRef);
  changed.sort((a, b) => byRef(a.node, b.node));

  const lines: string[] = [
    `Δ ${added.length} added, ${removed.length} removed, ${changed.length} changed`,
  ];
  for (const n of added) lines.push(`+ ${formatNodeFields(n)}`);
  for (const n of removed) lines.push(`- ${formatNodeFields(n)}`);
  for (const c of changed)
    lines.push(`~ ${formatNodeIdentity(c.node)} ${c.changes.join("; ")}`);
  return lines.join("\n");
}
