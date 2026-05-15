import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodRawShape } from "zod";
import { DaemonClient } from "./client";
import { BridgeSession, RefMeta, SnapshotParams } from "./session";
import { ExtCommand, SettleOptions, TabId } from "../protocol";
import { prune, PrunedNode, RawNode } from "../snapshot/prune";

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
    .boolean()
    .default(true)
    .describe("Auto-refresh UI tree after this action. Set false to skip."),
  delay: z
    .number()
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
    .number()
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
        return toolResult(await def.handler(args, ctx), def.name);
      } catch (err: any) {
        return toolError(err);
      }
    },
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
        // Action fired — invalidate the session's ref registry. If we then
        // auto-snapshot, populateRefs flips it back to fresh. If not, the next
        // action gets the "stale" branch in resolveRef. Skip the flip for
        // read-only action tools (currently just browser_wait_for) — a pure
        // wait shouldn't make previously-valid refs look stale.
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
        if (doSnap) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
          payload.snapshot = await replaySnapshot(ctx);
        }
        return toolResult(payload, def.name);
      } catch (err: any) {
        ctx.pendingSettle = undefined;
        return toolError(err);
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
    const raw = (await ctx.daemon.exec(tabId, {
      kind: "snapshot",
      viewportOnly: params.viewportOnly,
      limit: params.limit,
    })) as RawNode;
    const pruned = prune(raw, {
      limit: params.limit,
      viewportOnly: params.viewportOnly,
      detail: params.detail,
    });
    populateRefs(ctx.session, pruned, raw, tabId);
    return pruned;
  } catch (err: any) {
    // Preserve structured error fields so the engine reconnect URL (and any
    // lease metadata) survives the auto-snapshot failure path. Otherwise an
    // action that succeeded but whose auto-snapshot failed would surface a
    // bare `{error:"extension not connected"}` snapshot stub without the
    // recovery hint.
    const stub: Record<string, unknown> = {
      error: err?.message ?? String(err),
    };
    if (err?.kind) stub.kind = err.kind;
    if (err?.recovery) stub.recovery = err.recovery;
    if (err?.hint) stub.hint = err.hint;
    if (err?.leasedBy) stub.leasedBy = err.leasedBy;
    if (err?.since) stub.since = err.since;
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
  session.lastSnapshotRefs = new Map();
  session.lastSnapshotTabId = tabId;
  session.isStale = false;
  const rawByNodeId = new Map<string, RawNode>();
  if (raw) walkRaw(raw, rawByNodeId);
  const now = Date.now();
  walkPruned(pruned, (node) => {
    // Skip the synthetic-root sentinel ("0" is only emitted when the pruner
    // had to wrap multiple top-level roots). Real refs come from helpers.js
    // which pre-increments `nodeCounter` so node IDs start at "1" and never
    // collide with the sentinel.
    if (!node.ref || node.ref === "0") return;
    const rawMatch = rawByNodeId.get(node.ref);
    session.lastSnapshotRefs.set(node.ref, {
      role: node.role,
      name: node.name,
      rect: rawMatch?.rect,
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
 * Validate a ref against the session's most recent snapshot. Returns the
 * RefMeta on success; throws an Error with an actionable message otherwise.
 * Mirrors windows-native-mcp's DesktopState.resolve_target UX.
 */
export function resolveRef(session: BridgeSession, ref: string): RefMeta {
  const meta = session.lastSnapshotRefs.get(ref);
  if (meta) return meta;
  if (session.isStale || session.lastSnapshotRefs.size === 0) {
    throw new Error(
      `ref ${ref} not found — snapshot is stale (action since last snapshot, or no snapshot taken yet). Call browser_snapshot to refresh element refs.`,
    );
  }
  // Fresh-state miss: list nearby refs by numeric proximity so the agent can
  // recognise a typo (e.g. "12" → "21") or a snapshot off-by-one.
  const wanted = Number(ref);
  const all = Array.from(session.lastSnapshotRefs.entries());
  const nearby = isFinite(wanted)
    ? all
        .map(([r, m]) => ({
          ref: r,
          meta: m,
          dist: Math.abs(Number(r) - wanted),
        }))
        .filter((e) => isFinite(e.dist))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 20)
    : all.slice(0, 20).map((e) => ({ ref: e[0], meta: e[1], dist: 0 }));
  const summary = nearby
    .map((e) => `${e.ref} (${e.meta.role}${e.meta.name ? ` '${e.meta.name}'` : ""})`)
    .join(", ");
  throw new Error(
    `ref ${ref} not found. Available refs nearby: ${summary}. Re-run browser_snapshot if the page changed.`,
  );
}

export function toolResult(result: unknown, toolName?: string) {
  let payload: unknown = result;
  // Lean envelope: wrap array-results from list-style tools so the agent
  // sees a top-level `count` without parsing the array length itself.
  if (toolName && COUNT_WRAPPED_TOOLS.has(toolName) && Array.isArray(result)) {
    payload = { count: result.length, items: result };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  };
}

export function toolError(err: any) {
  const payload: Record<string, unknown> = {
    error: err?.message ?? String(err),
  };
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
  "type",
  "select_option",
  "hover",
  "scroll",
  "upload",
  "press_key",
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
  // Validate any ref this command carries against the session's snapshot
  // before paying the round-trip cost. Throws an actionable error on miss.
  const refField = (command as { ref?: string }).ref;
  if (typeof refField === "string" && refField.length > 0) {
    resolveRef(ctx.session, refField);
    // Targeting a different tab than the one we last snapshotted is an
    // obvious staleness signal — fail fast with a clear message.
    if (
      ctx.session.lastSnapshotTabId !== undefined &&
      ctx.session.lastSnapshotTabId !== target
    ) {
      throw new Error(
        `ref ${refField} was captured on tab ${ctx.session.lastSnapshotTabId} but this action targets tab ${target}. Call browser_snapshot on tab ${target} first.`,
      );
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
