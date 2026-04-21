/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Context } from './context';
import { Response } from './response';
import { SessionLog } from './sessionLog';
import { MAX_TOOL_WAIT_MS, withTimeoutMarker } from './utils';
import { debug } from '../../utilsBundle';
import { mcpJsonl } from '../mcp/relay/debugJsonl';
import { raceAgainstDeadline } from '../../utils/isomorphic/timeoutRunner';
import { monotonicTime } from '../../utils/isomorphic/time';

/**
 * Total wall-clock budget for a single transparent reconnect (across all
 * retry attempts). Caps worst-case stall so one pathological extension
 * never freezes the MCP dispatcher longer than this.
 */
const RECONNECT_TOTAL_BUDGET_MS = 30_000;

import type { ContextConfig } from './context';
import type * as playwright from 'playwright-core';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

/**
 * Factory callback for re-acquiring a Browser after disconnection (extension
 * disable/enable, browser restart, daemon respawn). The caller (program.ts)
 * captures config + clientInfo in a closure so the backend can reconnect
 * transparently without re-threading those values through every tool call.
 */
export type BrowserReconnectFactory = () => Promise<playwright.Browser>;

export class BrowserBackend implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _config: ContextConfig;
  private _clientInfo: ClientInfo | undefined;
  private _reconnectFactory: BrowserReconnectFactory | undefined;
  private _reconnectInFlight: Promise<void> | undefined;
  /** Mutable so we can swap references on transparent reconnect. */
  browserContext: playwright.BrowserContext;

  constructor(
    config: ContextConfig,
    browserContext: playwright.BrowserContext,
    tools: Tool[],
    reconnectFactory?: BrowserReconnectFactory,
  ) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
    this._reconnectFactory = reconnectFactory;
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._clientInfo = clientInfo;
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._context = new Context(this.browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      cwd: clientInfo.cwd,
    });
  }

  async dispose() {
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
  }

  /**
   * Transparent reconnect for Phase 3: when the underlying CDP WebSocket has
   * been torn down (extension disable/enable, browser restart, daemon respawn),
   * the next tool call finds `browser().isConnected() === false`. We dispose
   * the stale context, acquire a fresh Browser via the factory, and build a
   * new Context from its default BrowserContext. Retries are cheap because
   * `acquireDaemon` already has a 30s budget for extension cold-start.
   */
  private async _reconnect(): Promise<void> {
    if (!this._reconnectFactory)
      throw new Error('Browser disconnected and no reconnect factory configured.');
    // Coalesce concurrent tool calls that all observe the same disconnect.
    if (this._reconnectInFlight) {
      await this._reconnectInFlight;
      return;
    }
    const clientId = `mcp-${process.pid}`;
    this._reconnectInFlight = (async () => {
      mcpJsonl('mcp.backend.reconnect.start', { clientId, detail: { budgetMs: RECONNECT_TOTAL_BUDGET_MS } });
      const attempts = 3;
      const deadline = monotonicTime() + RECONNECT_TOTAL_BUDGET_MS;
      let lastError: any;
      for (let i = 0; i < attempts; i++) {
        if (monotonicTime() >= deadline) {
          mcpJsonl('mcp.backend.reconnect.budget_exhausted', { clientId, detail: { attempt: i + 1 } });
          throw new Error(`Reconnect exceeded ${RECONNECT_TOTAL_BUDGET_MS}ms total budget after ${i} attempts`);
        }
        const attemptOutcome = await raceAgainstDeadline(async () => {
          try {
            await this._context?.dispose().catch(() => {});
            await this.browserContext.browser()?.close().catch(() => {});
            const fresh = await this._reconnectFactory!();
            const freshCtx = fresh.contexts()[0];
            if (!freshCtx)
              throw new Error('Reconnected browser has no default context');
            this.browserContext = freshCtx;
            this._context = new Context(this.browserContext, {
              config: this._config,
              sessionLog: this._sessionLog,
              cwd: this._clientInfo?.cwd ?? process.cwd(),
            });
            return { ok: true as const };
          } catch (e: any) {
            return { ok: false as const, error: e };
          }
        }, deadline);
        if (attemptOutcome.timedOut) {
          mcpJsonl('mcp.backend.reconnect.budget_exhausted', { clientId, detail: { attempt: i + 1 } });
          throw new Error(`Reconnect exceeded ${RECONNECT_TOTAL_BUDGET_MS}ms total budget after ${i + 1} attempts`);
        }
        if (attemptOutcome.result.ok) {
          mcpJsonl('mcp.backend.reconnect.success', { clientId, detail: { attempt: i + 1 } });
          return;
        }
        const e = attemptOutcome.result.error;
        lastError = e;
        mcpJsonl('mcp.backend.reconnect.fail', { clientId, detail: { attempt: i + 1, error: String(e?.message || e) } });
        if (i < attempts - 1) {
          const backoff = 1000 * Math.pow(2, i); // 1s, 2s
          const remaining = deadline - monotonicTime();
          if (remaining <= 0) {
            mcpJsonl('mcp.backend.reconnect.budget_exhausted', { clientId, detail: { attempt: i + 1, phase: 'backoff' } });
            throw new Error(`Reconnect exceeded ${RECONNECT_TOTAL_BUDGET_MS}ms total budget after ${i + 1} attempts`);
          }
          await new Promise(r => setTimeout(r, Math.min(backoff, remaining)));
        }
      }
      throw new Error(`Failed to reconnect after ${attempts} attempts: ${String(lastError?.message || lastError)}`);
    })();
    try {
      await this._reconnectInFlight;
    } finally {
      this._reconnectInFlight = undefined;
    }
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments']) {
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `### Error\nTool "${name}" not found` }],
        isError: true,
      };
    }
    // Phase 3: transparent reconnect. If the WS went down between calls we
    // rebuild the backend here so the agent never sees a stale-Browser error.
    const browser = this.browserContext.browser();
    if (browser && !browser.isConnected() && this._reconnectFactory) {
      try {
        await this._reconnect();
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: `### Error\nBrowser disconnected and reconnect failed: ${String(e?.message || e)}` }],
          isError: true,
        };
      }
    }
    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {}) as any;
    const cwd = rawArguments?._meta && typeof rawArguments?._meta === 'object' && (rawArguments._meta as any)?.cwd;
    const context = this._context!;
    const response = new Response(context, name, parsedArguments, cwd);
    context.setRunningTool(name);
    let responseObject: mcpServer.CallToolResult;
    try {
      await tool.handle(context, parsedArguments, response);
      // Outermost guard: even though _build() bounds snapshot + header capture
      // and safeWriteFile bounds file I/O, any future unbounded await inside
      // serialize() must not freeze the MCP tool result. 120s matches the
      // MAX_TOOL_WAIT_MS ceiling — this should never fire in practice.
      const serializeOutcome = await withTimeoutMarker<mcpServer.CallToolResult>(
          'response.serialize',
          () => response.serialize(),
          MAX_TOOL_WAIT_MS,
          () => ({
            content: [{ type: 'text' as const, text: `### Error\nResponse serialization timed out after ${MAX_TOOL_WAIT_MS}ms.` }],
            isError: true,
          }),
      );
      responseObject = serializeOutcome.result;
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
    } catch (error: any) {
      // If the error looks like a disconnect, attempt one reconnect + retry
      // before surfacing to the caller. Playwright's "Target page, context or
      // browser has been closed" and "Connection closed" are the typical
      // flavours when the CDP WS dies mid-call.
      const msg = String(error?.message || error);
      // "No debugger attached" is the semantic error the extension returns when
      // a tab-scoped CDP command races the extension SW restart — the lease was
      // revoked but the in-flight command reached the extension first. Treat it
      // as disconnect-shaped so transparent reconnect kicks in instead of
      // surfacing a raw extension error to the agent.
      const looksLikeDisconnect = /Target.*closed|Connection closed|browser has been closed|Session closed|No debugger attached/i.test(msg);
      if (looksLikeDisconnect && this._reconnectFactory) {
        try {
          await this._reconnect();
          const retryContext = this._context!;
          const retryResponse = new Response(retryContext, name, parsedArguments, cwd);
          retryContext.setRunningTool(name);
          try {
            await tool.handle(retryContext, parsedArguments, retryResponse);
            const retryOutcome = await withTimeoutMarker<mcpServer.CallToolResult>(
                'response.serialize.retry',
                () => retryResponse.serialize(),
                MAX_TOOL_WAIT_MS,
                () => ({
                  content: [{ type: 'text' as const, text: `### Error\nResponse serialization timed out after ${MAX_TOOL_WAIT_MS}ms (post-reconnect retry).` }],
                  isError: true,
                }),
            );
            responseObject = retryOutcome.result;
            this._sessionLog?.logResponse(name, parsedArguments, responseObject);
            return responseObject;
          } finally {
            retryContext.setRunningTool(undefined);
          }
        } catch (retryErr: any) {
          return {
            content: [{ type: 'text' as const, text: `### Error\n${msg}\nReconnect retry failed: ${String(retryErr?.message || retryErr)}` }],
            isError: true,
          };
        }
      }
      return {
        content: [{ type: 'text' as const, text: `### Error\n${msg}` }],
        isError: true,
      };
    } finally {
      context.setRunningTool(undefined);
    }
    return responseObject;
  }
}
