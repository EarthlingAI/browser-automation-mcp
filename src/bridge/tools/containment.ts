/**
 * Pure helper for computing per-rect `drawStroke` flags via containment-based
 * parent suppression.
 *
 * Why this exists: when the annotated-screenshot pipeline draws bounding
 * boxes for EVERY ranked candidate (form, navigation, dialog, WebArea root,
 * etc.), nested wrappers stroke a giant border around their entire subtree
 * — the worst offender being the WebArea root, which strokes the whole
 * viewport. Visually noisy, info-poor: the parent's stroke adds nothing
 * the children's strokes don't already convey.
 *
 * Rule: for each annotated rect, if any OTHER annotated rect is fully
 * contained within it (strict containment), suppress its stroke. The badge
 * still draws so the agent can target the parent. Strokes only render for
 * "leaf" rects, producing a cleaner picture without losing addressability.
 *
 * O(n²) with early break. Typical n ≤ 500 → 250k strict-rect-compare ops
 * → sub-millisecond. No spatial index needed.
 */

interface RectLike {
  rect: { x: number; y: number; w: number; h: number };
}

/**
 * For each rect at index `i`, return `true` if it should be stroked.
 * Equivalent: return `false` iff some OTHER rect is strictly inside this one.
 *
 * Strict containment means every edge of the inner rect lies strictly
 * inside the outer rect's bounds — equal bounds keep both strokes, so two
 * coincident rects don't both vanish.
 *
 * Edge cases that intentionally fall through with `drawStroke:true`:
 *   - zero-area rects (no children can fit strictly inside) → stroke (the
 *     extension already drops zero-width rects via MIN_ANNOTATABLE_PX);
 *   - rects with negative dimensions (treated as if no containment is
 *     possible; the bridge upstream already clamps, so this is defensive);
 *   - identical-bounds rects (equality fails the strict-< check) → both
 *     keep their strokes (rare and visually acceptable).
 */
export function computeDrawStroke(rects: RectLike[]): boolean[] {
  const n = rects.length;
  const drawStroke = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i++) {
    const a = rects[i]!.rect;
    const aRight = a.x + a.w;
    const aBottom = a.y + a.h;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = rects[j]!.rect;
      // Strict containment: b's bounds lie strictly inside a's bounds.
      // If yes, a is a parent of b — suppress a's stroke.
      if (
        b.x > a.x &&
        b.y > a.y &&
        b.x + b.w < aRight &&
        b.y + b.h < aBottom
      ) {
        drawStroke[i] = false;
        break;
      }
    }
  }
  return drawStroke;
}
