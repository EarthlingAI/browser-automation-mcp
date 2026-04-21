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

// Verifies Phase D2 — `Earthling.releaseTab` detaches the CDP debugger, and
// WS close also detaches lingering attachments. Requires the Browser Bridge
// extension; skipped otherwise.

import http from 'node:http';
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type CDPSession } from 'playwright';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || '9223', 10);

async function discover(): Promise<{ cdpPath: string } | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/discover', timeout: 500 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed?.service === 'earthling-cdp-relay' ? parsed : null);
        } catch { resolve(null); }
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

async function connectClient(label: string, cdpPath: string): Promise<{ browser: Browser; cdp: CDPSession }> {
  const clientId = `release-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

test('releaseTab releases the lease and reports detached: true', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not attached — skipping release spec.');

  const a = await connectClient('A', info!.cdpPath);
  let targetTabId: number | null = null;
  try {
    const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    targetTabId = openRes.tabId as number;
    await a.cdp.send('Earthling.switchToTab' as any, { tabId: targetTabId });

    const tabsBefore: any[] = (await a.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    expect(tabsBefore.find(t => t.tabId === targetTabId)?.lease).toBe('you');

    const releaseRes: any = await a.cdp.send('Earthling.releaseTab' as any, { tabId: targetTabId });
    expect(releaseRes.released).toBe(true);
    expect(releaseRes.detached).toBe(true);

    const tabsAfter: any[] = (await a.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    expect(tabsAfter.find(t => t.tabId === targetTabId)?.lease).toBe('free');
  } finally {
    if (targetTabId !== null)
      await a.cdp.send('Earthling.closeTab' as any, { tabId: targetTabId }).catch(() => {});
    await a.browser.close().catch(() => {});
  }
});

test('abrupt WS close on client A releases its leases so peers see them free', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not attached — skipping release-on-ws-close spec.');

  const a = await connectClient('A', info!.cdpPath);
  const c = await connectClient('C', info!.cdpPath);

  let targetTabId: number | null = null;
  try {
    const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    targetTabId = openRes.tabId as number;
    await a.cdp.send('Earthling.switchToTab' as any, { tabId: targetTabId });

    const tabsDuring: any[] = (await c.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    expect(tabsDuring.find(t => t.tabId === targetTabId)?.lease).toBe('busy');

    await a.browser.close().catch(() => {});

    const deadline = Date.now() + 5_000;
    let freed = false;
    while (Date.now() < deadline) {
      const tabs: any[] = (await c.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
      const target = tabs.find(t => t.tabId === targetTabId);
      if (target && target.lease === 'free') { freed = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    expect(freed).toBe(true);
  } finally {
    if (targetTabId !== null)
      await c.cdp.send('Earthling.closeTab' as any, { tabId: targetTabId }).catch(() => {});
    await c.browser.close().catch(() => {});
  }
});
