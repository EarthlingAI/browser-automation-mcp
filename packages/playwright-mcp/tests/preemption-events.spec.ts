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

// Verifies Phase D5 — `Earthling.tabPreempted` reaches the loser's CDP channel
// on force-switch. Requires a live daemon with the Browser Bridge extension.

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
          if (parsed?.service === 'earthling-cdp-relay') resolve(parsed);
          else resolve(null);
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
      res.on('end', () => { try { const h = JSON.parse(body); resolve(h?.extension === 'connected'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function connectClient(label: string, cdpPath: string): Promise<{ browser: Browser; cdp: CDPSession }> {
  const clientId = `preempt-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

test('loser receives Earthling.tabPreempted on force-switch', async () => {
  test.setTimeout(60_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not attached — skipping preemption spec.');

  const a = await connectClient('A', info!.cdpPath);
  const b = await connectClient('B', info!.cdpPath);

  const preemptionEvents: Array<{ method: string; params: any }> = [];
  a.cdp.on('event' as any, (e: any) => {
    if (e?.method === 'Earthling.tabPreempted')
      preemptionEvents.push(e);
  });

  let targetTabId: number | null = null;
  try {
    const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
    targetTabId = openRes.tabId as number;
    await a.cdp.send('Earthling.switchToTab' as any, { tabId: targetTabId });

    await new Promise(r => setTimeout(r, 200));

    await b.cdp.send('Earthling.switchToTab' as any, { tabId: targetTabId, force: true });

    const deadline = Date.now() + 5_000;
    while (preemptionEvents.length === 0 && Date.now() < deadline)
      await new Promise(r => setTimeout(r, 100));

    expect(preemptionEvents.length).toBeGreaterThan(0);
    const evt = preemptionEvents[0];
    expect(evt.params.tabId).toBe(targetTabId);
    expect(evt.params.reason).toBe('force-switch');
    expect(typeof evt.params.revokedBy).toBe('string');

    const tabsA: any[] = (await a.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    const targetOnA = tabsA.find(t => t.tabId === targetTabId);
    expect(targetOnA?.lease).not.toBe('you');

    // Regression guard: after the preemption, A's very next CDP call must
    // return within a short budget. Prior to the teardown-reliability fix,
    // the stranded `_preemptionCdp.detach()` from the preempted switch could
    // leave the loser's dispose path wedged for minutes. `listTabsAnnotated`
    // stands in for `browser_snapshot` — both ride the same daemon WS and
    // exercise the same post-dispose reconnect path.
    const postStarted = Date.now();
    const tabsAgain: any[] = (await a.cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
    const postElapsed = Date.now() - postStarted;
    expect(postElapsed, `post-preemption call took ${postElapsed}ms — dispose may have stalled`).toBeLessThan(3000);
    expect(Array.isArray(tabsAgain)).toBe(true);
    expect(preemptionEvents.length).toBeGreaterThan(0);
  } finally {
    if (targetTabId !== null)
      await b.cdp.send('Earthling.closeTab' as any, { tabId: targetTabId }).catch(() => {});
    await a.browser.close().catch(() => {});
    await b.browser.close().catch(() => {});
  }
});
