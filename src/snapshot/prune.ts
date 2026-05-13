/**
 * Accessibility tree pruner. Ported from windows-native-mcp's UIA tree ranking
 * (core/uia.py::_score_candidate, _walk_and_rank) and snapshot.py's data-collapse pass.
 *
 * Input: a raw a11y tree as produced by the extension's in-DOM walker.
 * Output: ranked + capped + collapsed tree with sequential numeric `ref` IDs.
 */

export interface RawNode {
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
  values?: string[];
  children?: PrunedNode[];
}

export interface PruneOptions {
  limit?: number;
  viewportOnly?: boolean;
  detail?: "standard" | "full";
  viewport?: { w: number; h: number };
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "listbox",
  "option",
  "slider",
  "spinbutton",
  "switch",
]);

const NAV_ROLES = new Set([
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

const DATA_ROLES = new Set(["listitem", "row", "treeitem"]);
const CONTAINER_ROLES = new Set([
  "group",
  "region",
  "section",
  "main",
  "navigation",
  "list",
  "tree",
]);

interface Candidate {
  node: RawNode;
  bfsOrder: number;
  parentIdx: number;
  siblingSameRoleCount: number;
  area: number;
}

interface ScoredCandidate {
  idx: number;
  score: number;
}

export function prune(root: RawNode, opts: PruneOptions = {}): PrunedNode {
  const limit = opts.limit ?? 500;
  const viewportOnly = opts.viewportOnly ?? true;
  const detail = opts.detail ?? "standard";
  const viewportW = opts.viewport?.w ?? 1920;
  const viewportH = opts.viewport?.h ?? 1080;

  // Pass 1: BFS collect candidates
  const candidates: Candidate[] = [];
  type QueueEntry = { node: RawNode; parentIdx: number };
  const queue: QueueEntry[] = [{ node: root, parentIdx: -1 }];
  let order = 0;

  while (queue.length) {
    const { node, parentIdx } = queue.shift()!;
    const keep =
      detail === "full" ||
      INTERACTIVE_ROLES.has(node.role) ||
      NAV_ROLES.has(node.role) ||
      DATA_ROLES.has(node.role) ||
      (node.name && node.name.trim() && !CONTAINER_ROLES.has(node.role));
    const visible = !viewportOnly || node.inViewport !== false;
    const idx = candidates.length;
    if (keep && visible) {
      const area = node.rect
        ? Math.max(0, node.rect.w) * Math.max(0, node.rect.h)
        : 0;
      candidates.push({
        node,
        bfsOrder: order++,
        parentIdx,
        siblingSameRoleCount: 0,
        area,
      });
      for (const child of node.children)
        queue.push({ node: child, parentIdx: idx });
    } else {
      for (const child of node.children) queue.push({ node: child, parentIdx });
    }
  }

  // Sibling-same-role counts: nodes sharing a parentIdx and role
  const siblingMap = new Map<string, number>();
  for (const c of candidates) {
    const key = `${c.parentIdx}::${c.node.role}`;
    siblingMap.set(key, (siblingMap.get(key) ?? 0) + 1);
  }
  for (const c of candidates) {
    const key = `${c.parentIdx}::${c.node.role}`;
    c.siblingSameRoleCount = siblingMap.get(key) ?? 1;
  }

  // Pass 2: score + rank
  const scored: ScoredCandidate[] = candidates.map((c, i) => ({
    idx: i,
    score: scoreCandidate(c, viewportW, viewportH),
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      candidates[a.idx]!.bfsOrder - candidates[b.idx]!.bfsOrder,
  );
  let selected = scored.slice(0, limit).map((s) => s.idx);

  // Pass 2.5: reserve slots for nav-role candidates if capped
  if (candidates.length > limit) {
    const selectedSet = new Set(selected);
    const reserved: number[] = [];
    const maxReserved = Math.min(20, Math.floor(limit / 10));
    for (
      let i = 0;
      i < candidates.length && reserved.length < maxReserved;
      i++
    ) {
      if (selectedSet.has(i)) continue;
      const c = candidates[i]!;
      const isNav =
        NAV_ROLES.has(c.node.role) ||
        (c.node.role === "listitem" && c.siblingSameRoleCount <= 10);
      if (isNav) reserved.push(i);
    }
    if (reserved.length) {
      selected = selected
        .slice(0, selected.length - reserved.length)
        .concat(reserved);
    }
  }

  // Assign sequential refs and build output
  const selectedSet = new Set(selected);
  const idxToRef = new Map<number, string>();
  selected.forEach((idx, n) => idxToRef.set(idx, String(n + 1)));

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
    const key = parent;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(idx);
  }

  function build(idx: number): PrunedNode {
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

    const children = childrenOf.get(idx) ?? [];
    if (children.length === 0) return node;

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
        if (values.length) node.values = values;
        return node;
      }
    }
    node.children = children.map(build);
    return node;
  }

  // Synthesize root if root itself wasn't kept
  const roots = childrenOf.get(-1) ?? [];
  if (roots.length === 1) return build(roots[0]!);
  return {
    ref: "0",
    role: root.role ?? "WebArea",
    children: roots.map(build),
  };
}

function scoreCandidate(
  c: Candidate,
  screenW: number,
  screenH: number,
): number {
  let score = Math.log2(Math.max(c.area, 1) + 1) * 10;

  const name = c.node.name?.trim();
  if (name) score += 30;
  if (!name && CONTAINER_ROLES.has(c.node.role)) score -= 40;

  if (c.node.rect) {
    const cx = c.node.rect.x + c.node.rect.w / 2;
    const cy = c.node.rect.y + c.node.rect.h / 2;
    if (cx < 0 || cy < 0 || cx > screenW || cy > screenH) score -= 100;
  }

  if (c.node.depth <= 2) score += 40;
  else if (c.node.depth <= 5) score += 20;

  if (c.siblingSameRoleCount > 20) score -= 30;

  if (NAV_ROLES.has(c.node.role)) score += 35;
  if (c.node.role === "listitem" && c.siblingSameRoleCount <= 10) score += 25;

  return score;
}
