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
import { daemonJsonl } from './debugJsonl';

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
  method?: string;
  realSessionId?: string;
};

// Grace period after the extension disconnects before notifying clients and
// clearing state. MV3 service workers sleep transiently (~30s) and reconnect
// on wake; the default 60s covers that comfortably. Overridable via env for
// test / debug scenarios that need to exercise the grace-expiry code path
// (e.g. the `onExtensionLost` force-close) without waiting the full minute.
const GRACE_PERIOD_MS = parseInt(process.env.BROWSER_AUTOMATION_MCP_GRACE_MS || '60000', 10);

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

  // Survives client WebSocket close → reconnect cycles so _handleSetAutoAttach
  // knows which tab the client last switched to (the switch disposes the
  // backend, releasing leases and deleting the ClientConnection; the fresh
  // connection needs this hint to lease the correct tab).
  private readonly _lastSwitchedTab = new Map<string, number>();

  // Defensive twin of `_lastSwitchedTab`. `_lastSwitchedTab` is CONSUMED by
  // `_handleSetAutoAttach` Priority 1 — so once the happy path fires, the
  // hint is gone and a subsequent bug that rebinds to the wrong tab is
  // invisible. This map is set at switch-commit time and cleared only on
  // actual tab-gone events (`_forgetTab`, `Earthling.releaseTab`). At
  // `_handleSetAutoAttach` exit, if `_declaredSwitchTarget[clientId]` is set
  // and doesn't match the chosen `activeTabId`, we bump
  // `switch_tab_target_mismatch` so regressions of the Scenario-1 bug class
  // (hint chain bypassed, client lands on an unintended tab) show up in
  // /health without needing a Terra session to catch.
  readonly _declaredSwitchTarget = new Map<string, number>();

  // Auto-opened about:blank tabs (one per client, spawned by the Priority 3
  // fallback in `_handleSetAutoAttach`). These are owned by the daemon, not
  // the user — so the daemon must close them when the client no longer needs
  // them: on client disconnect, or when the client switches off the blank.
  // Without this the browser leaks one blank per CDP client ever connected.
  readonly _autoOpenedBlanks = new Map<string, Set<number>>();

  // Per-client mapping from tabId → real Chromium targetId (the value the
  // daemon emitted in `Target.attachedToTarget.targetInfo.targetId`). Required
  // because Playwright's unpatched `_onDetachedFromTarget` matches by real
  // targetId; emitting a synthetic `tab-${tabId}` is silently ignored, leaving
  // the client's `_crPages` map carrying a dead entry. Populated on every
  // `Target.attachedToTarget` emit (via `recordClientTabTargetId`); cleared on
  // tab revoke / detach / client disconnect.
  private readonly _clientTabTargetIds = new Map<string, Map<number, string>>();

  private _graceTimer: NodeJS.Timeout | null = null;
  private _onIdle: (() => void) | null = null;

  // Lightweight observability counters exposed via /health. Pure-additive: the
  // existing `session.autoAttach.hint.*` JSONL entries remain authoritative for
  // forensic traces; these aggregates let a /health reader get a ratio without
  // parsing JSONL.
  private _telemetry = {
    hintDirectAttach: 0,
    hintMissed: 0,
    hintFallbackBlank: 0,
    serializeRetryTimeout: 0,
    // Bumped by BrowserBackend.callTool (MCP process) via POST /telemetry/bump
    // whenever the per-client dispatch mutex actually serializes a parallel
    // tool_use block. Any non-zero count signals concurrent agent dispatch —
    // useful for confirming the mutex is doing its job in production.
    concurrentDispatchSerialized: 0,
    // Bumped by CdpRelay._handleSetAutoAttach exit when the declared-switch
    // target disagrees with the tab the client actually landed on. Counts
    // regressions of the Scenario-1 "_cleanupTabSessions wiped the hint mid-
    // lease-release" bug class. Non-zero = investigate.
    switchTabTargetMismatch: 0,
    // Lifetime peak of concurrent Playwright clients ever observed on this
    // daemon. Complements `clients_1s_high_water` (rolling 1s) by capturing
    // forensic churn that the rolling counter can miss between resets.
    lifetimeClientsHighWater: 0,
    // Total client WebSocket closes observed (both orderly client.close() and
    // daemon-initiated drainAndClose cascades funnel through the same
    // ws.on('close') handler, so one bump site covers both cases).
    clientDisconnectCount: 0,
  };
  private _clientsHighWater1s = 0;
  private _clientsHighWaterResetTimer: NodeJS.Timeout | null = null;

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

    // Reset the 1-second client-count high-water every second so /health shows
    // a rolling peak (absorbs force-takeover reconnect blips without losing
    // the instantaneous `clients` field). Unref so it never holds the daemon open.
    this._clientsHighWaterResetTimer = setInterval(() => {
      this._clientsHighWater1s = this._clients.size;
    }, 1_000);
    this._clientsHighWaterResetTimer.unref?.();
  }

  extensionPath(): string { return this._extensionPath; }
  cdpPath(): string { return this._cdpPath; }
  isExtensionConnected(): boolean { return this._extension !== null; }
  clientCount(): number { return this._clients.size; }
  clientsHighWater1s(): number { return this._clientsHighWater1s; }
  telemetry(): Readonly<typeof this._telemetry> { return this._telemetry; }
  incrementHintDirectAttach(): void { this._telemetry.hintDirectAttach++; }
  incrementHintMissed(): void { this._telemetry.hintMissed++; }
  incrementHintFallbackBlank(): void { this._telemetry.hintFallbackBlank++; }
  incrementSerializeRetryTimeout(): void { this._telemetry.serializeRetryTimeout++; }
  incrementConcurrentDispatchSerialized(): void { this._telemetry.concurrentDispatchSerialized++; }
  incrementSwitchTabTargetMismatch(): void { this._telemetry.switchTabTargetMismatch++; }
  updateLifetimeClientsHighWater(current: number): void {
    if (current > this._telemetry.lifetimeClientsHighWater)
      this._telemetry.lifetimeClientsHighWater = current;
  }
  incrementClientDisconnectCount(): void { this._telemetry.clientDisconnectCount++; }
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
    // Clear the timer in `finally` so a winning `_extensionReadyPromise` does
    // not leave a dangling setTimeout handle in the event loop. The probe work
    // (`_extensionReadyPromise`) has no native cancellation — it settles via
    // `_handleExtensionConnection`/`_onExtensionLost` regardless — so a signal
    // has nothing to attach to; the `clearTimeout` alone covers the leak.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this._extensionReadyPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Extension auto-connect timeout. Make sure the Earthling Browser Bridge extension is installed.'));
          }, timeout);
        }),
      ]);
    } finally {
      if (timer)
        clearTimeout(timer);
    }
  }

  async shutdown(reason: string): Promise<void> {
    debugLogger('Shutting down relay:', reason);
    if (this._clientsHighWaterResetTimer) {
      clearInterval(this._clientsHighWaterResetTimer);
      this._clientsHighWaterResetTimer = null;
    }
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
    // The extension auto-connects on its service worker startup via /discover
    // on the daemon's loopback port — no connect URL needed. Launch the browser
    // to about:blank; the extension discovers the daemon and establishes the
    // WebSocket independently.
    const args: string[] = [];
    if (this._userDataDir)
      args.push(`--user-data-dir=${this._userDataDir}`);
    args.push('--silent-debugger-extension-api');
    if (os.platform() === 'linux' && this._browserChannel === 'chromium')
      args.push('--no-sandbox');
    args.push('about:blank');
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
      this._handlePlaywrightConnection(ws, u);
    } else if (u.pathname === this._extensionPath) {
      this._handleExtensionConnection(ws);
    } else {
      ws.close(4004, 'Invalid path');
    }
  }

  // ------------------------------------------------------------------ Extension

  private async _handleExtensionConnection(ws: WebSocket): Promise<void> {
    if (this._extension) {
      daemonJsonl('ws.ext.rejected', { detail: { reason: 'duplicate connection' } });
      ws.close(1000, 'Another extension connection already established');
      return;
    }
    daemonJsonl('ws.ext.open', { detail: { leases: this._leases.all().length, clients: this._clients.size } });
    this._cancelGraceTimer();

    const conn = new ExtensionConnection(ws);
    // Wire handlers FIRST so tabReady/responses aren't missed during async probe.
    conn.onmessage = this._handleExtensionMessage.bind(this);
    conn.onresponse = this._handleExtensionResponse.bind(this);

    // Smart reconnect: distinguish SW sleep→wake (tabs alive) from browser
    // restart (tabs dead) by probing the extension for surviving tabs.
    if (this._tabVirtualSession.size > 0 || this._leases.all().length > 0) {
      const leaseCount = this._leases.all().length;
      const virtualCount = this._tabVirtualSession.size;
      debugLogger(`Extension reconnected — probing for surviving tabs (leases=${leaseCount}, virtualSessions=${virtualCount})`);
      daemonJsonl('ext.reconnect.probe.start', { detail: { leases: leaseCount, virtualSessions: virtualCount } });
      try {
        const tabs: any[] = await conn.send('listBrowserTabs', {}, 2_000);
        const liveTabIds = new Set(tabs.map((t: any) => t.tabId));
        const leasedTabIds = this._leases.all().map(l => l.tabId);
        const surviving = leasedTabIds.filter(id => liveTabIds.has(id));
        daemonJsonl('ext.reconnect.probe.result', { detail: { live: tabs.length, leased: leasedTabIds.length, surviving: surviving.length } });

        if (surviving.length > 0) {
          // SW restart — tabs alive. Re-attach debugger, keep client state.
          debugLogger(`SW restart detected — ${surviving.length}/${leasedTabIds.length} leased tabs survived, re-attaching`);
          daemonJsonl('ext.reconnect.sw_restart', { detail: { surviving, all: leasedTabIds } });
          // Clear stale ext-side session mappings (those died with the SW).
          this._extSession.clear();
          this._virtualSession.clear();
          // Re-attach debugger to surviving tabs and re-bind sessions.
          for (const tabId of surviving) {
            try {
              const { sessionId: extSid } = await conn.send('attachToTab', { tabId }, 5_000);
              const virtualId = this._tabVirtualSession.get(tabId);
              if (extSid && virtualId)
                this.bindExtSession(extSid, virtualId, tabId);
              debugLogger(`  Re-attached tab ${tabId} (extSid=${extSid || 'none'})`);
              daemonJsonl('ext.reattach.ok', { tabId, virtualSessionId: virtualId, realSessionId: extSid });
            } catch (e) {
              debugLogger(`  Failed to reattach tab ${tabId}: ${e}`);
              daemonJsonl('ext.reattach.fail', { tabId, detail: { error: String(e) } });
              const owner = this._leases.ownerOf(tabId);
              if (owner) {
                this.revokeClientSubscription(owner.ownerClientId, tabId, 'tab lost during SW restart');
                this._leases.release(tabId, owner.ownerClientId);
              }
            }
          }
          // Clean up leases for tabs that no longer exist.
          for (const tabId of leasedTabIds) {
            if (!liveTabIds.has(tabId)) {
              debugLogger(`  Tab ${tabId} gone — revoking lease`);
              const owner = this._leases.ownerOf(tabId);
              if (owner) {
                this.revokeClientSubscription(owner.ownerClientId, tabId, 'tab gone after SW restart');
                this._leases.release(tabId, owner.ownerClientId);
              }
              this._tabVirtualSession.delete(tabId);
            }
          }
        } else {
          // Browser restart — flush everything.
          debugLogger('Browser restart detected — flushing all client state');
          daemonJsonl('ext.reconnect.browser_restart', { detail: { leasedTabIds } });
          for (const client of this._clients.values())
            client.onExtensionLost('browser restart — previous session invalidated');
          this._tabVirtualSession.clear();
          this._leases.clearAll();
          this._lastSwitchedTab.clear();
        }
      } catch (e) {
        // Probe failed (timeout or extension error) — flush as safe default.
        debugLogger(`Extension probe failed (${e}) — flushing as safe default`);
        daemonJsonl('ext.reconnect.probe.fail', { detail: { error: String(e) } });
        for (const client of this._clients.values())
          client.onExtensionLost('extension reconnect probe failed');
        this._tabVirtualSession.clear();
        this._leases.clearAll();
        this._lastSwitchedTab.clear();
      }
    }

    this._extension = conn;
    conn.onclose = (c, reason) => {
      if (this._extension !== c)
        return;
      debugLogger(`Extension WebSocket closed: reason="${reason}", leases=${this._leases.all().length}, clients=${this._clients.size}`);
      daemonJsonl('ws.ext.close', { detail: { reason, leases: this._leases.all().length, clients: this._clients.size } });
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
      case 'tabDetached': {
        // Extension lost debugger attachment for a specific tab (e.g. tab
        // navigated to chrome:// URL, user closed DevTools, etc.).
        const detachedParams = params as ExtensionEvents['tabDetached']['params'];
        const detachedTabId = detachedParams.tabId;
        debugLogger(`Tab ${detachedTabId} debugger detached: ${detachedParams.reason}`);
        // Notify the owning client so Playwright tears down its Page.
        for (const c of this._clients.values()) {
          if (c.isSubscribedToTab(detachedTabId))
            c.revokeTab(detachedTabId, detachedParams.reason);
        }
        const owner = this._leases.ownerOf(detachedTabId);
        if (owner)
          this._leases.release(detachedTabId, owner.ownerClientId);
        // Tab/debuggee is gone — forget sessions and hints.
        this._forgetTab(detachedTabId);
        break;
      }
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
        // Track child sessions (iframes, workers) as they auto-attach. Subsequent
        // commands from Playwright addressed to these real sessionIds route via
        // _extSession lookup in sendToExtensionForClient.
        if (cdpParams.method === 'Target.attachedToTarget' && cdpParams.tabId !== undefined) {
          const childSid: string | undefined = cdpParams.params?.sessionId;
          if (childSid && !this._extSession.has(childSid)) {
            // Child sessions have no virtualId — Playwright uses the real id directly.
            this._extSession.set(childSid, { virtualId: childSid, tabId: cdpParams.tabId });
            daemonJsonl('session.childBind', {
              tabId: cdpParams.tabId,
              realSessionId: childSid,
              detail: {
                targetType: cdpParams.params?.targetInfo?.type,
                parentSessionId: extSid || null,
              },
            });
          }
        }
        if (cdpParams.method === 'Target.detachedFromTarget' && cdpParams.params?.sessionId) {
          const goneSid: string = cdpParams.params.sessionId;
          const entry = this._extSession.get(goneSid);
          if (entry && entry.virtualId === goneSid) {
            this._extSession.delete(goneSid);
            daemonJsonl('session.childUnbind', { tabId: entry.tabId, realSessionId: goneSid });
          }
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
    if (!pending) {
      daemonJsonl('cdp.response.orphan', { detail: { relayId: id, error } });
      return;
    }
    this._pendingCmds.delete(id);
    daemonJsonl('cdp.response.in', {
      clientId: pending.clientId,
      virtualSessionId: pending.origSessionId,
      realSessionId: pending.realSessionId,
      method: pending.method,
      dir: 'in',
      detail: { relayId: id, origId: pending.origId, error },
    });
    const client = this._clients.get(pending.clientId);
    if (!client) {
      daemonJsonl('cdp.response.orphan', { clientId: pending.clientId, detail: { reason: 'client gone', relayId: id } });
      return;
    }
    if (error) {
      client.sendRaw({ id: pending.origId, sessionId: pending.origSessionId, error: { message: error } });
    } else {
      client.sendRaw({ id: pending.origId, sessionId: pending.origSessionId, result });
    }
    daemonJsonl('cdp.response.delivered', {
      clientId: pending.clientId,
      virtualSessionId: pending.origSessionId,
      realSessionId: pending.realSessionId,
      method: pending.method,
      detail: { relayId: id, origId: pending.origId },
    });
  }

  // ------------------------------------------------------------------ Playwright

  private _handlePlaywrightConnection(ws: WebSocket, url: URL): void {
    // Client ID stability: accept a requested ID via query param so
    // reconnecting MCP processes keep the same identity for annotations.
    const requestedId = url.searchParams.get('clientId');
    let clientId: string;
    if (requestedId && !this._clients.has(requestedId)) {
      clientId = requestedId;
    } else {
      clientId = `c${++this._clientCounter}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const client = new ClientConnection(clientId, ws, this);
    this._clients.set(clientId, client);
    if (this._clients.size > this._clientsHighWater1s)
      this._clientsHighWater1s = this._clients.size;
    this.updateLifetimeClientsHighWater(this._clients.size);
    this._cancelGraceTimer();
    debugLogger(`Playwright client connected: ${clientId} (total=${this._clients.size})`);
    daemonJsonl('client.connect', { clientId, detail: { totalClients: this._clients.size } });
    // Ensure the extension is paired — launches the browser on first-ever connect.
    void this.ensureBrowserLaunched().catch(err => debugLogger(`ensureBrowserLaunched failed: ${err}`));
    ws.on('close', (code: number, reason: Buffer) => {
      if (this._clients.get(clientId) !== client)
        return;
      const released = this._leases.releaseAllFor(clientId);
      const cancelledPending = this._leases.cancelPendingFor(clientId);
      this._clients.delete(clientId);
      this.incrementClientDisconnectCount();
      // Pop the client's auto-opened blanks — these are daemon-owned tabs
      // that must not outlive the client that they were opened for.
      const autoBlanks = [...(this._autoOpenedBlanks.get(clientId) ?? [])];
      this._autoOpenedBlanks.delete(clientId);
      this.clearClientTabTargetIds(clientId);
      // NOTE: do NOT delete `_lastSwitchedTab` or `_declaredSwitchTarget` here.
      // Both are designed to survive client WS close → reconnect cycles
      // (invariant #12, #18). They are consumed / cleared on tab-gone events
      // (`_forgetTab`, `releaseTab`, `revokeTab`, `onExtensionLost`), not on
      // disconnect. Wiping them here regresses `reconnect-preserves-switch-hint`.
      debugLogger(`Playwright client disconnected: ${clientId} (released tabs: ${released.join(',')}, cancelled pending: ${cancelledPending.join(',')}, autoBlanks: ${autoBlanks.join(',')})`);
      daemonJsonl('client.disconnect', { clientId, detail: { code, releasedTabs: released, cancelledPending, autoBlanks, remaining: this._clients.size } });
      // Detach CDP from each released tab so orphan debugger attachments die
      // with the client. Fire-and-forget with a 2s cage.
      for (const tabId of released) {
        this._cleanupTabSessions(tabId);
        this._extension?.send('detachFromTab', { tabId } as any, 2_000).catch(() => {});
      }
      // Close the auto-opened blanks the daemon created for this client.
      // Detach is handled implicitly by chrome.tabs.remove; best-effort.
      for (const tabId of autoBlanks) {
        this._forgetTab(tabId);
        this._extension?.send('closeTab', { tabId } as any, 2_000).catch(() => {});
      }
      if (this._clients.size === 0 && this._extension === null)
        this._startGraceTimer();
    });
  }

  // ------------------------------------------------------------------ Helpers for ClientConnection

  leases(): LeaseTable { return this._leases; }
  extension(): ExtensionConnection | null { return this._extension; }

  /** Record which tab a client last switched to (survives reconnection). */
  setLastSwitchedTab(clientId: string, tabId: number): void { this._lastSwitchedTab.set(clientId, tabId); }

  recordClientTabTargetId(clientId: string, tabId: number, realTargetId: string): void {
    let row = this._clientTabTargetIds.get(clientId);
    if (!row) { row = new Map(); this._clientTabTargetIds.set(clientId, row); }
    row.set(tabId, realTargetId);
  }
  getClientTabTargetId(clientId: string, tabId: number): string | undefined {
    return this._clientTabTargetIds.get(clientId)?.get(tabId);
  }
  clearClientTabTargetIdsForTab(clientId: string, tabId: number): void {
    const row = this._clientTabTargetIds.get(clientId);
    if (!row) return;
    row.delete(tabId);
    if (row.size === 0)
      this._clientTabTargetIds.delete(clientId);
  }
  clearClientTabTargetIds(clientId: string): void {
    this._clientTabTargetIds.delete(clientId);
  }
  /** Consume (read + delete) the last-switched hint for a client. */
  consumeLastSwitchedTab(clientId: string): number | undefined {
    const tab = this._lastSwitchedTab.get(clientId);
    if (tab !== undefined)
      this._lastSwitchedTab.delete(clientId);
    return tab;
  }

  /** Tell the given client that a tab was taken from them. */
  revokeClientSubscription(clientId: string, tabId: number, reason: string): void {
    const c = this._clients.get(clientId);
    if (c)
      c.revokeTab(tabId, reason);
  }

  clientById(clientId: string): ClientConnection | undefined {
    return this._clients.get(clientId);
  }

  async listTabs(): Promise<TabInfo[]> {
    if (!this._extension)
      throw new Error('Extension not connected');
    return await this._extension.send('listBrowserTabs', {}, 2_000);
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
    daemonJsonl('session.bind', { tabId, virtualSessionId: virtualId, realSessionId: extSessionId });
  }

  /** Translate virtual sessionId -> extension sessionId (or undefined for top-level). */
  resolveExtSessionId(virtualId: string | undefined): string | undefined {
    if (!virtualId)
      return undefined;
    return this._virtualSession.get(virtualId)?.extSessionId;
  }

  /** Remove all session mappings for a specific tab. Called on debugger detach,
   * lease release, client disconnect, and tab close. Does NOT clear
   * `_lastSwitchedTab` — that hint must survive lease release + client
   * reconnect so `_handleSetAutoAttach` can rebind to the intended target.
   * Use `_forgetTab(tabId)` for the strict tab-closed path that owns hint teardown. */
  _cleanupTabSessions(tabId: number): void {
    // Drop any real (child) sessions bound to this tab (iframes/workers).
    for (const [sid, entry] of Array.from(this._extSession.entries())) {
      if (entry.tabId === tabId)
        this._extSession.delete(sid);
    }
    const virtualId = this._tabVirtualSession.get(tabId);
    if (virtualId) {
      this._tabVirtualSession.delete(tabId);
      this._virtualSession.delete(virtualId);
    }
  }

  /** Full teardown for a tab that is actually being closed/destroyed —
   * sessions + last-switched hints. Safe to call from `closeTab` and
   * extension `debuggee.detach` paths; do NOT call it on a transient
   * client-WS close where the tab is merely released. */
  _forgetTab(tabId: number): void {
    this._cleanupTabSessions(tabId);
    for (const [cid, tid] of this._lastSwitchedTab) {
      if (tid === tabId)
        this._lastSwitchedTab.delete(cid);
    }
    for (const [cid, tid] of this._declaredSwitchTarget) {
      if (tid === tabId)
        this._declaredSwitchTarget.delete(cid);
    }
  }

  /** Send command to extension on behalf of a client; returns relayId for response tracking. */
  sendToExtensionForClient(clientId: string, origId: number, origSessionId: string | undefined, method: string, params: any, extSessionId: string | undefined): void {
    if (!this._extension)
      throw new Error('Extension not connected');
    const relayId = this._nextRelayId++;
    // Multi-tab: include tabId so the extension routes the command to the
    // correct chrome.debugger attachment (not just the last-switched tab).
    //
    // origSessionId can be one of:
    //   (a) virtual sessionId (pw-tab-N) — maps via _virtualSession to {tabId, extSessionId}
    //   (b) real ext sessionId (iframe/worker captured from a forwarded
    //       Target.attachedToTarget event) — maps via _extSession to {tabId, virtualId}
    //   (c) undefined — top-level browser-scoped command
    let tabId: number | undefined;
    let sessionIdForExt: string | undefined;
    if (origSessionId) {
      const vmap = this._virtualSession.get(origSessionId);
      if (vmap) {
        // Case (a): virtual id → use resolved extSessionId (may be undefined
        // for the root page session pre-capture; the extension treats missing
        // sessionId as the tab's top-level session).
        tabId = vmap.tabId;
        sessionIdForExt = extSessionId;
      } else {
        const emap = this._extSession.get(origSessionId);
        if (emap) {
          // Case (b): real child session id flowing back through. Pass the id
          // to the extension as-is — chrome.debugger.sendCommand routes to
          // that child session in flat mode.
          tabId = emap.tabId;
          sessionIdForExt = origSessionId;
        } else {
          // Unknown sessionId — fall back to current behaviour.
          sessionIdForExt = extSessionId;
        }
      }
    }
    // Find the client to get its primary tab as fallback (for top-level commands).
    const fallbackTabId = tabId ?? this._clients.get(clientId)?.primaryTab() ?? undefined;
    this._pendingCmds.set(relayId, { clientId, origId, origSessionId, method, realSessionId: sessionIdForExt });
    daemonJsonl('cdp.out', {
      clientId,
      tabId: fallbackTabId,
      virtualSessionId: origSessionId,
      realSessionId: sessionIdForExt,
      method,
      dir: 'out',
      detail: { relayId, origId, resolvedVia: origSessionId ? (this._virtualSession.has(origSessionId) ? 'virtual' : (this._extSession.has(origSessionId) ? 'real' : 'unknown')) : 'none' },
    });
    this._extension.sendRaw({
      id: relayId,
      method: 'forwardCDPCommand',
      params: { tabId: fallbackTabId, sessionId: sessionIdForExt, method, params },
    });
  }

  /**
   * Dev-only orphan-blank sweep. Gated behind EARTHLING_MCP_SWEEP_ORPHANS=1
   * at the daemon entry point — this method itself does not check the env
   * flag (it's a no-op if never called). Closes stale about:blank tabs that
   * accumulate across debris-prone dev workflows (e.g. repeated failed
   * switch_tab spawning fresh blanks). Never throws.
   *
   * Safety filters — a tab is closed only if ALL of the following hold:
   *   - url is about:blank (enforced by the extension's query filter)
   *   - (now - lastAccessed) >= maxAgeMs   — not a freshly-opened tab
   *   - historyLength <= 1                 — never navigated away
   *   - _leases.ownerOf(tabId) is undefined — no MCP client holds the tab
   */
  async _sweepOrphanBlanks(maxAgeMs: number): Promise<void> {
    if (!this._extension) {
      daemonJsonl('daemon.orphan_sweep.skipped', { detail: { reason: 'no extension' } });
      return;
    }
    try {
      const resp: any = await this._extension.send('queryOrphanBlanks' as any, {}, 2_000);
      const tabs: Array<{ tabId: number; lastAccessed: number; historyLength: number }> = resp?.tabs || [];
      const now = Date.now();
      let scanned = 0;
      let closed = 0;
      for (const t of tabs) {
        scanned++;
        const age = now - (t.lastAccessed || 0);
        if (age < maxAgeMs)
          continue;
        if ((t.historyLength ?? 1) > 1)
          continue;
        if (this._leases.ownerOf(t.tabId))
          continue;
        try {
          await this._extension.send('closeTab' as any, { tabId: t.tabId }, 2_000);
          this._forgetTab(t.tabId);
          closed++;
          daemonJsonl('daemon.orphan_sweep.closed', { tabId: t.tabId, detail: { ageMs: age, historyLength: t.historyLength ?? 1 } });
        } catch (e) {
          daemonJsonl('daemon.orphan_sweep.close_fail', { tabId: t.tabId, detail: { error: String((e as any)?.message || e) } });
        }
      }
      daemonJsonl('daemon.orphan_sweep.complete', { detail: { scanned, closed } });
    } catch (e) {
      daemonJsonl('daemon.orphan_sweep.fail', { detail: { error: String((e as any)?.message || e) } });
    }
  }

  async callExtensionDirect<M extends keyof ExtensionCommand>(method: M, params: ExtensionCommand[M]['params']): Promise<any> {
    if (!this._extension)
      throw new Error('Extension not connected');
    return await this._extension.send(method, params);
  }

  private _startGraceTimer(reason: string = 'idle') {
    this._cancelGraceTimer();
    debugLogger(`Starting ${GRACE_PERIOD_MS}ms grace timer (${reason}).`);
    daemonJsonl('grace.start', { detail: { reason, graceMs: GRACE_PERIOD_MS } });
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      if (this._extension !== null) {
        debugLogger('Grace timer fired but extension already reconnected — no action');
        daemonJsonl('grace.cancel', { detail: { reason: 'extension reconnected' } });
        return;
      }
      // Grace expired with no extension. Notify clients NOW with detach so
      // Playwright tears down its page state, then drop leases + tab maps.
      debugLogger(`Grace timer expired — flushing ${this._clients.size} clients, ${this._leases.all().length} leases`);
      daemonJsonl('grace.expire', { detail: { clients: this._clients.size, leases: this._leases.all().length } });
      for (const client of this._clients.values())
        client.onExtensionLost(reason);
      this._tabVirtualSession.clear();
      this._leases.clearAll();
      this._lastSwitchedTab.clear();
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
    // Emit detach with the real Chromium targetId we recorded at attach time.
    // Playwright's `_onDetachedFromTarget` matches by real targetId; emitting
    // a synthetic `tab-${tabId}` is silently ignored, leaving the client's
    // `_crPages` carrying a closed-target entry.
    const realTargetId = this._relay.getClientTabTargetId(this.id, tabId);
    this.sendRaw({
      method: 'Target.detachedFromTarget',
      params: { sessionId: virtualId, targetId: realTargetId ?? `tab-${tabId}`, reason } as any,
    });
    this._subscribedTabs.delete(tabId);
    this._relay.clearClientTabTargetIdsForTab(this.id, tabId);
    if (this._primaryTab === tabId)
      this._primaryTab = null;
    // Peer force-switch / external revocation: the declared target is no
    // longer reachable by this client. Clear it here too, otherwise the
    // post-reconnect `_handleSetAutoAttach` mismatch check treats every
    // preemption as a regression and spams `switch_tab_target_mismatch`.
    if (this._relay._declaredSwitchTarget.get(this.id) === tabId)
      this._relay._declaredSwitchTarget.delete(this.id);
  }

  onExtensionLost(reason: string) {
    debugLogger(`[${this.id}] onExtensionLost: reason="${reason}", tabs=[${[...this._subscribedTabs].join(',')}], primary=${this._primaryTab}`);
    daemonJsonl('client.extensionLost', {
      clientId: this.id,
      detail: { reason, tabs: [...this._subscribedTabs], primary: this._primaryTab },
    });
    for (const tabId of this._subscribedTabs) {
      const virtualId = this._relay.virtualSessionForTab(tabId);
      const realTargetId = this._relay.getClientTabTargetId(this.id, tabId);
      this.sendRaw({
        method: 'Target.detachedFromTarget',
        params: { sessionId: virtualId, targetId: realTargetId ?? `tab-${tabId}` },
      });
    }
    this._relay.clearClientTabTargetIds(this.id);
    this._subscribedTabs.clear();
    this._primaryTab = null;
    // Lost extension invalidates the whole notion of a declared target on
    // this client — without this, the post-reconnect mismatch check fires on
    // every extension-loss recovery and drowns the counter's signal.
    this._relay._declaredSwitchTarget.delete(this.id);
    // Force-close the client WS so Playwright's Browser.isConnected() flips to
    // false immediately. The MCP BrowserBackend's pre-dispatch isConnected()
    // check (browserBackend.ts) then triggers transparent reconnect on the next
    // tool call — cleaner than relying on a tool-level error regex to detect
    // the disposed-page state that would otherwise result.
    this.drainAndClose(`extension lost: ${reason}`);
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
        // Unhandled browser-level command (e.g. Target.setDiscoverTargets).
        // Return empty success rather than forwarding to extension — the
        // extension's chrome.debugger is tab-scoped and can't service
        // browser-level CDP commands (would error or execute in wrong context).
        this.sendRaw({ id, sessionId, result: {} });
        return;
      }

      // Tab-scoped: forward to extension via the client's virtual session mapping.
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
        // Playwright sends Target.getTargetInfo during connectOverCDP to probe
        // the browser target. When no tab is leased yet, return synthetic
        // browser-level target info so the handshake succeeds.
        if (this._primaryTab === null)
          return { targetInfo: { targetId: 'browser', type: 'browser', title: 'Browser', url: '', attached: true } };
        const tabs = await this._relay.listTabs();
        const tab = tabs.find(t => t.tabId === this._primaryTab);
        if (!tab)
          return { targetInfo: { targetId: 'browser', type: 'browser', title: 'Browser', url: '', attached: true } };
        return {
          targetInfo: {
            targetId: tab.targetId || `tab-${tab.tabId}`,
            type: 'page',
            title: tab.title,
            url: tab.url,
            attached: true,
            browserContextId: 'default',
          },
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
        const existingOwner = this._relay.leases().ownerOf(tabId);
        const oldOwnerId = existingOwner && existingOwner.ownerClientId !== this.id ? existingOwner.ownerClientId : null;
        const oldPrimary = this._primaryTab;
        debugLogger(`[${this.id}] switchToTab: tabId=${tabId}, force=${force}, currentOwner=${existingOwner?.ownerClientId ?? 'none'}, myPrimary=${oldPrimary}`);

        if (existingOwner && existingOwner.ownerClientId !== this.id && !force)
          throw new Error(`Tab ${tabId} is leased by client ${existingOwner.ownerClientId}. Pass force:true to take over.`);

        // Phase 1: reserve. The pending entry is invisible to ownerOf/all, so
        // concurrent list_all_tabs still sees tab as held by oldOwner.
        this._relay.leases().reservePending(tabId, this.id, oldOwnerId);
        daemonJsonl('lease.pending.reserve', { clientId: this.id, tabId, detail: { oldOwner: oldOwnerId, force } });

        // Phase 2: call extension to actually attach.
        let extResult: any;
        try {
          extResult = await this._relay.callExtensionDirect('switchToTab', { tabId });
        } catch (e) {
          this._relay.leases().cancelPending(tabId);
          daemonJsonl('lease.pending.cancel', { clientId: this.id, tabId, detail: { reason: 'extension failure', error: String(e) } });
          throw e;
        }

        // If our WS closed during the await, the ws.on('close') handler
        // already cancelled this pending reservation — abort without revoking
        // oldOwner's lease.
        if (!this._relay.leases().hasPending(tabId)) {
          daemonJsonl('lease.pending.cancel', { clientId: this.id, tabId, detail: { reason: 'client disconnected during switch' } });
          throw new Error(`Switch aborted: client disconnected before commit`);
        }

        // Phase 3: commit. Notify loser BEFORE detach so the preemption event
        // lands first in ordering over the same WS. `sessionId: BROWSER_SESSION_ID`
        // is load-bearing: it routes the event to the peer's `browser.newBrowserCDPSession()`
        // where the preemption listener lives. Drop the sessionId and Playwright
        // routes to the root session — silently eaten, no listener reachable.
        if (oldOwnerId) {
          const loser = this._relay.clientById(oldOwnerId);
          if (loser) {
            loser.sendRaw({ sessionId: BROWSER_SESSION_ID, method: 'Earthling.tabPreempted', params: { tabId, revokedBy: this.id, reason: 'force-switch' } } as any);
            daemonJsonl('lease.takeover.notified', { clientId: oldOwnerId, tabId, detail: { revokedBy: this.id } });
          }
          this._relay.revokeClientSubscription(oldOwnerId, tabId, `Lease revoked by ${this.id}`);
          this._relay.leases().release(tabId, oldOwnerId);
        }

        // Release this client's previous primary (if any and distinct).
        let releasedPrior: number | null = null;
        if (oldPrimary !== null && oldPrimary !== tabId) {
          this._relay.leases().release(oldPrimary, this.id);
          this._subscribedTabs.delete(oldPrimary);
          releasedPrior = oldPrimary;
          // If the old primary was a daemon-auto-opened blank, close it now —
          // the client is switching to a real target and will never come back
          // to the transient blank. Leaving it open accumulates orphans over
          // the browser session's lifetime.
          const autoSet = this._relay._autoOpenedBlanks.get(this.id);
          if (autoSet?.has(oldPrimary)) {
            autoSet.delete(oldPrimary);
            this._relay._forgetTab(oldPrimary);
            void this._relay.callExtensionDirect('closeTab', { tabId: oldPrimary }).catch(() => {});
            daemonJsonl('autoBlank.closed.switchOff', { clientId: this.id, tabId: oldPrimary });
          }
        }

        this._relay.leases().commitPending(tabId);
        daemonJsonl('lease.pending.commit', { clientId: this.id, tabId });
        this._primaryTab = tabId;
        this._subscribedTabs.add(tabId);
        this._relay.setLastSwitchedTab(this.id, tabId);
        // Record the declared target for post-reconnect mismatch detection.
        // Unlike `_lastSwitchedTab` (consumed by Priority 1), this survives
        // the whole backend-dispose → reconnect cycle; cleared only when the
        // tab actually goes away.
        this._relay._declaredSwitchTarget.set(this.id, tabId);
        debugLogger(`[${this.id}] switchToTab: committed tab ${tabId} (released prior=${releasedPrior}, revoked from=${oldOwnerId})`);

        return { ...extResult, released: releasedPrior, revokedFrom: oldOwnerId, claimed: tabId, force };
      }
      case 'Earthling.releaseTab': {
        const tabId: number = params?.tabId;
        return await this.releaseTabWithDetach(tabId);
      }
      case 'Earthling.bindTab': {
        // Idempotent attach for the per-tab page pool. The MCP backend calls
        // this when its `Context._tabsByTabId` does NOT yet have a Page for
        // the requested tab (initial bind, or a tab the client has not
        // previously visited). Returns `{alreadyBound: true}` when this client
        // already holds a CRPage for the tab — re-emitting attach in that
        // case would trip Playwright's `assert(!this._crPages.has(...))`.
        const tabId: number = params?.tabId;
        if (typeof tabId !== 'number')
          throw new Error(`Earthling.bindTab: tabId required`);
        const owner = this._relay.leases().ownerOf(tabId);
        if (!owner || owner.ownerClientId !== this.id)
          throw new Error(`Earthling.bindTab: client ${this.id} does not own tab ${tabId}`);
        const existing = this._relay.getClientTabTargetId(this.id, tabId);
        if (existing) {
          daemonJsonl('session.bindTab', { clientId: this.id, tabId, detail: { alreadyBound: true, realTargetId: existing } });
          return { alreadyBound: true, targetId: existing };
        }
        const attachResult = await this._relay.callExtensionDirect('attachToTab', { tabId } as any);
        const targetInfo = attachResult?.targetInfo;
        const extSessionId: string | undefined = attachResult?.sessionId;
        const realTargetId: string | undefined = targetInfo?.targetId;
        if (!realTargetId)
          throw new Error(`Earthling.bindTab: extension returned no targetId for tab ${tabId}`);
        const virtualId = this._relay.virtualSessionForTab(tabId);
        if (extSessionId)
          this._relay.bindExtSession(extSessionId, virtualId, tabId);
        this._subscribedTabs.add(tabId);
        this._relay.recordClientTabTargetId(this.id, tabId, realTargetId);
        daemonJsonl('session.bindTab', {
          clientId: this.id,
          tabId,
          virtualSessionId: virtualId,
          realSessionId: extSessionId,
          detail: { alreadyBound: false, realTargetId },
        });
        this.sendRaw({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: virtualId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        });
        return { alreadyBound: false, targetId: realTargetId };
      }
      case 'Earthling.openTab':
        return await this._relay.callExtensionDirect('openTab', params || {});
      case 'Earthling.closeTab': {
        const tabId: number = params?.tabId;
        const owner = this._relay.leases().ownerOf(tabId);
        debugLogger(`[${this.id}] closeTab: tabId=${tabId}, owner=${owner?.ownerClientId ?? 'none'}, myPrimary=${this._primaryTab}`);
        this.releaseTab(tabId);
        // Revoke any other client's lease on the closed tab to prevent orphans.
        const remainingOwner = this._relay.leases().ownerOf(tabId);
        if (remainingOwner) {
          this._relay.revokeClientSubscription(remainingOwner.ownerClientId, tabId, 'Tab closed');
          this._relay.leases().release(tabId, remainingOwner.ownerClientId);
        }
        this._relay._forgetTab(tabId);
        const result = await this._relay.callExtensionDirect('closeTab', { tabId });
        debugLogger(`[${this.id}] closeTab: tab ${tabId} closed successfully`);
        return result;
      }
      case 'Earthling.whoAmI':
        return { clientId: this.id, primaryTab: this._primaryTab };
      case 'Earthling.getDebugLog':
        return await this._relay.callExtensionDirect('getDebugLog', {});
      case 'Earthling.queryOrphanBlanks':
        return await this._relay.callExtensionDirect('queryOrphanBlanks', {});
    }
    return undefined;
  }

  private async _handleSetAutoAttach(): Promise<void> {
    // If already leased a tab, re-emit attachedToTarget for it.
    let tabId = this._primaryTab;
    if (tabId !== null) {
      debugLogger(`[${this.id}] setAutoAttach: re-emitting for existing primary tab ${tabId}`);
    }
    if (tabId === null) {
      const tabs = await this._relay.listTabs();
      debugLogger(`[${this.id}] setAutoAttach: finding tab (${tabs.length} browser tabs, leases=${this._relay.leases().all().length})`);
      const hintTab = this._relay.consumeLastSwitchedTab(this.id);
      let hintMissed = false;

      // Priority 1: hint present AND visible in live tab list.
      // Invariant #21: non-force claim. If tab is owned by another client, skip the
      // hint rather than silently transfer — caller must explicitly switch with force:true.
      if (hintTab !== undefined && tabs.some((t: any) => t.tabId === hintTab)) {
        const claim = this._relay.leases().claim(hintTab, this.id, false);
        if (claim.ok) {
          tabId = hintTab;
          debugLogger(`[${this.id}] setAutoAttach: leased hint tab ${tabId}`);
        }
      }

      // Priority 2: hint present but missing from live list. Try a direct
      // extension attach — listTabs() may have returned a stale snapshot
      // mid-navigation. Closes the switch_tab target-creation race where a
      // transient listTabs() miss caused the client to silently land on a
      // freshly-spawned about:blank instead of the requested target.
      if (tabId === null && hintTab !== undefined) {
        try {
          const direct = await this._relay.callExtensionDirect('attachToTab', { tabId: hintTab });
          if (direct && direct.targetInfo) {
            const claim = this._relay.leases().claim(hintTab, this.id, false);
            if (claim.ok) {
              tabId = hintTab;
              debugLogger(`[${this.id}] setAutoAttach: direct-attached hint tab ${tabId} (missed by listTabs)`);
              daemonJsonl('session.autoAttach.hint.directAttach', { clientId: this.id, tabId: hintTab });
              this._relay.incrementHintDirectAttach();
            }
          }
        } catch (e) {
          hintMissed = true;
          daemonJsonl('session.autoAttach.hint.missed', { clientId: this.id, tabId: hintTab, detail: { error: String((e as any)?.message || e) } });
          this._relay.incrementHintMissed();
        }
        if (tabId === null)
          hintMissed = true;
      }

      // Priority 3: no hint (or hint recovery failed) — open a fresh blank.
      if (tabId === null) {
        debugLogger(`[${this.id}] setAutoAttach: opening blank tab (hintMissed=${hintMissed})`);
        const newTab = await this._relay.callExtensionDirect('openTab', { url: 'about:blank' });
        tabId = newTab.tabId as number;
        const claim = this._relay.leases().claim(tabId, this.id, false);
        if (!claim.ok)
          throw new Error(`Failed to claim newly opened tab ${tabId}`);
        // Track as daemon-owned so it gets closed on client-disconnect /
        // switch-off rather than leaking to the user's browser.
        let set = this._relay._autoOpenedBlanks.get(this.id);
        if (!set) { set = new Set(); this._relay._autoOpenedBlanks.set(this.id, set); }
        set.add(tabId);
        debugLogger(`[${this.id}] setAutoAttach: opened and leased blank tab ${tabId}`);
        if (hintMissed) {
          daemonJsonl('session.autoAttach.hint.fallbackBlank', { clientId: this.id, tabId, detail: { originalHint: hintTab } });
          this._relay.incrementHintFallbackBlank();
        }
      }
      this._primaryTab = tabId;
    }
    const activeTabId: number = tabId;
    this._subscribedTabs.add(activeTabId);

    // Attach via extension (binds the extension sessionId for this tab if not already).
    const attachResult = await this._relay.callExtensionDirect('attachToTab', { tabId: activeTabId } as any);
    const targetInfo = attachResult?.targetInfo;
    const extSessionId: string | undefined = attachResult?.sessionId;
    const virtualId = this._relay.virtualSessionForTab(activeTabId);
    daemonJsonl('session.autoAttach.extAttach', {
      clientId: this.id,
      tabId: activeTabId,
      virtualSessionId: virtualId,
      realSessionId: extSessionId,
      detail: { hasSessionId: !!extSessionId },
    });
    if (extSessionId)
      this._relay.bindExtSession(extSessionId, virtualId, activeTabId);
    if (targetInfo?.targetId)
      this._relay.recordClientTabTargetId(this.id, activeTabId, targetInfo.targetId);
    daemonJsonl('session.autoAttach.emit', {
      clientId: this.id,
      tabId: activeTabId,
      virtualSessionId: virtualId,
      realSessionId: extSessionId,
    });

    this.sendRaw({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: virtualId,
        targetInfo: { ...targetInfo, attached: true },
        waitingForDebugger: false,
      },
    });

    // Defensive mismatch check — if this client had a declared switch target
    // surviving the reconnect cycle and we landed on a different tab, bump
    // the counter so the class of bug that caused Scenario 1 shows up in
    // /health without needing a Terra session to catch. We do NOT clear
    // `_declaredSwitchTarget` here: multiple reconnect cycles against the
    // same declared target each landing wrong should each bump.
    const declared = this._relay._declaredSwitchTarget.get(this.id);
    if (declared !== undefined && declared !== activeTabId) {
      daemonJsonl('session.autoAttach.target.mismatch', {
        clientId: this.id,
        tabId: activeTabId,
        detail: { declaredTarget: declared, actualTarget: activeTabId },
      });
      this._relay.incrementSwitchTabTargetMismatch();
    }
  }

  releaseTab(tabId: number): boolean {
    const ok = this._relay.leases().release(tabId, this.id);
    if (ok) {
      this._subscribedTabs.delete(tabId);
      if (this._primaryTab === tabId)
        this._primaryTab = null;
      // If this client's declared target was the released tab, drop the
      // defensive tracker too — otherwise a subsequent reconnect that lands
      // on a fresh blank would look like a mismatch when the client
      // voluntarily gave up the tab.
      if (this._relay._declaredSwitchTarget.get(this.id) === tabId)
        this._relay._declaredSwitchTarget.delete(this.id);
      // If this was a daemon-auto-opened blank, close it — same rationale
      // as the switch-off path in `Earthling.switchToTab`.
      const autoSet = this._relay._autoOpenedBlanks.get(this.id);
      if (autoSet?.has(tabId)) {
        autoSet.delete(tabId);
        this._relay._forgetTab(tabId);
        void this._relay.callExtensionDirect('closeTab', { tabId }).catch(() => {});
        daemonJsonl('autoBlank.closed.release', { clientId: this.id, tabId });
      }
    }
    return ok;
  }

  async releaseTabWithDetach(tabId: number): Promise<{ released: boolean; detached: boolean }> {
    const released = this.releaseTab(tabId);
    if (!released)
      return { released: false, detached: false };
    this._relay._cleanupTabSessions(tabId);
    let detached = false;
    let detachError: string | undefined;
    try {
      await this._relay.extension()?.send('detachFromTab', { tabId } as any, 2_000);
      detached = true;
    } catch (e) {
      detachError = e instanceof Error ? e.message : String(e);
    }
    daemonJsonl('ext.detach.on-release', { clientId: this.id, tabId, detail: { detached, error: detachError } });
    return { released: true, detached };
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

/**
 * Per-method timeout budgets (ms) for ExtensionConnection.send(). These are
 * the daemon→extension WebSocket calls; Earthling.* pseudo-CDP calls from
 * MCP clients (earthlingTabs.ts) go through relaySend() and are capped
 * separately on the client side with withTimeoutMarker.
 *
 *   listBrowserTabs     : 2_000   (local list in extension)
 *   attachToTab         : 5_000   (debugger.attach can block briefly)
 *   <forwardCDPCommand> : per-call (not routed through send())
 *   default             : 10_000
 */
export class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, { resolve: (o: any) => void; reject: (e: Error) => void; error: Error; timer?: NodeJS.Timeout }>();
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

  /** Typed send with locally-tracked response and per-method timeout budget. */
  async send<M extends keyof ExtensionCommand>(method: M, params: ExtensionCommand[M]['params'], timeoutMs: number = 10_000): Promise<any> {
    if (this._ws.readyState !== ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId + 1_000_000_000; // separate id space from relay-forwarded commands
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._callbacks.has(id)) {
          this._callbacks.delete(id);
          reject(new Error(`Relay CDP command ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof (timer as any).unref === 'function')
        (timer as any).unref();
      this._callbacks.set(id, { resolve, reject, error, timer });
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
        if (cb.timer)
          clearTimeout(cb.timer);
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
    for (const cb of this._callbacks.values()) {
      if (cb.timer)
        clearTimeout(cb.timer);
      cb.reject(new Error('WebSocket closed'));
    }
    this._callbacks.clear();
  }
}

// Earthling: standalone uuid generator (crypto.randomUUID available on Node 18+).
function cryptoRandomUUID(): string {
  return randomUUID();
}

