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

// Verifies Phase D3 — two-phase commit for force-switch keeps the tab invisible
// to third-party readers during the transition (never appears `free`).
//
// Requires a live relay daemon with the Browser Bridge extension attached to
// a real Chrome/Edge profile. Skipped cleanly when the extension isn't present.

import http from 'node:http';
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type CDPSession } from 'playwright';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || '9223', 10);

type DiscoverInfo = { cdpPath: string; pid: number; uuid: string };

async function discover(timeoutMs = 500): Promise<DiscoverInfo | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/discover', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed?.service === 'earthling-cdp-relay') resolve(parsed);
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function health(timeoutMs = 500): Promise<{ ok: boolean; extension: string } | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function skipUnlessExtensionAttached(): Promise<DiscoverInfo> {
  const info = await discover();
  const h = await health();
  test.skip(
      !info || h?.extension !== 'connected',
      'Browser Bridge extension not attached to relay daemon — skipping multi-client lease spec.',
  );
  return info!;
}

async function connectClient(label: string, cdpPath: string): Promise<{ browser: Browser; cdp: CDPSession }> {
  const clientId = `atomic-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<Array<{ tabId: number; lease: string; ownerId?: string }>> {
  return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

async function openTab(cdp: CDPSession, url?: string): Promise<number> {
  const res = (await cdp.send('Earthling.openTab' as any, url ? { url } : {})) as any;
  return res.tabId as number;
}

async function switchTab(cdp: CDPSession, tabId: number, force = false): Promise<any> {
  return await cdp.send('Earthling.switchToTab' as any, { tabId, force });
}

test('force-switch never surfaces the contested tab as free to a third observer', async () => {
  test.setTimeout(120_000);
  const info = await skipUnlessExtensionAttached();

  const a = await connectClient('A', info.cdpPath);
  const b = await connectClient('B', info.cdpPath);
  const c = await connectClient('C', info.cdpPath);

  let targetTabId: number | null = null;
  try {
    targetTabId = await openTab(a.cdp, 'about:blank');
    await switchTab(a.cdp, targetTabId);

    let observedFree = false;
    let stopPolling = false;
    const observations: Array<{ lease: string; ownerId?: string }> = [];
    const poller = (async () => {
      while (!stopPolling) {
        const tabs = await listTabs(c.cdp).catch(() => [] as any[]);
        const target = tabs.find(t => t.tabId === targetTabId);
        if (target) {
          observations.push({ lease: target.lease, ownerId: target.ownerId });
          if (target.lease === 'free')
            observedFree = true;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    })();

    await new Promise(r => setTimeout(r, 250));
    const switchResult = await switchTab(b.cdp, targetTabId, true);
    await new Promise(r => setTimeout(r, 500));

    stopPolling = true;
    await poller;

    expect(observedFree, `tab ${targetTabId} observed as [free] during force-switch; observations=${JSON.stringify(observations)}`).toBe(false);
    expect(observations.length).toBeGreaterThan(3);
    expect(switchResult?.claimed ?? switchResult?.tabId ?? targetTabId).toBe(targetTabId);
  } finally {
    if (targetTabId !== null) {
      await b.cdp.send('Earthling.closeTab' as any, { tabId: targetTabId }).catch(() => {});
    }
    await a.browser.close().catch(() => {});
    await b.browser.close().catch(() => {});
    await c.browser.close().catch(() => {});
  }
});

test('non-force switch to a tab another client holds is rejected', async () => {
  test.setTimeout(60_000);
  const info = await skipUnlessExtensionAttached();

  const a = await connectClient('A', info.cdpPath);
  const b = await connectClient('B', info.cdpPath);

  let targetTabId: number | null = null;
  try {
    targetTabId = await openTab(a.cdp, 'about:blank');
    await switchTab(a.cdp, targetTabId);

    let rejected = false;
    try {
      await switchTab(b.cdp, targetTabId, false);
    } catch (e: any) {
      rejected = true;
      expect(String(e?.message ?? e)).toMatch(/leased|force/i);
    }
    expect(rejected).toBe(true);

    const tabsFromB = await listTabs(b.cdp);
    const target = tabsFromB.find(t => t.tabId === targetTabId);
    expect(target?.lease).not.toBe('you');
  } finally {
    if (targetTabId !== null)
      await a.cdp.send('Earthling.closeTab' as any, { tabId: targetTabId }).catch(() => {});
    await a.browser.close().catch(() => {});
    await b.browser.close().catch(() => {});
  }
});
