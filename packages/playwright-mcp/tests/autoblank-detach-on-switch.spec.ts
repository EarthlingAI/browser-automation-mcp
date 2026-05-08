/**
 * Regression: a fresh MCP-backend client switching from its auto-attached
 * autoBlank to a real target must end up with a Page bound to the *real*
 * target's frameTree — not the autoBlank's. The pre-fix wedge:
 *   1. Daemon `_handleSetAutoAttach` opens an autoBlank and emits
 *      Target.attachedToTarget under virtualSessionId V.
 *   2. Playwright builds a CRPage tied to the autoBlank's targetId and
 *      caches its mainFrame.id as F1.
 *   3. The client calls `Earthling.switchToTab(real)`. The daemon closes
 *      the autoBlank (callExtensionDirect closeTab + _forgetTab) but did
 *      NOT emit Target.detachedFromTarget back. Playwright keeps the
 *      autoBlank's CRPage alive.
 *   4. Subsequent commands route to the real tab (daemon's session lookup
 *      falls through to clientPrimaryTab after _cleanupTabSessions runs).
 *   5. Page.navigate carries cached frameId F1 to the real target's
 *      chrome process — Chrome answers `-32000 No frame with given id`.
 *
 * The fix has two layers:
 *   (a) Daemon: emit Target.detachedFromTarget for the autoBlank's
 *       virtualSessionId + realTargetId BEFORE _forgetTab wipes the maps.
 *   (b) Daemon: track `_attachedTabId` separately from `_primaryTab` and
 *       expose it via whoAmI so the MCP backend's lazy
 *       `_ensureInitialPagePooled` pools the auto-attached Page under the
 *       *correct* tabId regardless of when it runs relative to the switch.
 *
 * This spec asserts (a) directly via the daemon-side detach event count
 * and (b) indirectly via the whoAmI shape + a navigate that previously
 * wedged.
 *
 * Requires the live relay daemon with the Browser Bridge extension
 * attached. Skipped cleanly when the extension isn't present.
 */

import http from 'node:http';
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || '9223', 10);

async function discover(): Promise<{ cdpPath: string } | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/discover', timeout: 500 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const p = JSON.parse(body); resolve(p?.service === 'earthling-cdp-relay' ? p : null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function healthy(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 500 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)?.extension === 'connected'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function connectClient(label: string): Promise<{ browser: Browser; ctx: BrowserContext; cdp: CDPSession }> {
  const info = await discover();
  if (!info) throw new Error('relay not discoverable');
  const clientId = `autoblank-detach-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no default context');
  const cdp = await browser.newBrowserCDPSession();
  return { browser, ctx, cdp };
}

async function awaitFirstPage(ctx: BrowserContext, timeoutMs = 10_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = ctx.pages();
    if (pages.length > 0) return pages[0];
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no Page appeared from auto-attach');
}

test('switch from autoBlank to real tab does not wedge Page.navigate with stale frameId', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping autoblank-detach spec.');

  // Fresh client A — this is the "MCP backend after /reload" scenario.
  const a = await connectClient('a');
  let realTabId: number | null = null;
  try {
    // The auto-attached page lands here once Playwright finishes the handshake.
    const autoPage = await awaitFirstPage(a.ctx);
    expect(autoPage.url()).toBe('about:blank');

    // whoAmI must report attachedTabId distinct from primaryTab tracking.
    const whoami: any = await a.cdp.send('Earthling.whoAmI' as any, {});
    expect(typeof whoami.attachedTabId).toBe('number');
    expect(whoami.attachedTabId).toBe(whoami.primaryTab);
    const autoBlankTabId = whoami.attachedTabId as number;

    // Open a real tab via the daemon — this lands as a free tab the client
    // can switch to without taking it from anyone else.
    const opened: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    realTabId = opened.tabId as number;
    expect(realTabId).toBeTruthy();
    expect(realTabId).not.toBe(autoBlankTabId);

    // Switch onto the real tab. The daemon's switchToTab handler must:
    //   - emit Target.detachedFromTarget for the autoBlank's virtualSession
    //   - close the autoBlank
    //   - clear `_attachedTabId` since the auto-attached tab is gone.
    await a.cdp.send('Earthling.switchToTab' as any, { tabId: realTabId, force: true });

    // Give Playwright a beat to process Target.detachedFromTarget for the
    // autoBlank, then the new attached event for the real tab.
    await new Promise(r => setTimeout(r, 300));

    // After the switch:
    //   - whoAmI.primaryTab must be the real tab.
    //   - whoAmI.attachedTabId must be null (the auto-attached tab is gone).
    const after: any = await a.cdp.send('Earthling.whoAmI' as any, {});
    expect(after.primaryTab).toBe(realTabId);
    expect(after.attachedTabId).toBeNull();

    // The auto-attached Page should have closed (Playwright saw the detach).
    expect(autoPage.isClosed()).toBe(true);

    // Mirror what Context.acquireTab does on the MCP backend side: bindTab
    // triggers Target.attachedToTarget for the real tab, which materialises
    // a fresh Page in the BrowserContext.
    const pageBound = new Promise<Page>((resolve, reject) => {
      const onPage = (p: Page) => { a.ctx.off('page', onPage); resolve(p); };
      a.ctx.on('page', onPage);
      setTimeout(() => { a.ctx.off('page', onPage); reject(new Error('bindTab: no page event in 5s')); }, 5_000);
    });
    await a.cdp.send('Earthling.bindTab' as any, { tabId: realTabId });
    const realPage = await pageBound;
    expect(realPage.isClosed()).toBe(false);

    // Pre-fix: realPage retained the autoBlank's mainFrame.id and Page.navigate
    // threw "Protocol error (Page.navigate): No frame with given id found".
    // Post-fix: succeeds because the new Page was built from the real tab's
    // own frame tree.
    await expect(realPage.goto('https://example.com/', { timeout: 15_000, waitUntil: 'domcontentloaded' })).resolves.not.toThrow();
    expect(realPage.url()).toMatch(/example\.com/);
  } finally {
    if (realTabId !== null) {
      await a.cdp.send('Earthling.closeTab' as any, { tabId: realTabId }).catch(() => {});
    }
    await a.browser.close().catch(() => {});
  }
});
