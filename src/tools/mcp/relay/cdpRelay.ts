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

/**
 * Earthling: multi-client CDP relay.
 *
 * One process owns:
 *   - a single WebSocket to the Earthling Browser Bridge extension
 *     (`/extension/<uuid>` — rejects 2nd connection)
 *   - many Playwright CDP clients (`/cdp/<uuid>` — one per MCP server process)
 *
 * Each client's CDP command ids and sessionIds are translated into a shared
 * namespace before forwarding to the extension, and events are fanned out
 * back to the clients that have subscribed via `Target.setAutoAttach` +
 * hold a lease on the event's tab.
 */

import http from 'http';
import os from 'os';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

import { debug, ws, wsServer } from '../../../utilsBundle';
import { registry } from '../../../server/registry/index';
import { ManualPromise } from '../../../utils/isomorphic/manualPromise';

import { LeaseTable } from './leases';

import type websocket from 'ws';
import type { WebSocket, WebSocketServer } from '../../../utilsBundle';
import type { ExtensionCommand, ExtensionEvents } from '../protocol';

const debugLogger = debug('pw:mcp:relay');

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

type CDPResponse = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string };
};

type TabInfo = {
  tabId: number;
  targetId: string;
  title: string;
  url: string;
};

type PendingCmd = {
  clientId: string;
  origId: number;
  origSessionId?: string;
};

const GRACE_PERIOD_MS = 60_000;

// Synthetic sessionId returned to Playwright from Target.attachToBrowserTarget.
// Commands sent with this sessionId are routed as top-level (Earthling.* handled locally).
const BROWSER_SESSION_ID = 'earthling-browser';

export class CDPRelayServer {
  private readonly _httpServer: http.Server;
  private readonly _wss: WebSocketServer;
  private readonly _browserChannel: string;
  private readonly _userDataDir?: string;
  private readonly _executablePath?: string;

  private readonly _cdpPath: string;
  private readonly _extensionPath: string;
  readonly uuid: string;

  private _extension: ExtensionConnection | null = null;
  private _extensionReadyPromise: ManualPromise<void> = new ManualPromise();
  private _browserLaunched = false;

  private readonly _clients = new Map<string, ClientConnection>();
  private _clientCounter = 0;

  // Shared id namespace toward the extension.
  private _nextRelayId = 1;
  private readonly _pendingCmds = new Map<number, PendingCmd>();

  // Bidirectional session translation, shared across all clients.
  // The tab-scope sessionId is allocated the first time a client auto-attaches
  // to a tab. The "real" sessionId (as seen by the extension's
  // chrome.debugger) is returned to the same virtual id.
  // extension sessionId -> { virtualId, tabId }
  private readonly _extSession = new Map<string, { virtualId: string; tabId: number }>();
  private readonly _virtualSession = new Map<string, { extSessionId?: string; tabId: number }>();
  private _nextVirtualSession = 1;
  // Per-tab virtual session (so all clients on the same tab see the same id).
  private readonly _tabVirtualSession = new Map<number, string>();

  private readonly _leases = new LeaseTable();

  private _graceTimer: NodeJS.Timeout | null = null;
  private _onIdle: (() => void) | null = null;

  constructor(httpServer: http.Server, browserChannel: string, userDataDir?: string, executablePath?: string) {
    this._httpServer = httpServer;
    this._browserChannel = browserChannel;
    this._userDataDir = userDataDir;
    this._executablePath = executablePath;

    this.uuid = cryptoRandomUUID();
    this._cdpPath = `/cdp/${this.uuid}`;
    this._extensionPath = `/extension/${this.uuid}`;

    void this._extensionReadyPromise.catch(() => {});

    this._wss = new wsServer({ server: httpServer });
    this._wss.on('connection', this._onConnection.bind(this));
  }

  extensionPath(): string { return this._extensionPath; }
  cdpPath(): string { return this._cdpPath; }
  isExtensionConnected(): boolean { return this._extension !== null; }
  clientCount(): number { return this._clients.size; }
  leaseSnapshot() { return this._leases.all(); }

  onIdle(cb: () => void) { this._onIdle = cb; }

  async ensureBrowserLaunched(): Promise<void> {
    if (this._extension)
      return;
    if (!this._browserLaunched) {
      this._launchBrowser();
      this._browserLaunched = true;
    }
    const timeout = process.env.PWMCP_TEST_CONNECTION_TIMEOUT
      ? parseInt(process.env.PWMCP_TEST_CONNECTION_TIMEOUT, 10)
      : 30_000;
    await Promise.race([
      this._extensionReadyPromise,
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error('Extension auto-connect timeout. Make sure the Earthling Browser Bridge extension is installed.'));
      }, timeout)),
    ]);
  }

  async shutdown(reason: string): Promise<void> {
    debugLogger('Shutting down relay:', reason);
    for (const c of [...this._clients.values()])
      c.drainAndClose(reason);
    this._extension?.close(reason);
    this._wss.close();
  }

  private _launchBrowser() {
    let executablePath = this._executablePath;
    if (!executablePath) {
      const executableInfo = registry.findExecutable(this._browserChannel);
      if (!executableInfo)
        throw new Error(`Unsupported channel: "${this._browserChannel}"`);
      executablePath = executableInfo.executablePath();
      if (!executablePath)
        throw new Error(`"${this._browserChannel}" executable not found.`);
    }
    const addr = this._httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 9223;
    const mcpRelayEndpoint = `ws://127.0.0.1:${port}${this._extensionPath}`;
    const url = new URL('chrome-extension://ifoggnihepkfpokholefpgpcgiikkeke/connect.html');
    url.searchParams.set('mcpRelayUrl', mcpRelayEndpoint);
    url.searchParams.set('autoConnect', 'true');
    const args: string[] = [];
    if (this._userDataDir)
      args.push(`--user-data-dir=${this._userDataDir}`);
    args.push('--silent-debugger-extension-api');
    if (os.platform() === 'linux' && this._browserChannel === 'chromium')
      args.push('--no-sandbox');
    args.push(url.toString());
    const child = spawn(executablePath, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    child.unref();
  }

  private _onConnection(ws: WebSocket, request: http.IncomingMessage): void {
    const u = new URL(`http://localhost${request.url}`);
    if (u.pathname === this._cdpPath) {
      this._handlePlaywrightConnection(ws);
    } else if (u.pathname === this._extensionPath) {
      this._handleExtensionConnection(ws);
    } else {
      ws.close(4004, 'Invalid path');
    }
  }

  // ------------------------------------------------------------------ Extension

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._extension) {
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    this._cancelGraceTimer();

    // Extension reconnect (e.g. after browser restart): flush stale state.
    // Old tab IDs no longer exist in the new browser session.
    if (this._tabVirtualSession.size > 0 || this._leases.all().length > 0) {
      debugLogger('Extension reconnected — flushing stale leases and virtual sessions');
      for (const client of this._clients.values())
        client.onExtensionLost('extension reconnected — previous browser session invalidated');
      this._tabVirtualSession.clear();
      this._leases.clearAll();
    }

    const conn = new ExtensionConnection(ws);
    this._extension = conn;
    conn.onclose = (c, reason) => {
      if (this._extension !== c)
        return;
      this._extension = null;
      this._extensionReadyPromise = new ManualPromise();
      void this._extensionReadyPromise.catch(() => {});
      // MV3 SW transient — extension may reconnect within seconds. Don't
      // notify clients or clear leases yet; wait for grace to fire.
      // Drop ext-side debugger session mapping (those sessions died with the SW).
      this._extSession.clear();
      this._virtualSession.clear();
      this._startGraceTimer(reason);
    };
    conn.onmessage = this._handleExtensionMessage.bind(this);
    conn.onresponse = this._handleExtensionResponse.bind(this);
    debugLogger('Extension WebSocket connected, waiting for tabReady...');
  }

  private _handleExtensionMessage<M extends keyof ExtensionEvents>(method: M, params: ExtensionEvents[M]['params']) {
    switch (method) {
      case 'extensionReady':
        debugLogger('Extension auto-connected.');
        break;
      case 'tabReady':
        this._extensionReadyPromise.resolve();
        break;
      case 'tabSwitched':
        // no global state to update (per-client sessions).
        break;
      case 'userSelectedTab':
        debugLogger('User selected tab hint:', (params as any).tabId);
        break;
      case 'forwardCDPEvent': {
        const cdpParams = params as ExtensionEvents['forwardCDPEvent']['params'];
        const extSid = cdpParams.sessionId;
        let virtualId: string | undefined;
        let tabId: number | undefined;
        const mapped = extSid ? this._extSession.get(extSid) : undefined;
        if (mapped) {
          virtualId = mapped.virtualId;
          tabId = mapped.tabId;
        } else if (cdpParams.tabId !== undefined) {
          // Top-level debugger events (no child sessionId) — attribute to the tab's virtual session.
          tabId = cdpParams.tabId;
          virtualId = this._tabVirtualSession.get(tabId);
        }
        if (virtualId === undefined || tabId === undefined) {
          // Unknown origin — broadcast raw (rare, pre-lease events).
          for (const c of this._clients.values())
            c.sendRaw({ method: cdpParams.method, params: cdpParams.params });
          break;
        }
        // Fan out to clients who subscribed to this tab.
        for (const c of this._clients.values()) {
          if (!c.isSubscribedToTab(tabId))
            continue;
          c.sendRaw({ sessionId: virtualId, method: cdpParams.method, params: cdpParams.params });
        }
        break;
      }
    }
  }

  private _handleExtensionResponse(id: number, result: any, error?: string) {
    const pending = this._pendingCmds.get(id);
    if (!pending)
      return;
    this._pendingCmds.delete(id);
    const client = this._clients.get(pending.clientId);
    if (!client)
      return;
    if (error) {
      client.sendRaw({ id: pending.origId, sessionId: pending.origSessionId, error: { message: error } });
    } else {
      client.sendRaw({ id: pending.origId, sessionId: pending.origSessionId, result });
    }
  }

  // ------------------------------------------------------------------ Playwright

  private _handlePlaywrightConnection(ws: WebSocket): void {
    const clientId = `c${++this._clientCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const client = new ClientConnection(clientId, ws, this);
    this._clients.set(clientId, client);
    this._cancelGraceTimer();
    debugLogger(`Playwright client connected: ${clientId} (total=${this._clients.size})`);
    // Ensure the extension is paired — launches the browser on first-ever connect.
    void this.ensureBrowserLaunched().catch(err => debugLogger(`ensureBrowserLaunched failed: ${err}`));
    ws.on('close', (code: number, reason: Buffer) => {
      if (this._clients.get(clientId) !== client)
        return;
      const released = this._leases.releaseAllFor(clientId);
      this._clients.delete(clientId);
      debugLogger(`Playwright client disconnected: ${clientId} (released tabs: ${released.join(',')})`);
      if (this._clients.size === 0 && this._extension === null)
        this._startGraceTimer();
    });
  }

  // ------------------------------------------------------------------ Helpers for ClientConnection

  leases(): LeaseTable { return this._leases; }
  extension(): ExtensionConnection | null { return this._extension; }

  /** Tell the given client that a tab was taken from them. */
  revokeClientSubscription(clientId: string, tabId: number, reason: string): void {
    const c = this._clients.get(clientId);
    if (c)
      c.revokeTab(tabId, reason);
  }

  async listTabs(): Promise<TabInfo[]> {
    if (!this._extension)
      throw new Error('Extension not connected');
    return await this._extension.send('listBrowserTabs', {});
  }

  virtualSessionForTab(tabId: number): string {
    let sid = this._tabVirtualSession.get(tabId);
    if (!sid) {
      sid = `pw-tab-${this._nextVirtualSession++}`;
      this._tabVirtualSession.set(tabId, sid);
      this._virtualSession.set(sid, { tabId });
    }
    return sid;
  }

  bindExtSession(extSessionId: string, virtualId: string, tabId: number) {
    this._extSession.set(extSessionId, { virtualId, tabId });
    this._virtualSession.set(virtualId, { extSessionId, tabId });
  }

  /** Translate virtual sessionId -> extension sessionId (or undefined for top-level). */
  resolveExtSessionId(virtualId: string | undefined): string | undefined {
    if (!virtualId)
      return undefined;
    return this._virtualSession.get(virtualId)?.extSessionId;
  }

  /** Send command to extension on behalf of a client; returns relayId for response tracking. */
  sendToExtensionForClient(clientId: string, origId: number, origSessionId: string | undefined, method: string, params: any, extSessionId: string | undefined): void {
    if (!this._extension)
      throw new Error('Extension not connected');
    const relayId = this._nextRelayId++;
    this._pendingCmds.set(relayId, { clientId, origId, origSessionId });
    this._extension.sendRaw({
      id: relayId,
      method: 'forwardCDPCommand',
      params: { sessionId: extSessionId, method, params },
    });
  }

  async callExtensionDirect<M extends keyof ExtensionCommand>(method: M, params: ExtensionCommand[M]['params']): Promise<any> {
    if (!this._extension)
      throw new Error('Extension not connected');
    return await this._extension.send(method, params);
  }

  private _startGraceTimer(reason: string = 'idle') {
    this._cancelGraceTimer();
    debugLogger(`Starting ${GRACE_PERIOD_MS}ms grace timer (${reason}).`);
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      if (this._extension !== null)
        return;  // extension recovered — nothing to do
      // Grace expired with no extension. Notify clients NOW with detach so
      // Playwright tears down its page state, then drop leases + tab maps.
      for (const client of this._clients.values())
        client.onExtensionLost(reason);
      this._tabVirtualSession.clear();
      this._leases.clearAll();
      if (this._clients.size === 0)
        this._onIdle?.();
    }, GRACE_PERIOD_MS);
  }

  private _cancelGraceTimer() {
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
  }
}

// ========================================================================== Client

class ClientConnection {
  readonly id: string;
  private readonly _ws: WebSocket;
  private readonly _relay: CDPRelayServer;
  private readonly _subscribedTabs = new Set<number>();
  // When the client issues a top-level Target.setAutoAttach it gets auto-leased
  // to `_primaryTab` — used to map tab-less session requests back to a tab.
  private _primaryTab: number | null = null;
  private _closed = false;

  constructor(id: string, ws: WebSocket, relay: CDPRelayServer) {
    this.id = id;
    this._ws = ws;
    this._relay = relay;
    ws.on('message', (data: websocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        void this._handleMessage(msg);
      } catch (e: any) {
        debugLogger(`[${this.id}] bad message`, e?.message);
      }
    });
  }

  isSubscribedToTab(tabId: number): boolean { return this._subscribedTabs.has(tabId); }

  sendRaw(msg: CDPResponse): void {
    if (this._closed)
      return;
    if (this._ws.readyState === ws.OPEN)
      this._ws.send(JSON.stringify(msg));
  }

  drainAndClose(reason: string) {
    this._closed = true;
    if (this._ws.readyState === ws.OPEN)
      this._ws.close(1012, reason);
  }

  /** Drop subscription for a single tab and emit detach to Playwright. */
  revokeTab(tabId: number, reason: string) {
    if (!this._subscribedTabs.has(tabId))
      return;
    const virtualId = this._relay.virtualSessionForTab(tabId);
    this.sendRaw({
      method: 'Target.detachedFromTarget',
      params: { sessionId: virtualId, targetId: `tab-${tabId}`, reason } as any,
    });
    this._subscribedTabs.delete(tabId);
    if (this._primaryTab === tabId)
      this._primaryTab = null;
  }

  onExtensionLost(reason: string) {
    for (const tabId of this._subscribedTabs) {
      const virtualId = this._relay.virtualSessionForTab(tabId);
      this.sendRaw({
        method: 'Target.detachedFromTarget',
        params: { sessionId: virtualId, targetId: `tab-${tabId}` },
      });
    }
    this._subscribedTabs.clear();
    this._primaryTab = null;
  }

  private async _handleMessage(msg: CDPCommand) {
    const { id, sessionId, method, params } = msg;
    try {
      // Top-level (no sessionId) OR synthetic browser-session commands: answer locally.
      if (!sessionId || sessionId === BROWSER_SESSION_ID) {
        const local = await this._handleTopLevel(method, params);
        if (local !== undefined) {
          this.sendRaw({ id, sessionId, result: local });
          return;
        }
      }

      // Tab-scoped: translate virtual sessionId to extension sessionId.
      const extSessionId = this._relay.resolveExtSessionId(sessionId);
      this._relay.sendToExtensionForClient(this.id, id, sessionId, method, params, extSessionId);
    } catch (e: any) {
      this.sendRaw({ id, sessionId, error: { message: e?.message || String(e) } });
    }
  }

  private async _handleTopLevel(method: string, params: any): Promise<any> {
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        };
      case 'Browser.setDownloadBehavior':
        return {};
      case 'Target.attachToBrowserTarget':
        return { sessionId: BROWSER_SESSION_ID };
      case 'Target.detachFromTarget':
        return {};
      case 'Target.setAutoAttach': {
        await this._handleSetAutoAttach();
        return {};
      }
      case 'Target.getTargetInfo': {
        if (this._primaryTab === null)
          return undefined;
        const tabs = await this._relay.listTabs();
        const tab = tabs.find(t => t.tabId === this._primaryTab);
        if (!tab)
          return undefined;
        return {
          targetId: tab.targetId,
          type: 'page',
          title: tab.title,
          url: tab.url,
          attached: true,
          browserContextId: 'default',
        };
      }
      // Earthling-custom pseudo-commands used by earthlingTabs.
      case 'Earthling.listBrowserTabs':
        return await this._relay.callExtensionDirect('listBrowserTabs', params || {});
      case 'Earthling.listTabsAnnotated': {
        const tabs = await this._relay.callExtensionDirect('listBrowserTabs', {});
        const leases = this._relay.leases();
        return tabs.map((t: any) => {
          const owner = leases.ownerOf(t.tabId);
          let lease: 'free' | 'you' | 'busy' = 'free';
          let ownerId: string | undefined;
          if (owner) {
            if (owner.ownerClientId === this.id) {
              lease = 'you';
            } else {
              lease = 'busy';
              ownerId = owner.ownerClientId;
            }
          }
          return { ...t, lease, ownerId };
        });
      }
      case 'Earthling.switchToTab': {
        const force = !!(params && params.force);
        const tabId: number = params?.tabId;
        // On force-takeover, revoke the current owner's subscription so they
        // stop seeing events for a tab they no longer own.
        if (force) {
          const existing = this._relay.leases().ownerOf(tabId);
          if (existing && existing.ownerClientId !== this.id)
            this._relay.revokeClientSubscription(existing.ownerClientId, tabId, `Lease revoked by ${this.id}`);
        }
        const claim = this.claimTab(tabId, force);
        if (!claim.ok)
          throw new Error(`Tab ${tabId} is leased by client ${claim.ownerId}. Pass force:true to take over.`);
        // Tell extension to switch debugger attachment. The MCP-side tool
        // handler calls response.setClose() which disposes this backend
        // (closing the connectOverCDP WebSocket and releasing leases). The
        // next tool call creates a fresh backend whose _handleSetAutoAttach
        // prefers the extension's connected tab — i.e. the one we just
        // switched to.
        return await this._relay.callExtensionDirect('switchToTab', { tabId });
      }
      case 'Earthling.releaseTab': {
        const tabId: number = params?.tabId;
        return { released: this.releaseTab(tabId) };
      }
      case 'Earthling.openTab':
        return await this._relay.callExtensionDirect('openTab', params || {});
      case 'Earthling.closeTab': {
        const tabId: number = params?.tabId;
        this.releaseTab(tabId);
        // Revoke any other client's lease on the closed tab to prevent orphans.
        const owner = this._relay.leases().ownerOf(tabId);
        if (owner) {
          this._relay.revokeClientSubscription(owner.ownerClientId, tabId, 'Tab closed');
          this._relay.leases().release(tabId, owner.ownerClientId);
        }
        return await this._relay.callExtensionDirect('closeTab', { tabId });
      }
      case 'Earthling.whoAmI':
        return { clientId: this.id, primaryTab: this._primaryTab };
    }
    return undefined;
  }

  private async _handleSetAutoAttach(): Promise<void> {
    // If already leased a tab, re-emit attachedToTarget for it.
    let tabId = this._primaryTab;
    if (tabId === null) {
      const tabs = await this._relay.listTabs();
      // Prefer the tab the extension is currently connected to (e.g. after
      // a tab switch disposed the previous backend). Fall back to first free.
      const connected = tabs.find((t: any) => t.connected);
      if (connected) {
        const claim = this._relay.leases().claim(connected.tabId, this.id, false);
        if (claim.ok)
          tabId = connected.tabId;
      }
      if (tabId === null) {
        // Filter out internal browser pages that Playwright can't snapshot.
        const INTERNAL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://'];
        const candidates = tabs
          .filter((t: any) => !INTERNAL_PREFIXES.some(p => (t.url || '').startsWith(p)))
          .map((t: any) => t.tabId)
          .sort((a: number, b: number) => a - b);
        // Race-safe: sweep candidates and pick the first that claim() accepts.
        for (const id of candidates) {
          const claim = this._relay.leases().claim(id, this.id, false);
          if (claim.ok) { tabId = id; break; }
        }
      }
      if (tabId === null)
        throw new Error('No free tab available to lease');
      this._primaryTab = tabId;
    }
    this._subscribedTabs.add(tabId);

    // Attach via extension (binds the extension sessionId for this tab if not already).
    const { targetInfo, sessionId: extSessionId } = await this._relay.callExtensionDirect('attachToTab', { tabId } as any);
    const virtualId = this._relay.virtualSessionForTab(tabId);
    if (extSessionId)
      this._relay.bindExtSession(extSessionId, virtualId, tabId);

    this.sendRaw({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: virtualId,
        targetInfo: { ...targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });
  }

  /** Public: claim a specific tab (used by earthlingTabs.browser_switch_tab). */
  claimTab(tabId: number, force: boolean): { ok: true } | { ok: false; ownerId: string } {
    const res = this._relay.leases().claim(tabId, this.id, force);
    if (!res.ok)
      return { ok: false, ownerId: res.owner.ownerClientId };
    // Release old primary if different.
    if (this._primaryTab !== null && this._primaryTab !== tabId) {
      this._relay.leases().release(this._primaryTab, this.id);
      this._subscribedTabs.delete(this._primaryTab);
    }
    this._primaryTab = tabId;
    this._subscribedTabs.add(tabId);
    return { ok: true };
  }

  releaseTab(tabId: number): boolean {
    const ok = this._relay.leases().release(tabId, this.id);
    if (ok) {
      this._subscribedTabs.delete(tabId);
      if (this._primaryTab === tabId)
        this._primaryTab = null;
    }
    return ok;
  }

  primaryTab(): number | null { return this._primaryTab; }
}

// ========================================================================== Extension IO

type ExtensionResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

export class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void; reject: (e: Error) => void; error: Error }>();
  private _lastId = 0;

  onmessage?: <M extends keyof ExtensionEvents>(method: M, params: ExtensionEvents[M]['params']) => void;
  onresponse?: (id: number, result: any, error?: string) => void;
  onclose?: (self: ExtensionConnection, reason: string) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    ws.on('message', this._onMessage.bind(this));
    ws.on('close', (code: number, reason: Buffer) => {
      this._dispose();
      this.onclose?.(this, reason?.toString() || `code=${code}`);
    });
    ws.on('error', () => this._dispose());
  }

  /** Typed send with locally-tracked response. */
  async send<M extends keyof ExtensionCommand>(method: M, params: ExtensionCommand[M]['params']): Promise<any> {
    if (this._ws.readyState !== ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId + 1_000_000_000; // separate id space from relay-forwarded commands
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }

  /** Raw send (id already chosen by caller — used by relay-forwarded commands). */
  sendRaw(msg: any): void {
    if (this._ws.readyState !== ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    this._ws.send(JSON.stringify(msg));
  }

  close(reason: string) {
    if (this._ws.readyState === ws.OPEN)
      this._ws.close(1000, reason);
  }

  private _onMessage(raw: websocket.RawData) {
    let obj: ExtensionResponse;
    try {
      obj = JSON.parse(raw.toString());
    } catch {
      this._ws.close();
      return;
    }
    if (obj.id !== undefined) {
      if (this._callbacks.has(obj.id)) {
        const cb = this._callbacks.get(obj.id)!;
        this._callbacks.delete(obj.id);
        if (obj.error) {
          cb.error.message = obj.error;
          cb.reject(cb.error);
        } else {
          cb.resolve(obj.result);
        }
      } else {
        this.onresponse?.(obj.id, obj.result, obj.error);
      }
    } else if (obj.method) {
      this.onmessage?.(obj.method as keyof ExtensionEvents, obj.params);
    }
  }

  private _dispose() {
    for (const cb of this._callbacks.values())
      cb.reject(new Error('WebSocket closed'));
    this._callbacks.clear();
  }
}

// Earthling: standalone uuid generator (crypto.randomUUID available on Node 18+).
function cryptoRandomUUID(): string {
  return randomUUID();
}

