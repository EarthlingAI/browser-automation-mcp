import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { DaemonClient, EnvReport } from "./client";
import { BridgeSession, RefMeta, SnapshotParams } from "./session";
import { ExtCommand, SettleOptions, TabId } from "../protocol";
import { PrunedNode, RawNode } from "../snapshot/prune";
import { parseRef } from "../snapshot/ref";
import { coerceBoolean } from "./tools/coerce";
import { runUnifiedCapture } from "./tools/capture";

export interface ToolContext {
  daemon: DaemonClient;
  session: BridgeSession;
  // Settle policy injected by the action-tool wrapper for the duration of one
  // handler call. Reads + clears in execOnLeasedTab so a single handler that
  // makes multiple daemon hops only applies settle to the first (avoids
  // surprising 1.5s waits on every internal hop).
  pendingSettle?: SettleOptions;
}

const AUTO_SNAPSHOT_FIELDS = {
  snapshot: z
    .preprocess(coerceBoolean, z.boolean().default(true))
    .describe(
      "Auto-snapshot the tab after this action (default true; set false to skip). " +
        "The auto-snapshot returns a DIFF against the previous snapshot of the tab — only what changed — " +
        "led by a 'Δ {A} added, {R} removed, {K} changed' header, then '+ {node}' / '- {node}' / " +
        "'~ {node} field: old → new' lines keyed by ref ('~ … occluded: false → true' = a layer slid over it), " +
        "or 'Δ no changes'. It falls back to the full outline when there's no prior snapshot or the page turned " +
        "over completely; payload.meta.mode ('diff' | 'full') says which. Call browser_snapshot for the full tree.",
    ),
  delay: z
    .coerce.number()
    .min(0)
    .max(10)
    .default(0.1)
    .describe(
      "Seconds to wait before auto-snapshot. Increase for slow transitions (0.5 menus, 1.0 dialogs, 2.0+ page nav).",
    ),
  wait_for_settle: z
    .string()
    .default("dom")
    .describe(
      'How to detect the page "settling" before this action returns. ' +
        '"dom" (default) — first DOM mutation; "network" — first network request; ' +
        '"none" — return immediately (no settle wait); ' +
        '"selector:<css>" — wait for a CSS selector to appear. ' +
        "Set to none for actions you know are pure UI-state nudges.",
    ),
  settle_timeout: z
    .coerce.number()
    .int()
    .min(0)
    .max(30_000)
    .default(1500)
    .describe("Max ms to wait for settle before returning anyway."),
};

function parseSettle(
  waitForSettle: string,
  timeout: number,
): SettleOptions | undefined {
  if (!waitForSettle || waitForSettle === "none") {
    return { mode: "none" };
  }
  if (waitForSettle === "dom") {
    return { mode: "dom", timeout };
  }
  if (waitForSettle === "network") {
    return { mode: "network", timeout };
  }
  if (waitForSettle.startsWith("selector:")) {
    const selector = waitForSettle.slice("selector:".length);
    return { mode: "selector", selector, timeout };
  }
  // Unknown value — fall back to default behaviour.
  return { mode: "dom", timeout };
}

export type ToolHandler<S extends ZodRawShape> = (
  args: z.infer<z.ZodObject<S>>,
  ctx: ToolContext,
) => Promise<unknown>;

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  schema: S;
  handler: ToolHandler<S>;
  /**
   * Action tools that DON'T mutate page state (currently just `browser_wait_for`).
   * When true, the wrapper skips the post-handler `isStale = true` flip — a
   * pure wait shouldn't make previously-valid refs look stale. Auto-snapshot
   * + settle plumbing still apply.
   */
  readOnly?: boolean;
}

const COUNT_WRAPPED_TOOLS = new Set([
  "browser_list_tabs",
  "browser_console_messages",
  "browser_network_requests",
  "browser_cookies",
]);

export function registerTool<S extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDef<S>,
): void {
  // Cast the McpServer to `any` only for the registerTool call: the SDK's
  // ZodRawShapeCompat constraint blows up under deep generic instantiation
  // (TS2589) when called through our wrapper. The runtime contract is
  // identical — zod schemas pass through unchanged.
  (server as any).registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.schema,
      annotations: def.annotations,
    },
    async (args: any) => {
      try {
        const result = await def.handler(args, ctx);
        // CaptureResult shape `{ payload, image? }` — unified-capture tools
        // (browser_snapshot) return this so the wrapper can emit a mixed
        // image+text MCP envelope.
        if (isCaptureResult(result)) {
          return toolResult(
            result.payload,
            def.name,
            result.image,
            ctx.daemon.takeEnv(),
          );
        }
        return toolResult(result, def.name, undefined, ctx.daemon.takeEnv());
      } catch (err: any) {
        return toolError(err, ctx.daemon.takeEnv());
      }
    },
  );
}

/** Duck-type for the CaptureResult shape from `tools/capture.ts`. Lives here
 * instead of being imported to avoid a circular dep (capture.ts imports from
 * registry.ts). */
function isCaptureResult(
  v: unknown,
): v is { payload: Record<string, unknown>; image?: ImagePayload } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    "payload" in (v as Record<string, unknown>) &&
    typeof (v as Record<string, unknown>).payload === "object" &&
    (v as Record<string, unknown>).payload !== null
  );
}

export function registerActionTool<S extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDef<S>,
): void {
  const augmented = { ...def.schema, ...AUTO_SNAPSHOT_FIELDS };
  (server as any).registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: augmented,
      annotations: def.annotations,
    },
    async (args: any) => {
      const {
        snapshot: doSnap,
        delay,
        wait_for_settle,
        settle_timeout,
        ...rest
      } = args;
      try {
        ctx.pendingSettle = parseSettle(wait_for_settle, settle_timeout);
        const result = await def.handler(rest, ctx);
        // Defensive: a handler that never calls execOnLeasedTab leaves settle
        // pending. Clear so the next call doesn't inherit stale state.
        ctx.pendingSettle = undefined;
        // Action fired — mark refs stale. Refs aren't invalidated wholesale
        // (they're non-evicting); this just forces the next action's ref
        // through a liveness probe (refNeedsVerification) so a since-removed
        // element errors cleanly. Auto-snapshot flips it back to fresh. Skip
        // for read-only action tools (currently just browser_wait_for) — a pure
        // wait changes nothing.
        if (!def.readOnly) ctx.session.isStale = true;
        // Build the response envelope. Spreading `{...result}` on a primitive
        // (the bug behind Issue #2: `browser_evaluate("location.href")` came
        // back as `{0:"h",1:"t",2:"t",...}`) is wrong because spreading a
        // string produces a char-indexed object. Detect primitives and array
        // results and wrap them under a `result` key instead.
        const payload: Record<string, unknown> =
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result)
            ? { ...(result as Record<string, unknown>) }
            : { result };
        let imageForEnvelope: ImagePayload | undefined;
        if (doSnap) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
          const snap = await replaySnapshot(ctx);
          // CaptureResult shape on success — extract image into the outer
          // envelope so the agent's vision sees ONE annotated picture per
          // action, not the JSON-buried bytes. On error stub, the whole
          // {error,...} object becomes the snapshot payload as before.
          if (isCaptureResult(snap)) {
            payload.snapshot = snap.payload;
            imageForEnvelope = snap.image;
          } else {
            payload.snapshot = snap;
          }
        }
        return toolResult(
          payload,
          def.name,
          imageForEnvelope,
          ctx.daemon.takeEnv(),
        );
      } catch (err: any) {
        ctx.pendingSettle = undefined;
        return toolError(err, ctx.daemon.takeEnv());
      }
    },
  );
}

export async function replaySnapshot(ctx: ToolContext): Promise<unknown> {
  const params = ctx.session.lastSnapshotParams;
  const tabId = params.tabId ?? ctx.session.lastLeasedTab;
  if (!tabId)
    return {
      error: "no leased tab; call browser_switch_tab or browser_open_tab first",
    };
  try {
    // Replay every visual param the user opted into — including `screenshot`
    // (tri-state since Round 10: "off" | "annotated" | "raw"), so an agent
    // that opted into "annotated" or "raw" keeps getting the same flavour of
    // image on every action's auto-snapshot until it explicitly flips back to
    // "off". `save_to_path` is NEVER replayed; saving is a per-call opt-in,
    // never a session mode (avoids silent disk fill-up over long sessions).
    // `format` is no longer a SnapshotParams field (Round 7) —
    // runUnifiedCapture derives it from save_to_path (false → JPEG).
    return await runUnifiedCapture(ctx, tabId, {
      detail: params.detail,
      limit: params.limit,
      viewportOnly: params.viewportOnly,
      screenshot: params.screenshot,
      quality: params.quality,
      maxWidth: params.maxWidth,
      includeCrossOriginFrames: params.includeCrossOriginFrames,
      save_to_path: false,
      withTree: true,
      // CP5: the auto-snapshot path returns a diff against the prior tree of
      // this tab when one exists (else a full serialization). Explicit
      // browser_snapshot never sets this, so it always returns the full tree.
      allowDiff: true,
    });
  } catch (err: any) {
    // Preserve structured error fields so the recovery hint (and any lease
    // metadata) survives the auto-snapshot failure path. Otherwise an action
    // that succeeded but whose auto-snapshot failed would surface a bare
    // `{error:"extension not connected"}` snapshot stub without the
    // actionable recovery instruction. Mirror `toolError`'s explicit
    // null/undefined check pattern so the two paths can't drift apart on
    // edge cases like `kind:""` or `recovery:0`.
    const stub: Record<string, unknown> = {
      error: err?.message ?? String(err),
    };
    if (err?.kind !== undefined && err.kind !== null) stub.kind = err.kind;
    if (err?.recovery !== undefined && err.recovery !== null)
      stub.recovery = err.recovery;
    if (err?.hint !== undefined && err.hint !== null) stub.hint = err.hint;
    if (err?.leasedBy !== undefined && err.leasedBy !== null)
      stub.leasedBy = err.leasedBy;
    if (err?.since !== undefined && err.since !== null) stub.since = err.since;
    return stub;
  }
}

/**
 * Walk the pruned tree (refs that the agent actually saw) and the raw tree
 * (rects, role, name) and populate the session's per-ref metadata so a later
 * `resolveRef` call can give an actionable error. Flips `isStale` to false.
 */
export function populateRefs(
  session: BridgeSession,
  pruned: PrunedNode,
  raw: RawNode | undefined,
  tabId: TabId,
): void {
  // A snapshot on a different tab starts a fresh ref namespace — page-side ref
  // ids are per-tab, so the previous tab's cumulative registry would collide.
  // (The latest-snapshot map is wholesale-replaced regardless.)
  if (session.lastSnapshotTabId !== tabId) {
    session.refRegistry = new Map();
  }
  session.lastSnapshotRefs = new Map();
  session.lastSnapshotTabId = tabId;
  session.isStale = false;
  // Merge into the cumulative registry — refs that fell out of this snapshot
  // keep their last-known meta so non-evicting resolution + nearby-refs
  // listings still find them.
  forEachRefMeta(pruned, raw, tabId, (ref, meta) => {
    session.lastSnapshotRefs.set(ref, meta);
    session.refRegistry.set(ref, meta);
  });
}

/**
 * Merge a pruned tree's refs into the cumulative `refRegistry` ONLY — without
 * touching `lastSnapshotRefs`, `isStale`, or the per-tab reset. Used by the
 * `save_tree_to_path` offload: refs the agent reads from the offloaded file
 * must resolve (else "never minted" errors), but they are NOT part of the
 * inline snapshot — they take the carried-forward path (liveness probe before
 * acting, invariant #10). No-op for a tab other than the current snapshot's
 * (the registry is per-tab).
 */
export function mergeRefsIntoRegistry(
  session: BridgeSession,
  pruned: PrunedNode,
  raw: RawNode | undefined,
  tabId: TabId,
): void {
  if (session.lastSnapshotTabId !== tabId) return;
  forEachRefMeta(pruned, raw, tabId, (ref, meta) =>
    session.refRegistry.set(ref, meta),
  );
}

/**
 * Shared RefMeta construction for `populateRefs` / `mergeRefsIntoRegistry`:
 * index the raw tree by nodeId (rect source), walk the pruned tree, and emit
 * one `(ref, meta)` pair per real node. Single edit point for the RefMeta
 * shape.
 */
function forEachRefMeta(
  pruned: PrunedNode,
  raw: RawNode | undefined,
  tabId: TabId,
  emit: (ref: string, meta: RefMeta) => void,
): void {
  const rawByNodeId = new Map<string, RawNode>();
  if (raw) walkRaw(raw, rawByNodeId);
  const now = Date.now();
  walkPruned(pruned, (node) => {
    // Skip the synthetic-root sentinel ("0" is only emitted when the pruner
    // had to wrap multiple top-level roots). Real refs come from helpers.js
    // which pre-increments the persistent counter so node IDs start at "1" and
    // never collide with the sentinel.
    if (!node.ref || node.ref === "0") return;
    emit(node.ref, {
      role: node.role,
      name: node.name,
      rect: rawByNodeId.get(node.ref)?.rect,
      tabId,
      snapshotAt: now,
    });
  });
}

function walkRaw(node: RawNode, out: Map<string, RawNode>): void {
  if (node.nodeId) out.set(node.nodeId, node);
  for (const c of node.children) walkRaw(c, out);
}

function walkPruned(
  node: PrunedNode,
  visit: (n: PrunedNode) => void,
): void {
  visit(node);
  if (node.children) for (const c of node.children) walkPruned(c, visit);
}

/**
 * Validate a ref against the session's ref state. Returns the RefMeta when the
 * ref is known (either in the latest snapshot or carried forward in the
 * cumulative registry — refs are non-evicting). Throws an actionable error for
 * a ref that was never minted. A KNOWN ref may still point at a removed
 * element; `refNeedsVerification` decides whether the caller must confirm
 * liveness via a `resolve_ref` probe before acting. Mirrors windows-native-mcp's
 * DesktopState.resolve_target UX.
 */
export function resolveRef(session: BridgeSession, ref: string): RefMeta {
  // Fast path: the ref is in the most recent snapshot.
  const current = session.lastSnapshotRefs.get(ref);
  if (current) return current;
  // Non-evicting: a ref from an earlier snapshot of this tab still resolves
  // while its element survives. The caller verifies liveness before acting.
  const known = session.refRegistry.get(ref);
  if (known) return known;
  // Genuine miss. Distinguish "nothing snapshotted yet" from a typo.
  if (session.refRegistry.size === 0) {
    throw new Error(
      `ref ${ref} not found — no snapshot taken yet. Call browser_snapshot first to get element refs.`,
    );
  }
  throw nearbyRefsError(session, ref);
}

/**
 * Build an actionable "ref not found" error listing nearby refs (by numeric
 * proximity) from the cumulative registry, so the agent can spot a typo
 * (e.g. "12" → "21") or recover after the element genuinely vanished. Note the
 * registry may also hold offload-sourced refs (merged by the
 * `save_tree_to_path` pipeline via `mergeRefsIntoRegistry`) that never appeared
 * in an inline outline.
 */
export function nearbyRefsError(
  session: BridgeSession,
  ref: string,
  opts?: { gone?: boolean },
): Error {
  const wanted = parseRef(ref);
  // Never suggest the failed ref itself as a nearby alternative — in the `gone`
  // case it's still carried in the registry, so without this it would be listed
  // as "available" right after we said it no longer exists.
  const all = Array.from(session.refRegistry.entries()).filter(
    ([r]) => r !== ref,
  );
  // Proximity is within the SAME frame (local-id distance); refs in a different
  // frame get a huge finite offset so same-frame refs rank first and cross-frame
  // refs (if any make the top-20) trail them. A malformed ref (NaN local id)
  // falls back to a positional listing.
  const nearby = Number.isFinite(wanted.localId)
    ? all
        .map(([r, m]) => {
          const p = parseRef(r);
          const dist =
            p.frameId === wanted.frameId
              ? Math.abs(p.localId - wanted.localId)
              : Number.MAX_SAFE_INTEGER;
          return { ref: r, meta: m, dist };
        })
        .filter((e) => Number.isFinite(e.dist))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20)
    : all.slice(0, 20).map((e) => ({ ref: e[0], meta: e[1], dist: 0 }));
  const summary = nearby
    .map((e) => `${e.ref} (${e.meta.role}${e.meta.name ? ` '${e.meta.name}'` : ""})`)
    .join(", ");
  const lead = opts?.gone
    ? `ref ${ref} no longer exists — its element was removed from the page.`
    : `ref ${ref} not found.`;
  return new Error(
    `${lead} Available refs nearby: ${summary}. Re-run browser_snapshot if the page changed.`,
  );
}

/**
 * Whether a KNOWN ref must be confirmed live (via a `resolve_ref` probe) before
 * an action fires. A ref in the latest snapshot with no mutating action since
 * (`isStale=false`) is trusted directly; anything else — a ref carried forward
 * from an earlier snapshot, or any ref after an action — is re-verified so a
 * since-removed element errors instead of firing a silent no-op.
 */
export function refNeedsVerification(
  session: BridgeSession,
  ref: string,
): boolean {
  return !(session.lastSnapshotRefs.has(ref) && !session.isStale);
}

/** Native MCP image content block — emitted alongside the text payload by the
 * unified-capture tools so vision-capable hosts can attend to the picture
 * directly without re-reading base64 from the text envelope. */
export interface ImagePayload {
  /** Raw base64, no data: URL prefix. */
  data: string;
  /** "image/jpeg" or "image/png". */
  mimeType: string;
}

export function toolResult(
  result: unknown,
  toolName?: string,
  image?: ImagePayload,
  environment?: EnvReport,
) {
  let payload: unknown = result;
  // Lean envelope: wrap array-results from list-style tools so the agent
  // sees a top-level `count` without parsing the array length itself.
  if (toolName && COUNT_WRAPPED_TOOLS.has(toolName) && Array.isArray(result)) {
    payload = { count: result.length, items: result };
  }
  // Environment awareness: anything notable that happened on the tab during
  // this tool call (auto-handled dialogs, popups, a pending file chooser, a
  // blocked debugger attach) rides out on the SAME envelope — inform, never
  // block. Non-object payloads get wrapped so the field has somewhere to live.
  if (environment) {
    payload =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), environment }
        : { result: payload, environment };
  }
  const textBlock = {
    type: "text" as const,
    text: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
  // Image block FIRST when present — Anthropic vision attends to images that
  // precede related text. The text payload never duplicates the image bytes.
  const content = image
    ? [
        {
          type: "image" as const,
          data: image.data,
          mimeType: image.mimeType,
        },
        textBlock,
      ]
    : [textBlock];
  return { content };
}

export function toolError(err: any, environment?: EnvReport) {
  const payload: Record<string, unknown> = {
    error: err?.message ?? String(err),
  };
  // Same environment stamp as toolResult — an errored action is exactly when
  // the agent most needs to know a dialog fired or the attach is blocked.
  if (environment) payload.environment = environment;
  if (err?.leasedBy !== undefined && err.leasedBy !== null)
    payload.leasedBy = err.leasedBy;
  if (err?.since !== undefined && err.since !== null) payload.since = err.since;
  if (err?.hint !== undefined && err.hint !== null) payload.hint = err.hint;
  if (err?.recovery !== undefined && err.recovery !== null)
    payload.recovery = err.recovery;
  if (err?.kind !== undefined && err.kind !== null) payload.kind = err.kind;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

// Settle-capable command kinds. Anything in this set will get the pending
// settle policy merged in before being sent to the daemon.
const SETTLEABLE_KINDS = new Set([
  "click",
  "click_xy",
  "draw",
  "type",
  "select_option",
  "hover",
  "scroll",
  "upload",
  "press_key",
  "drag",
  "drop",
  "navigate",
  "navigate_back",
  "tabs_create",
]);

export async function execOnLeasedTab(
  ctx: ToolContext,
  tabId: TabId | undefined,
  command: ExtCommand,
): Promise<unknown> {
  const target = tabId ?? ctx.session.lastLeasedTab;
  if (!target)
    throw new Error(
      "no leased tab; call browser_switch_tab or browser_open_tab first",
    );
  // Validate any ref this command carries before paying the action round-trip.
  // Throws an actionable error for an unknown ref (never minted / typo).
  const refField = (command as { ref?: string }).ref;
  if (typeof refField === "string" && refField.length > 0) {
    // Cross-tab guard FIRST: page-side ref ids are per-tab, and a tab change
    // resets the registry — so a ref-bearing action targeting a tab other than
    // the last snapshot can't be validated against this tab's refs. Throw the
    // clearest message here, before the generic resolveRef lookup would mask
    // it with a nearby-refs error against the wrong tab's refs.
    if (
      ctx.session.lastSnapshotTabId !== undefined &&
      ctx.session.lastSnapshotTabId !== target
    ) {
      throw new Error(
        `ref ${refField} was captured on tab ${ctx.session.lastSnapshotTabId} but this action targets tab ${target}. Call browser_snapshot on tab ${target} first.`,
      );
    }
    resolveRef(ctx.session, refField);
    // Non-evicting refs are page-authoritative on liveness. A ref that isn't
    // freshly-current (carried forward from an earlier snapshot, or any ref
    // after an action) gets a cheap read-only `resolve_ref` probe so a
    // since-removed element errors here instead of firing a silent no-op. The
    // probe bypasses settle and never mutates; the action exec below still
    // carries the pending settle policy.
    if (refNeedsVerification(ctx.session, refField)) {
      const live = await ctx.daemon.exec(target, {
        kind: "resolve_ref",
        ref: refField,
      });
      if (!live) throw nearbyRefsError(ctx.session, refField, { gone: true });
    }
  }
  // Inject the wrapper's settle policy into the first daemon hop, then clear
  // so an internal multi-hop handler doesn't double-pay the settle cost.
  let finalCommand = command;
  if (ctx.pendingSettle && SETTLEABLE_KINDS.has(command.kind)) {
    finalCommand = { ...command, settle: ctx.pendingSettle } as ExtCommand;
  }
  ctx.pendingSettle = undefined;
  const result = await ctx.daemon.exec(target, finalCommand);
  ctx.session.lastLeasedTab = target;
  return result;
}

export function updateSnapshotParams(
  session: BridgeSession,
  p: Partial<SnapshotParams>,
): void {
  session.lastSnapshotParams = { ...session.lastSnapshotParams, ...p };
}
