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
   * Set by helpers.js when this interactive element is NOT the topmost
   * hit-tested element at its own centre — a ghost/under-layer node (e.g. a
   * stale Articulate Storyline slide kept mounted under the active one). The
   * pruner DEPRIORITISES occluded nodes via a score penalty; it never excludes
   * them (a uniquely-named occluded control must still surface).
   */
  occluded?: boolean;
  /**
   * Set by helpers.js on a child-frame node whose document could not be
   * traversed (cross-origin SecurityError, too-deep nesting, or unloaded). The
   * subtree is a single leaf; `frameUrl` carries the frame's src. Phase 4 adds
   * opt-in cross-origin descent — until then the serializer renders a recovery
   * hint so the boundary is loud.
   */
  crossOrigin?: boolean;
  frameUrl?: string;
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
  values?: string[];
  /** Cross-origin child-frame leaf — see RawNode.crossOrigin. The serializer
   * renders a recovery hint next to it. */
  crossOrigin?: boolean;
  frameUrl?: string;
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
  /**
   * Total number of accessible (post-aria-hidden / post-cookie-collapse)
   * candidate nodes the pruner saw before viewport-filtering and limit-cap.
   * Always surfaced so the agent can tell whether useful nodes were dropped.
   */
  total_candidates?: number;
  /**
   * Set only when the pruner auto-engaged viewport-only mode because the
   * page exceeded `FALLBACK_RATIO * effectiveLimit` candidates AND the
   * caller did not pass `viewportOnly:true` explicitly. The agent can react
   * by scrolling or by re-snapshotting with a higher `limit`.
   */
  viewport_fallback?: {
    active: true;
    reason: "page_too_large";
    threshold: number;
    total_candidates: number;
  };
  /**
   * Agent-actionable recovery hint, set whenever the pruner capped, fell back,
   * or otherwise returned less than the full tree — the one channel the agent
   * reads to know what it didn't see and how to get it. Surfaced inline as the
   * first line of the serialized outline (see snapshot/serialize.ts) so it can't
   * be missed. CP4's loud-cap work writes richer notices through this same field.
   */
  notice?: string;
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
/**
 * When `viewportOnly` is left at its default (`false`) and the page surfaces
 * more than `FALLBACK_RATIO * effectiveLimit` candidate nodes, the pruner
 * auto-falls-back to viewport-only mode. This keeps the response compact for
 * gigantic pages (long doc reading, infinite feeds) without the agent having
 * to discover-and-set `viewportOnly` themselves. Surfaced as
 * `meta.viewport_fallback` so the agent knows it happened.
 */
const FALLBACK_RATIO = 3;

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
  const requestedLimit = opts.limit ?? 1500;
  // Default flip (Round 7): viewportOnly is now false by default so the
  // pruner ranks across the WHOLE page instead of forcing the agent to
  // scroll-and-snapshot before discovering a useful element. For pages that
  // exceed FALLBACK_RATIO * effectiveLimit candidates we auto-fall-back to
  // viewport-only and surface `meta.viewport_fallback` so the behaviour is
  // visible. The caller can still force viewport-only unconditionally by
  // passing `viewportOnly:true`.
  const explicitViewportOnly = opts.viewportOnly === true;
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

    // Keep-heuristic (Round 7 — pruning philosophy flip). Standard mode now
    // includes the whole SEMANTIC tree, not just bare interactives: anything
    // interactive/navigational/data-bearing, plus ANY named node — including
    // named landmarks/containers (region/main/navigation/list/group with an
    // aria-label) that earlier rounds dropped via the `!CONTAINER_ROLES`
    // exclusion. Keeping named containers restores page structure (the agent
    // sees `region "Comments"` wrapping its items instead of the items
    // re-parented up to the root). Unnamed structural nodes (generic divs,
    // unlabeled wrappers) stay out of standard mode — they add depth without
    // signal; `detail:"full"` is the escape hatch for the truly-complete tree.
    const keep =
      detail === "full" ||
      INTERACTIVE_ROLES.has(node.role) ||
      NAV_ROLES.has(node.role) ||
      DATA_ROLES.has(node.role) ||
      Boolean(node.name && node.name.trim());
    // Viewport-filter is now applied AFTER collection (see "viewport gate"
    // below) so `total_candidates` reflects the full page even when we
    // ultimately restrict the output to the viewport. This also unlocks the
    // auto-fallback decision, which needs to know the full count.
    const idx = candidates.length;
    const inFormSubtree = entry.inFormSubtree || node.role === "form";
    const inModalSubtree = entry.inModalSubtree || node.dialogModal === true;
    if (keep) {
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

  // Viewport gate (Round 7). Apply explicit viewportOnly:true OR auto-fallback
  // for huge pages. Filtering is done at pick-time (not by mutating the
  // candidates array) so parentIdx references stay stable for the tree-build
  // step below. `nearestSelectedAncestor` naturally skips dropped candidates.
  const total_candidates = candidates.length;
  const fallbackThreshold = effectiveLimit * FALLBACK_RATIO;
  const autoFallback =
    !explicitViewportOnly && total_candidates > fallbackThreshold;
  const applyViewportFilter = explicitViewportOnly || autoFallback;
  const isPickable = (i: number): boolean =>
    !applyViewportFilter || candidates[i]!.node.inViewport !== false;

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
  // Round 7: the score now decides ORDER (and, only when in-scope candidates
  // overflow `effectiveLimit`, which tail to defer) — never a within-budget
  // exclusion. `pickable` is the in-scope set after the viewport gate; the
  // slice caps it at the limit and `pickableCount` lets the meta.notice tell
  // the agent exactly how many ranked nodes were deferred and how to reach them.
  const pickable = scored.filter((s) => isPickable(s.idx));
  const pickableCount = pickable.length;
  let selected = pickable.slice(0, effectiveLimit).map((s) => s.idx);

  // Pass 2.5: reserve slots — nav (existing) + form fields (new for Issue #6)
  if (candidates.length > effectiveLimit) {
    const selectedSet = new Set(selected);
    const navReserved: number[] = [];
    const formReserved: number[] = [];
    const maxNavReserved = Math.min(20, Math.floor(effectiveLimit / 10));
    const maxFormReserved = Math.min(10, Math.floor(effectiveLimit / 20));
    for (let i = 0; i < candidates.length; i++) {
      if (selectedSet.has(i)) continue;
      if (!isPickable(i)) continue;
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
    if (c.node.crossOrigin) {
      node.crossOrigin = true;
      if (c.node.frameUrl) node.frameUrl = c.node.frameUrl;
    }

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
  // Meta — always surface total_candidates so the agent knows how much the
  // pruner had to work with. Conditionally surface limit_adjusted (full-mode
  // floor) and viewport_fallback (auto-engaged viewport-only).
  const meta: PruneMeta = { total_candidates };
  if (limitAdjusted !== undefined) meta.limit_adjusted = limitAdjusted;
  if (autoFallback) {
    meta.viewport_fallback = {
      active: true,
      reason: "page_too_large",
      threshold: fallbackThreshold,
      total_candidates,
    };
  }
  // Recovery-hint seam (Round 7 — loud caps). Whenever the pruner returned
  // less than the full tree — auto-fallback, an over-limit deferral, or the
  // full-mode floor — say so on this channel: what was hidden and the exact
  // levers to recover it. The serializer inlines this as the outline's first
  // line (`NOTE: …`) so a cap can never be silent.
  const keptCount = selected.length;
  const notices: string[] = [];
  if (autoFallback) {
    notices.push(
      `This page is large — ${total_candidates} candidate nodes, over the ${fallbackThreshold}-node auto-scope threshold — so the snapshot is scoped to the in-viewport subset. To reach the rest: scroll and re-snapshot, raise 'limit' (now ${requestedLimit}), or scope to a region/element.`,
    );
  }
  if (pickableCount > effectiveLimit) {
    notices.push(
      `Showing the ${keptCount} highest-ranked node(s)${applyViewportFilter ? " in scope" : ""} of ${pickableCount}; ${pickableCount - keptCount} lower-ranked node(s) are not in this snapshot — raise 'limit' (now ${requestedLimit}) or scope to a region/element to include them.`,
    );
  }
  if (limitAdjusted !== undefined) {
    notices.push(`Node limit raised to ${limitAdjusted} for detail:"full".`);
  }
  if (notices.length) meta.notice = notices.join(" ");
  out.meta = meta;
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

  // Active-layer penalty: an interactive element occluded by another layer at
  // its own centre (a ghost stale-slide control under the live one) ranks
  // below its live twin. Deliberately a moderate penalty, not exclusion — a
  // uniquely-named occluded control (no live twin competing for the slot) still
  // makes the cut. Only set on interactive nodes (helpers.js gates the
  // hit-test), so structural/named-container nodes are unaffected.
  if (c.node.occluded) score -= 60;

  return score;
}
