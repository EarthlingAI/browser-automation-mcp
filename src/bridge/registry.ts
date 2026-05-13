import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodRawShape } from "zod";
import { DaemonClient } from "./client";
import { BridgeSession, SnapshotParams } from "./session";
import { ExtCommand, TabId } from "../protocol";
import { prune, RawNode } from "../snapshot/prune";

export interface ToolContext {
  daemon: DaemonClient;
  session: BridgeSession;
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
};

export type ToolHandler<S extends ZodRawShape> = (
  args: z.infer<z.ZodObject<S>>,
  ctx: ToolContext,
) => Promise<unknown>;

export function registerTool<S extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: {
    name: string;
    description: string;
    schema: S;
    handler: ToolHandler<S>;
  },
): void {
  (server as any).tool(
    def.name,
    def.description,
    def.schema,
    async (args: any) => {
      try {
        return toolResult(await def.handler(args, ctx));
      } catch (err: any) {
        return toolError(err);
      }
    },
  );
}

export function registerActionTool<S extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: {
    name: string;
    description: string;
    schema: S;
    handler: ToolHandler<S>;
  },
): void {
  const augmented = { ...def.schema, ...AUTO_SNAPSHOT_FIELDS };
  (server as any).tool(
    def.name,
    def.description,
    augmented,
    async (args: any) => {
      const { snapshot: doSnap, delay, ...rest } = args;
      try {
        const result = (await def.handler(rest, ctx)) as Record<
          string,
          unknown
        >;
        const payload: Record<string, unknown> = { ...result };
        if (doSnap) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay * 1000));
          payload.snapshot = await replaySnapshot(ctx);
        }
        return toolResult(payload);
      } catch (err: any) {
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
    return prune(raw, {
      limit: params.limit,
      viewportOnly: params.viewportOnly,
      detail: params.detail,
    });
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}

function toolResult(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

function toolError(err: any) {
  const payload: Record<string, unknown> = {
    error: err?.message ?? String(err),
  };
  if (err?.leasedBy) payload.leasedBy = err.leasedBy;
  if (err?.since) payload.since = err.since;
  if (err?.hint) payload.hint = err.hint;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    isError: true,
  };
}

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
  const result = await ctx.daemon.exec(target, command);
  ctx.session.lastLeasedTab = target;
  return result;
}

export function updateSnapshotParams(
  session: BridgeSession,
  p: Partial<SnapshotParams>,
): void {
  session.lastSnapshotParams = { ...session.lastSnapshotParams, ...p };
}
