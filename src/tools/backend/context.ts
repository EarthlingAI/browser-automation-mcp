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

import fs from 'fs';
import path from 'path';

import { debug } from '../../utilsBundle';
import { escapeWithQuotes } from '../../utils/isomorphic/stringUtils';
import { selectors } from 'playwright-core';

import { Tab } from './tab';
import { safeDetach } from './utils';
import { disposeAll } from '../../server/utils/disposable';
import { eventsHelper } from '../../server/utils/eventsHelper';

import type * as playwright from 'playwright-core';
import type { SessionLog } from './sessionLog';
import type { Disposable } from '../../server/utils/disposable';
import type { ToolCapability } from './tool';

const testDebug = debug('pw:mcp:test');

const MAX_PENDING_EVENTS = 50;

export type ContextConfig = {
  allowUnrestrictedFileAccess?: boolean;
  capabilities?: ToolCapability[];
  codegen?: 'typescript' | 'none';
  console?: { level?: 'error' | 'warning' | 'info' | 'debug' };
  imageResponses?: 'allow' | 'omit';
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  outputDir?: string;
  outputMode?: 'file' | 'stdout';
  saveSession?: boolean;
  saveTrace?: boolean;
  secrets?: Record<string, string>;
  snapshot?: {
    mode?: 'incremental' | 'full' | 'none';
  };
  testIdAttribute?: string;
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
  };
  browser?: {
    initScript?: string[];
    initPage?: string[];
  };
  skillMode?: boolean;
};

type ContextOptions = {
  config: ContextConfig;
  sessionLog?: SessionLog;
  cwd: string;
};

export type RouteEntry = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  handler: (route: playwright.Route) => Promise<void>;
};

export type FilenameTemplate = {
  prefix: string;
  ext: string;
  suggestedFilename?: string;
  date?: Date;
};

type VideoParams = NonNullable<Parameters<playwright.Video['start']>[0]>;

export class Context {
  readonly config: ContextConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _rawBrowserContext: playwright.BrowserContext;
  private _browserContextPromise: Promise<playwright.BrowserContext> | undefined;
  private _tabsByTabId = new Map<number, Tab>();
  private _currentTabId: number | null = null;
  private _pendingBindTabId: number | null = null;
  private _initialPagePooledPromise: Promise<void> | undefined;
  private _routes: RouteEntry[] = [];
  private _video: {
    allVideos: Set<playwright.Video>;
    params: VideoParams;
  } | undefined;
  private _disposables: Disposable[] = [];

  private _runningToolName: string | undefined;
  private _pendingEvents: string[] = [];
  private _droppedPendingEvents: number = 0;
  private _preemptionCdp: playwright.CDPSession | undefined;

  constructor(browserContext: playwright.BrowserContext, options: ContextOptions) {
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.options = options;
    this._rawBrowserContext = browserContext;
    testDebug('create context');
  }

  async dispose() {
    await disposeAll(this._disposables);
    for (const tab of this._tabsByTabId.values())
      await tab.dispose();
    this._tabsByTabId.clear();
    this._currentTabId = null;
    await this.stopVideoRecording();
  }

  addPendingEvent(msg: string): void {
    if (this._pendingEvents.length >= MAX_PENDING_EVENTS) {
      this._pendingEvents.shift();
      this._droppedPendingEvents++;
    }
    this._pendingEvents.push(msg);
  }

  drainPendingEvents(): string[] {
    const out = this._pendingEvents;
    this._pendingEvents = [];
    if (this._droppedPendingEvents > 0) {
      out.unshift(`… ${this._droppedPendingEvents} earlier events dropped`);
      this._droppedPendingEvents = 0;
    }
    return out;
  }

  tabs(): Tab[] {
    return Array.from(this._tabsByTabId.values());
  }

  currentTab(): Tab | undefined {
    return this._currentTabId !== null ? this._tabsByTabId.get(this._currentTabId) : undefined;
  }

  currentTabOrDie(): Tab {
    const tab = this.currentTab();
    if (!tab)
      throw new Error('No open pages available.');
    return tab;
  }

  async newTab(): Promise<Tab> {
    const browserContext = await this.ensureBrowserContext();
    await browserContext.newPage();
    const tab = this.currentTab();
    if (!tab)
      throw new Error('newTab: page event did not produce a pool entry');
    return tab;
  }

  async selectTab(index: number) {
    const tab = this.tabs()[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    await tab.page.bringToFront();
    this._currentTabId = tab.tabId;
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    const browserContext = await this.ensureBrowserContext();
    await this._ensureInitialPagePooled();
    if (!this.currentTab())
      await browserContext.newPage();
    return this.currentTabOrDie();
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this.currentTab() : this.tabs()[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  /**
   * Per-tab Page pool entry point. Routes to an existing pool entry if we
   * already hold a Page for this tabId; otherwise issues `Earthling.bindTab`
   * to the daemon and awaits the resulting BrowserContext 'page' event.
   *
   * The caller (earthlingTabs.switchTab.handle) is responsible for issuing
   * `Earthling.switchToTab` first to claim the lease — this method only
   * handles bindTab + pool routing.
   */
  async acquireTab(tabId: number, _force: boolean): Promise<Tab> {
    await this._ensureInitialPagePooled();
    if (this._tabsByTabId.has(tabId)) {
      this._currentTabId = tabId;
      return this._tabsByTabId.get(tabId)!;
    }
    const browserContext = await this.ensureBrowserContext();
    const browser = browserContext.browser();
    if (!browser)
      throw new Error('No browser available for bindTab');
    this._pendingBindTabId = tabId;
    // Always clear the pending slot on any exit path. Without this, a 5s
    // timeout (or a cdp.send rejection) leaves _pendingBindTabId set to the
    // failed tabId — the next stray BrowserContext 'page' event would adopt
    // the wrong Page under it, and a retried acquireTab(otherTabId) would
    // overwrite the slot mid-flight, cross-wiring the late-arriving Page.
    try {
      const pageEvent = new Promise<playwright.Page>((resolve, reject) => {
        const onPage = (p: playwright.Page) => { browserContext.off('page', onPage); resolve(p); };
        browserContext.on('page', onPage);
        setTimeout(() => { browserContext.off('page', onPage); reject(new Error(`bindTab(${tabId}) timed out waiting for Page`)); }, 5_000);
      });
      const cdp = await browser.newBrowserCDPSession();
      try {
        await cdp.send('Earthling.bindTab' as any, { tabId });
      } finally {
        void safeDetach(cdp, 500);
      }
      await pageEvent;
      this._currentTabId = tabId;
      const tab = this._tabsByTabId.get(tabId);
      if (!tab)
        throw new Error(`bindTab(${tabId}): page event fired but pool entry missing`);
      return tab;
    } finally {
      if (this._pendingBindTabId === tabId)
        this._pendingBindTabId = null;
    }
  }

  private _evictTab(tabId: number): void {
    this._tabsByTabId.delete(tabId);
    if (this._currentTabId === tabId)
      this._currentTabId = null;
  }

  /**
   * Adopt the auto-attached page from `connectOverCDP` into the pool under
   * its true tabId. Idempotent and lazy — fired from `acquireTab` / `ensureTab`
   * on the first call.
   *
   * Uses `Earthling.whoAmI.attachedTabId` (set ONCE by the daemon at auto-attach
   * time and cleared only when that tab goes away). Falls back to `primaryTab`
   * for backward compatibility with older daemons that don't report
   * `attachedTabId`.
   *
   * The `attachedTabId` distinction matters because `acquireTab` is reachable
   * from `switchTab.handle` AFTER `Earthling.switchToTab` has already moved
   * the daemon's `_primaryTab` to the destination — using `primaryTab` then
   * pools the still-alive auto-attached Page under the destination tabId,
   * which makes `_tabsByTabId.has(destination)` return true and bypasses
   * the bindTab path. Subsequent `Page.navigate` then carries the
   * auto-attached page's cached mainFrameId to the destination's chrome
   * target, which answers "No frame with given id found" because that
   * frame belongs to a closed target.
   *
   * If the daemon reports `attachedTabId === null` (e.g. the auto-attached
   * tab was already closed by the time this runs), we skip pooling — the
   * caller's bindTab path will handle the destination cleanly.
   */
  private _ensureInitialPagePooled(): Promise<void> {
    if (this._initialPagePooledPromise)
      return this._initialPagePooledPromise;
    this._initialPagePooledPromise = (async () => {
      const browserContext = await this.ensureBrowserContext();
      // If a page already landed in the pool (e.g. via _onPageCreated with
      // a pending bind), we're done.
      if (this._tabsByTabId.size > 0)
        return;
      const browser = browserContext.browser();
      if (!browser)
        return;
      let attachedTabId: number | null = null;
      try {
        const cdp = await browser.newBrowserCDPSession();
        try {
          const res: any = await cdp.send('Earthling.whoAmI' as any, {});
          if (res && typeof res.attachedTabId === 'number')
            attachedTabId = res.attachedTabId;
          else if (res && typeof res.primaryTab === 'number')
            attachedTabId = res.primaryTab;
        } finally {
          void safeDetach(cdp, 500);
        }
      } catch {
        return;
      }
      if (attachedTabId === null)
        return;
      // The auto-attached page is already in BrowserContext.pages() — adopt it
      // by re-running _onPageCreated with the discovered tabId.
      const pages = browserContext.pages();
      if (pages.length === 0)
        return;
      const page = pages[0];
      if (Tab.forPage(page))
        return; // already pooled
      this._pendingBindTabId = attachedTabId;
      this._onPageCreated(page);
    })();
    return this._initialPagePooledPromise;
  }

  async workspaceFile(fileName: string, perCallWorkspaceDir: string | undefined): Promise<string> {
    return await workspaceFile(this.options, fileName, perCallWorkspaceDir);
  }

  async outputFile(template: FilenameTemplate, options: { origin: 'code' | 'llm' }): Promise<string> {
    const baseName = template.suggestedFilename || `${template.prefix}-${(template.date ?? new Date()).toISOString().replace(/[:.]/g, '-')}${template.ext ? '.' + template.ext : ''}`;
    return await outputFile(this.options, baseName, options);
  }

  async startVideoRecording(params: VideoParams) {
    if (this._video)
      throw new Error('Video recording has already been started.');
    this._video = { allVideos: new Set(), params };
    const browserContext = await this.ensureBrowserContext();
    for (const page of browserContext.pages())
      await this._startPageVideo(page);
  }

  async stopVideoRecording(): Promise<playwright.Video[]> {
    if (!this._video)
      return [];
    const video = this._video;
    for (const page of this._rawBrowserContext.pages())
      await page.video().stop();
    this._video = undefined;
    return [...video.allVideos];
  }

  private async _startPageVideo(page: playwright.Page) {
    if (!this._video)
      return;
    this._video.allVideos.add(page.video());
    await page.video().start(this._video.params);
  }

  private _onPageCreated(page: playwright.Page) {
    // Determine the Earthling tabId for this Page. Priority:
    //   1. _pendingBindTabId — set by acquireTab() / _ensureInitialPagePooled()
    //      just before triggering an event that produces a 'page' event.
    //   2. Otherwise: skip pooling. The daemon attaches Pages only via bindTab
    //      (post-Phase 2), so any 'page' event without a pending bind is a
    //      Playwright-internal artifact (e.g. about:blank during connect).
    //      We'll adopt it lazily via _ensureInitialPagePooled() once whoAmI
    //      tells us its tabId.
    const tabId = this._pendingBindTabId;
    if (tabId === null)
      return;
    this._pendingBindTabId = null;
    if (this._tabsByTabId.has(tabId))
      return; // already pooled — defensive
    const tab = new Tab(this, tabId, page, t => this._onPageClosed(t));
    this._tabsByTabId.set(tabId, tab);
    if (this._currentTabId === null)
      this._currentTabId = tabId;
    this._startPageVideo(page).catch(() => {});
  }

  private _onPageClosed(tab: Tab) {
    this._evictTab(tab.tabId);
  }

  routes(): RouteEntry[] {
    return this._routes;
  }

  async addRoute(entry: RouteEntry): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await browserContext.route(entry.pattern, entry.handler);
    this._routes.push(entry);
  }

  async removeRoute(pattern?: string): Promise<number> {
    let removed = 0;
    const browserContext = await this.ensureBrowserContext();
    if (pattern) {
      const toRemove = this._routes.filter(r => r.pattern === pattern);
      for (const route of toRemove)
        await browserContext.unroute(route.pattern, route.handler);
      this._routes = this._routes.filter(r => r.pattern !== pattern);
      removed = toRemove.length;
    } else {
      for (const route of this._routes)
        await browserContext.unroute(route.pattern, route.handler);
      removed = this._routes.length;
      this._routes = [];
    }
    return removed;
  }

  isRunningTool() {
    return this._runningToolName !== undefined;
  }

  setRunningTool(name: string | undefined) {
    this._runningToolName = name;
  }

  private async _setupRequestInterception(context: playwright.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      this._disposables.push(await context.route('**', route => route.abort('blockedbyclient')));

      for (const origin of this.config.network.allowedOrigins) {
        const glob = originOrHostGlob(origin);
        this._disposables.push(await context.route(glob, route => route.continue()));
      }
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        this._disposables.push(await context.route(originOrHostGlob(origin), route => route.abort('blockedbyclient')));
    }
  }

  async ensureBrowserContext(): Promise<playwright.BrowserContext> {
    if (this._browserContextPromise)
      return this._browserContextPromise;
    this._browserContextPromise = this._initializeBrowserContext();
    return this._browserContextPromise;
  }

  private async _initializeBrowserContext() {
    if (this.config.testIdAttribute)
      selectors.setTestIdAttribute(this.config.testIdAttribute);
    const browserContext = this._rawBrowserContext;
    await this._setupRequestInterception(browserContext);

    if (this.config.saveTrace) {
      await browserContext.tracing.start({
        name: 'trace-' + Date.now(),
        screenshots: true,
        snapshots: true,
        live: true,
      });
      this._disposables.push({
        dispose: async () => {
          await browserContext.tracing.stop();
        },
      });
    }
    for (const initScript of this.config.browser?.initScript || [])
      this._disposables.push(await browserContext.addInitScript({ path: path.resolve(this.options.cwd, initScript) }));

    for (const page of browserContext.pages())
      this._onPageCreated(page);
    this._disposables.push(eventsHelper.addEventListener(browserContext, 'page', page => this._onPageCreated(page)));

    // Listen for lease-preemption events from the relay daemon on a persistent
    // browser-level CDP session. Best-effort: if the browser disconnects
    // mid-attach we silently skip — the tool layer handles transparent reconnect.
    const browser = browserContext.browser();
    if (browser) {
      try {
        const cdp = await browser.newBrowserCDPSession();
        this._preemptionCdp = cdp;
        cdp.on('Earthling.tabPreempted' as any, (params: any) => {
          const msg = `Your lease on tab ${params?.tabId} was preempted by client ${params?.revokedBy} (reason: ${params?.reason ?? 'unknown'}).`;
          this.addPendingEvent(msg);
          // The pooled Page's frame state goes stale once the new owner navigates
          // this tab — evict so the next acquireTab(tabId) flows through a fresh
          // Earthling.bindTab and a new Page with a valid frame. Without this,
          // a re-claim returns the orphan Page; snapshot/navigate then throw
          // "No frame with given id" / "Cannot find context" until session reload.
          if (typeof params?.tabId === 'number')
            this._evictTab(params.tabId);
        });
        // Terminal path: fire-and-forget safeDetach covers the Phase-3 atomic
        // tab-switch case where the browser-level target is swapped under us
        // and detach() would await an invalidated handshake forever.
        this._disposables.push({
          dispose: async () => {
            const pending = this._preemptionCdp;
            this._preemptionCdp = undefined;
            void safeDetach(pending, 500);
          },
        });
        // Fast path: eagerly drop our reference on browser-disconnect
        // (extension-lost / browser-killed / daemon-respawn). Complements
        // the terminal disposable path above.
        browser.on('disconnected', () => { this._preemptionCdp = undefined; });
      } catch {
        /* best-effort */
      }
    }

    return browserContext;
  }

  checkUrlAllowed(url: string) {
    if (this.config.allowUnrestrictedFileAccess)
      return;
    if (!URL.canParse(url))
      return;
    if (new URL(url).protocol === 'file:')
      throw new Error(`Access to "file:" protocol is blocked. Attempted URL: "${url}"`);
  }

  lookupSecret(secretName: string): { value: string, code: string } {
    if (!this.config.secrets?.[secretName])
      return { value: secretName, code: escapeWithQuotes(secretName, '\'') };
    return {
      value: this.config.secrets[secretName]!,
      code: `process.env['${secretName}']`,
    };
  }
}

function originOrHostGlob(originOrHost: string) {
  // Support wildcard port patterns like "http://localhost:*" or "https://example.com:*"
  const wildcardPortMatch = originOrHost.match(/^(https?:\/\/[^/:]+):\*$/);
  if (wildcardPortMatch)
    return `${wildcardPortMatch[1]}:*/**`;

  try {
    const url = new URL(originOrHost);
    // localhost:1234 will parse as protocol 'localhost:' and 'null' origin.
    if (url.origin !== 'null')
      return `${url.origin}/**`;
  } catch {
  }
  // Support for legacy host-only mode.
  return `*://${originOrHost}/**`;
}

export async function workspaceFile(options: ContextOptions, fileName: string, perCallWorkspaceDir?: string): Promise<string> {
  const workspace = perCallWorkspaceDir ?? options.cwd;
  const resolvedName = path.resolve(workspace, fileName);
  await checkFile(options, resolvedName, { origin: 'llm' });
  return resolvedName;
}

export function outputDir(options: ContextOptions): string {
  if (options.config.outputDir)
    return path.resolve(options.config.outputDir);
  return path.resolve(options.cwd, options.config.skillMode ? '.playwright-cli' : '.playwright-mcp');
}

export async function outputFile(options: ContextOptions, fileName: string, flags: { origin: 'code' | 'llm' }): Promise<string> {
  const resolvedFile = path.resolve(outputDir(options), fileName);
  await checkFile(options, resolvedFile, flags);
  await fs.promises.mkdir(path.dirname(resolvedFile), { recursive: true });
  debug('pw:mcp:file')(resolvedFile);
  return resolvedFile;
}

async function checkFile(options: ContextOptions, resolvedFilename: string, flags: { origin: 'code' | 'llm' }) {
  // Trust code and unrestricted file access.
  if (flags.origin === 'code' || options.config.allowUnrestrictedFileAccess)
    return;

  // Trust llm to use valid characters in file names.
  const output = outputDir(options);
  const workspace = options.cwd;
  if (!resolvedFilename.startsWith(output) && !resolvedFilename.startsWith(workspace))
    throw new Error(`File access denied: ${resolvedFilename} is outside allowed roots. Allowed roots: ${output}, ${workspace}`);
}
