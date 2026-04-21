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

// Verifies Phase D1 — `Earthling.listTabsAnnotated` is pure-read and never
// claims a lease as a side-effect. Explicit `switchToTab` is the only
// claim path. Requires the Browser Bridge extension; skipped otherwise.

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

async function connectClient(cdpPath: string): Promise<{ browser: Browser; cdp: CDPSession }> {
  const clientId = `pure-read-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

test('listTabsAnnotated does not auto-claim a tab on repeated calls', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not attached — skipping pure-read spec.');

  // Opener client creates three unleased tabs for the observer to list.
  const opener = await connectClient(info!.cdpPath);
  const observer = await connectClient(info!.cdpPath);

  const createdTabIds: number[] = [];
  try {
    for (const url of ['https://example.com/', 'https://example.org/', 'https://example.net/']) {
      const res: any = await opener.cdp.send('Earthling.openTab' as any, { url });
      createdTabIds.push(res.tabId as number);
    }
    // Opener releases any implicit holdings so the three new tabs start unleased.
    for (const tabId of createdTabIds)
      await opener.cdp.send('Earthling.releaseTab' as any, { tabId }).catch(() => {});

    const firstList: any[] = (await observer.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    const observedFirst = firstList.filter(t => createdTabIds.includes(t.tabId));
    for (const t of observedFirst)
      expect(t.lease, `tab ${t.tabId} was claimed on first list call`).not.toBe('you');

    const secondList: any[] = (await observer.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    const observedSecond = secondList.filter(t => createdTabIds.includes(t.tabId));
    for (const t of observedSecond)
      expect(t.lease, `tab ${t.tabId} was claimed on second list call`).not.toBe('you');

    // Explicit switch is the only claim path.
    const chosen = createdTabIds[1];
    await observer.cdp.send('Earthling.switchToTab' as any, { tabId: chosen });
    const postSwitch: any[] = (await observer.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    const chosenEntry = postSwitch.find(t => t.tabId === chosen);
    expect(chosenEntry?.lease).toBe('you');

    for (const tabId of createdTabIds) {
      if (tabId === chosen) continue;
      const e = postSwitch.find(t => t.tabId === tabId);
      expect(e?.lease, `non-switched tab ${tabId} acquired a lease`).not.toBe('you');
    }
  } finally {
    for (const tabId of createdTabIds)
      await opener.cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
    await opener.browser.close().catch(() => {});
    await observer.browser.close().catch(() => {});
  }
});
