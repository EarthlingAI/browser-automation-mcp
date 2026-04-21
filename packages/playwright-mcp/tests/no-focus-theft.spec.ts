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

// Verifies Phase C — agent-initiated open/switch never changes the
// user-visible active tab. The `active` annotation in `listTabsAnnotated`
// reflects Chrome's real active tab, so we can assert focus invariance by
// snapshotting before + after agent operations. Requires the Browser Bridge
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
  const clientId = `focus-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
  return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

test('agent open + switch do not steal the user-visible active tab', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping focus-theft spec.');

  const a = await connectClient(info!.cdpPath);
  let newTabId: number | null = null;
  try {
    const before = await listTabs(a.cdp);
    const activeBefore = before.find(t => t.active);
    test.skip(!activeBefore, 'No active tab reported by the extension; cannot assert invariance.');

    const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    newTabId = openRes.tabId as number;

    const afterOpen = await listTabs(a.cdp);
    const activeAfterOpen = afterOpen.find(t => t.active);
    expect(activeAfterOpen?.tabId, 'user-visible active tab shifted after browser_open_tab').toBe(activeBefore!.tabId);

    await a.cdp.send('Earthling.switchToTab' as any, { tabId: newTabId });

    const afterSwitch = await listTabs(a.cdp);
    const activeAfterSwitch = afterSwitch.find(t => t.active);
    expect(activeAfterSwitch?.tabId, 'user-visible active tab shifted after browser_switch_tab').toBe(activeBefore!.tabId);

    const switchedEntry = afterSwitch.find(t => t.tabId === newTabId);
    expect(switchedEntry?.lease).toBe('you');
    expect(switchedEntry?.active).not.toBe(true);
  } finally {
    if (newTabId !== null)
      await a.cdp.send('Earthling.closeTab' as any, { tabId: newTabId }).catch(() => {});
    await a.browser.close().catch(() => {});
  }
});
