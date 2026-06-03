/**
 * Ref grammar chokepoint — parse / format / compare element refs in ONE place.
 *
 * A ref identifies one element stably across snapshots (invariant #10). Two
 * forms coexist:
 *
 *   - MAIN FRAME (and its same-origin descendants — they share one JS realm and
 *     one page-side WeakMap): a bare decimal string, e.g. `"5"`. Frame id 0.
 *   - CROSS-ORIGIN frame (an OOPIF — its own realm, its own page-side counter):
 *     `"fN:localId"`, e.g. `"f2:5"` is local element 5 inside frame 2. (Phase 4.)
 *
 * Centralizing the grammar here is what lets the cross-origin form be added
 * without silently breaking a `Number()`-based sort somewhere: every consumer
 * that interprets a ref numerically (the diff sort, the nearby-refs proximity
 * listing, the future OOPIF splice) routes through `parseRef` / `compareRefs`,
 * so there is a single definition of "what a ref looks like".
 *
 * Lives in the snapshot layer (not `bridge/registry.ts`) so BOTH the snapshot
 * serializers (`diff.ts`) and the bridge ref registry can import it without a
 * circular layer dependency — `bridge` already depends on `snapshot`, never the
 * reverse.
 */

export interface ParsedRef {
  /** 0 for the main frame + same-origin descendants; >0 for a cross-origin OOPIF. */
  frameId: number;
  /** Page-side element id within that frame's realm. */
  localId: number;
}

/** `fN:localId` — N and localId are non-negative decimals. */
const FRAME_REF = /^f(\d+):(\d+)$/;

/**
 * Parse a ref into its (frameId, localId) tuple. A bare numeric ref is frame 0.
 * A malformed ref yields `NaN` localId (callers treat that as "not numerically
 * comparable" — e.g. the nearby-refs error falls back to a positional listing).
 */
export function parseRef(ref: string): ParsedRef {
  const m = FRAME_REF.exec(ref);
  if (m) return { frameId: Number(m[1]), localId: Number(m[2]) };
  return { frameId: 0, localId: Number(ref) };
}

/** Inverse of `parseRef`. Frame 0 formats bare (no `f0:` prefix) so main-frame
 * refs stay the terse bare-numeric form the agent already knows. */
export function formatRef(frameId: number, localId: number): string {
  return frameId === 0 ? String(localId) : `f${frameId}:${localId}`;
}

/**
 * Deterministic total order over refs: by frame id, then local id. NaN-safe — a
 * malformed component sorts last (Infinity) rather than poisoning the comparison
 * (the old `Number(a)-Number(b)` returned NaN for any `fN:` ref, which left
 * `Array.sort` order undefined). Replaces the bare numeric subtraction.
 */
export function compareRefs(a: string, b: string): number {
  const pa = parseRef(a);
  const pb = parseRef(b);
  const fa = Number.isFinite(pa.frameId) ? pa.frameId : Infinity;
  const fb = Number.isFinite(pb.frameId) ? pb.frameId : Infinity;
  if (fa !== fb) return fa - fb;
  const la = Number.isFinite(pa.localId) ? pa.localId : Infinity;
  const lb = Number.isFinite(pb.localId) ? pb.localId : Infinity;
  return la - lb;
}
