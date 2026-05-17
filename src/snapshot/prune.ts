/**
 * Accessibility tree pruner. Ported from windows-native-mcp's UIA tree ranking
 * (core/uia.py::_score_candidate, _walk_and_rank) and snapshot.py's data-collapse pass.
 *
 * Input: a raw a11y tree as produced by the extension's in-DOM walker.
 * Output: ranked + capped + collapsed tree with sequential numeric `ref` IDs.
 */

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
  // the pruner's heuristics — cookie-banner collapse, dialog-modal boost,
  // a11y-hidden filtering, position-fixed overlay detection.
  ariaHidden?: boolean;
  inert?: boolean;
  dialogModal?: boolean;
  position?: string;
  /**
   * `window.devicePixelRatio` at snapshot time. Set on the tree root only by
   * `helpers.js::__earthlingA11y`. Used by the bridge's annotation hop to
   * scale CSS-pixel rects up to the physical-pixel coordinate space of the
   * captured bitmap.
   */
  dpr?: number;
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

export interface PruneMeta {
  limit_adjusted?: number;
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

const FORM_FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "button"]);
const COOKIE_BANNER_NAME_RE =
  /(cookie|consent|gdpr|privacy preference|privacy setting)/i;
const COOKIE_BANNER_ROLES = new Set([
  "dialog",
  "alertdialog",
  "region",
  "banner",
]);
const FULL_MODE_FLOOR = 1000;

interface Candidate {
  node: RawNode;
  bfsOrder: number;
  parentIdx: number;
  siblingSameRoleCount: number;
  area: number;
  inFormSubtree: boolean;
  inModalSubtree: boolean;
}

interface ScoredCandidate {
  idx: number;
  score: number;
}

export function prune(
  root: RawNode,
  opts: PruneOptions = {},
): PrunedNode & { meta?: PruneMeta } {
  const requestedLimit = opts.limit ?? 500;
  const viewportOnly = opts.viewportOnly ?? true;
  const detail = opts.detail ?? "standard";
  const viewportW = opts.viewport?.w ?? 1920;
  const viewportH = opts.viewport?.h ?? 1080;

  // Full-mode floor: at low limits, depth-first walk fills the bucket with
  // generic ancestor divs before any interactive leaf gets in. Raise the
  // effective limit to FULL_MODE_FLOOR so the agent gets useful data, and
  // surface `meta.limit_adjusted` so they know we did this.
  let effectiveLimit = requestedLimit;
  let limitAdjusted: number | undefined;
  if (detail === "full" && requestedLimit < FULL_MODE_FLOOR) {
    effectiveLimit = FULL_MODE_FLOOR;
    limitAdjusted = FULL_MODE_FLOOR;
  }

  // Pass 1: BFS collect candidates, dropping cookie banners (collapsed to a
  // placeholder), aria-hidden/inert subtrees, and tracking which candidates
  // sit inside a <form> or top-layer <dialog open> for the score boost.
  const candidates: Candidate[] = [];
  const collapsedBanners: Array<{
    parentIdx: number;
    placeholder: RawNode;
  }> = [];
  type QueueEntry = {
    node: RawNode;
    parentIdx: number;
    inFormSubtree: boolean;
    inModalSubtree: boolean;
  };
  const queue: QueueEntry[] = [
    {
      node: root,
      parentIdx: -1,
      inFormSubtree: false,
      inModalSubtree: false,
    },
  ];
  let order = 0;

  while (queue.length) {
    const entry = queue.shift()!;
    const { node, parentIdx } = entry;

    // a11y-hidden / inert subtrees: the user can't interact with them, so the
    // agent shouldn't waste tokens enumerating them.
    if (node.ariaHidden || node.inert) continue;

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
      collapsedBanners.push({
        parentIdx,
        placeholder: {
          nodeId: node.nodeId,
          role: "banner",
          name: `${node.name} (collapsed; cookie consent overlay)`,
          depth: node.depth,
          rect: node.rect,
          inViewport: node.inViewport,
          children: [],
        },
      });
      continue;
    }

    const keep =
      detail === "full" ||
      INTERACTIVE_ROLES.has(node.role) ||
      NAV_ROLES.has(node.role) ||
      DATA_ROLES.has(node.role) ||
      (node.name && node.name.trim() && !CONTAINER_ROLES.has(node.role));
    const visible = !viewportOnly || node.inViewport !== false;
    const idx = candidates.length;
    const inFormSubtree = entry.inFormSubtree || node.role === "form";
    const inModalSubtree = entry.inModalSubtree || node.dialogModal === true;
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
        inFormSubtree,
        inModalSubtree,
      });
      for (const child of node.children)
        queue.push({
          node: child,
          parentIdx: idx,
          inFormSubtree,
          inModalSubtree,
        });
    } else {
      for (const child of node.children)
        queue.push({
          node: child,
          parentIdx,
          inFormSubtree,
          inModalSubtree,
        });
    }
  }

  // Insert collapsed banners as flat candidates (no children, placeholder is
  // its own RawNode). Each gets a candidate slot so the agent can target it.
  for (const banner of collapsedBanners) {
    const area = banner.placeholder.rect
      ? Math.max(0, banner.placeholder.rect.w) *
        Math.max(0, banner.placeholder.rect.h)
      : 0;
    candidates.push({
      node: banner.placeholder,
      bfsOrder: order++,
      parentIdx: banner.parentIdx,
      siblingSameRoleCount: 1,
      area,
      inFormSubtree: false,
      inModalSubtree: false,
    });
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
  let selected = scored.slice(0, effectiveLimit).map((s) => s.idx);

  // Pass 2.5: reserve slots — nav (existing) + form fields (new for Issue #6)
  if (candidates.length > effectiveLimit) {
    const selectedSet = new Set(selected);
    const navReserved: number[] = [];
    const formReserved: number[] = [];
    const maxNavReserved = Math.min(20, Math.floor(effectiveLimit / 10));
    const maxFormReserved = Math.min(10, Math.floor(effectiveLimit / 20));
    for (let i = 0; i < candidates.length; i++) {
      if (selectedSet.has(i)) continue;
      const c = candidates[i]!;
      if (navReserved.length < maxNavReserved) {
        const isNav =
          NAV_ROLES.has(c.node.role) ||
          (c.node.role === "listitem" && c.siblingSameRoleCount <= 10);
        if (isNav) {
          navReserved.push(i);
          continue;
        }
      }
      if (formReserved.length < maxFormReserved) {
        if (c.inFormSubtree && FORM_FIELD_ROLES.has(c.node.role)) {
          formReserved.push(i);
          continue;
        }
      }
      if (
        navReserved.length >= maxNavReserved &&
        formReserved.length >= maxFormReserved
      )
        break;
    }
    const totalReserved = navReserved.length + formReserved.length;
    if (totalReserved) {
      selected = selected
        .slice(0, selected.length - totalReserved)
        .concat(navReserved, formReserved);
    }
  }

  // Refs map 1:1 to the page-side nodeId so the in-page `findByRef` can resolve them
  // to the exact element the agent saw in this snapshot. Synthetic root (no nodeId) keeps "0".
  const selectedSet = new Set(selected);
  const idxToRef = new Map<number, string>();
  selected.forEach((idx, n) =>
    idxToRef.set(idx, candidates[idx]!.node.nodeId ?? String(n + 1)),
  );

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
  let out: PrunedNode & { meta?: PruneMeta };
  if (roots.length === 1) {
    out = build(roots[0]!);
  } else {
    out = {
      ref: "0",
      role: root.role ?? "WebArea",
      children: roots.map(build),
    };
  }
  if (limitAdjusted !== undefined) {
    out.meta = { limit_adjusted: limitAdjusted };
  }
  return out;
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

  // Sidebar / large-list noise (Issue #13). Old rule was a flat -30 above 20
  // siblings — too lenient for ChatGPT-style 30-row recent-chats lists. New
  // formula: -10 per sibling above 6, capped at -80. Off-axis items (outside
  // the central horizontal third of the viewport) get an additional -20.
  if (c.siblingSameRoleCount > 6) {
    let penalty = Math.min(80, (c.siblingSameRoleCount - 6) * 10);
    if (c.node.rect) {
      const cx = c.node.rect.x + c.node.rect.w / 2;
      const leftThird = screenW / 3;
      const rightThird = 2 * (screenW / 3);
      if (cx < leftThird || cx > rightThird) penalty += 20;
    }
    score -= penalty;
  }

  if (NAV_ROLES.has(c.node.role)) score += 35;
  if (c.node.role === "listitem" && c.siblingSameRoleCount <= 10) score += 25;

  // Form-field boost (Issue #6): a textbox/button/combobox inside a <form>
  // ancestor is almost always part of the page's primary interactive form.
  // The previous heuristic had no signal for "this is the form the user came
  // here to fill in", so on Suno's Create page the lyrics textarea ranked
  // below sidebar nav links.
  if (c.inFormSubtree && FORM_FIELD_ROLES.has(c.node.role)) score += 60;

  // Modal boost: when a <dialog open> is in the top layer, its descendants
  // are almost certainly what the user is supposed to interact with next.
  if (c.inModalSubtree) score += 40;

  return score;
}
