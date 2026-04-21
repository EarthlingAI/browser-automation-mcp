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

// Verifies Phase B/C/D — tab-switch teardown is bounded end-to-end.
// Prior to the fix, `Context.dispose` could hang indefinitely on a stranded
// `_preemptionCdp.detach()` during the daemon's Phase-3 two-phase commit,
// blocking the tool response for minutes. Every switch must now return within
// a modest budget (normal <500ms; 3s catches any regression).

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
  const clientId = `teardown-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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

async function closeTab(cdp: CDPSession, tabId: number): Promise<void> {
  await cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
}

test.describe('teardown budget', () => {
  test('repeated browser_switch_tab returns within budget and leaves no lingering pending state', async () => {
    test.setTimeout(120_000);
    const info = await discover();
    test.skip(!info || !(await healthy()), 'Browser Bridge extension not attached — skipping teardown-budget spec.');

    const a = await connectClient('A', info!.cdpPath);
    const b = await connectClient('B', info!.cdpPath);

    const openedTabs: number[] = [];
    try {
      const tab1 = await openTab(a.cdp, 'about:blank');
      openedTabs.push(tab1);
      const tab2 = await openTab(a.cdp, 'about:blank');
      openedTabs.push(tab2);

      const durations: number[] = [];
      for (let i = 0; i < 10; i++) {
        const target = i % 2 === 0 ? tab1 : tab2;
        const started = Date.now();
        await switchTab(a.cdp, target);
        const elapsed = Date.now() - started;
        durations.push(elapsed);
        expect(elapsed, `switch #${i} to tab ${target} took ${elapsed}ms (durations=${JSON.stringify(durations)})`).toBeLessThan(3000);
      }

      const tabsFromB = await listTabs(b.cdp);
      for (const tabId of openedTabs) {
        const entry = tabsFromB.find(t => t.tabId === tabId);
        if (!entry) continue;
        if (entry.lease === 'you')
          throw new Error(`tab ${tabId} reports lease='you' from B after A held it — stale ownership: ${JSON.stringify(entry)}`);
      }

      const tabsFromA = await listTabs(a.cdp);
      for (const tabId of openedTabs) {
        const entry = tabsFromA.find(t => t.tabId === tabId);
        if (!entry) continue;
        expect(['you', 'free', 'other']).toContain(entry.lease);
      }
    } finally {
      for (const tabId of openedTabs)
        await closeTab(a.cdp, tabId);
      await a.browser.close().catch(() => {});
      await b.browser.close().catch(() => {});
    }
  });
});
