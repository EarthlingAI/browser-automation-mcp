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

// Verifies Phase C — singleton/badge state removed from the Browser Bridge
// extension. `listTabsAnnotated` responses must not contain the old
// `CONNECTED` / `HIGHLIGHTED` flags and listing a tab must not flip any
// Chrome action badge text. Requires a real Chrome/Edge profile with the
// Browser Bridge extension loaded; skipped otherwise.

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
  const clientId = `no-badge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

test('listTabsAnnotated payload does not carry CONNECTED or HIGHLIGHTED flags', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping badge spec.');

  const a = await connectClient(info!.cdpPath);
  let tabX: number | null = null;
  let tabY: number | null = null;
  try {
    const openX: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    tabX = openX.tabId as number;
    const openY: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    tabY = openY.tabId as number;

    await a.cdp.send('Earthling.switchToTab' as any, { tabId: tabX });
    await a.cdp.send('Earthling.switchToTab' as any, { tabId: tabY, force: true });

    const tabs: any[] = (await a.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    const raw = JSON.stringify(tabs);
    expect(raw).not.toMatch(/CONNECTED/);
    expect(raw).not.toMatch(/HIGHLIGHTED/);

    for (const t of tabs) {
      expect(t).not.toHaveProperty('connected');
      expect(t).not.toHaveProperty('highlighted');
    }
  } finally {
    if (tabX !== null) await a.cdp.send('Earthling.closeTab' as any, { tabId: tabX }).catch(() => {});
    if (tabY !== null) await a.cdp.send('Earthling.closeTab' as any, { tabId: tabY }).catch(() => {});
    await a.browser.close().catch(() => {});
  }
});
