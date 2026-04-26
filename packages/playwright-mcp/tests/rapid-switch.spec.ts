/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Verifies the P2 fix — browser_open_tab(url=X) + browser_switch_tab(tabId=Y)
// lands the lease on the requested target, not on a freshly-spawned
// about:blank. Prior bug: switch reported success but lease landed on a
// racing blank target that appeared mid-switch (listTabs() stale snapshot).
//
// Requires a live relay daemon with the Browser Bridge extension attached
// to a real Chrome/Edge profile. Skipped cleanly when the extension isn't
// present.

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

async function connectClient(): Promise<{ browser: Browser; cdp: CDPSession }> {
  const info = await discover();
  if (!info) throw new Error('relay not discoverable');
  const clientId = `rapid-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
  const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
  const cdp = await browser.newBrowserCDPSession();
  return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
  return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

type HealthResponse = {
  extension?: string;
  clients?: number;
  telemetry?: {
    client_disconnect_count?: number;
  };
};

async function fetchHealth(): Promise<HealthResponse | null> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 500 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body) as HealthResponse); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

test('open_tab(url=X) + switch_tab lands lease on X, not a racing about:blank', async () => {
  test.setTimeout(90_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping rapid-switch spec.');

  // Loop 3 times to shake out the race.
  for (let i = 0; i < 3; i++) {
    const a = await connectClient();
    let newTabId: number | null = null;
    try {
      const url = 'https://example.com/';
      const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url });
      newTabId = openRes.tabId as number;
      expect(newTabId).toBeTruthy();

      await a.cdp.send('Earthling.switchToTab' as any, { tabId: newTabId });

      const after = await listTabs(a.cdp);
      // The switched-to tab must be leased by this client and carry the
      // example.com URL (the P2 bug: lease lands on a racing about:blank
      // spawned mid-switch, while the returned tabId matches but the URL
      // does not).
      const chosenEntry = after.find((t: any) => t.tabId === newTabId);
      expect(chosenEntry, `iteration ${i}: switched tabId ${newTabId} missing from tab list`).toBeTruthy();
      expect(chosenEntry!.lease, `iteration ${i}: switched tab ${newTabId} not leased by us`).toBe('you');
      expect(chosenEntry!.url, `iteration ${i}: leased URL should be example.com, not about:blank`).toContain('example.com');

      // No stray about:blank leased by us (the bug's smoking gun).
      const strayBlanks = after.filter((t: any) => t.lease === 'you' && t.tabId !== newTabId && (t.url === 'about:blank' || t.url === ''));
      expect(strayBlanks.length, `iteration ${i}: stray about:blank leased by us: ${JSON.stringify(strayBlanks)}`).toBe(0);
    } finally {
      if (newTabId !== null)
        await a.cdp.send('Earthling.closeTab' as any, { tabId: newTabId }).catch(() => {});
      await a.browser.close().catch(() => {});
    }
  }
});

// Phase 3 — per-tab pool: 10 alternating switches between two pre-opened
// tabs must NOT drop the WS. With the dispose-on-switch model gone, the
// `client_disconnect_count` Δ across this flow is 0 by construction.
test('10 alternating switches between two tabs keep client_disconnect_count flat', async () => {
  test.setTimeout(90_000);
  const info = await discover();
  test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping rapid-switch alternating spec.');

  const before = await fetchHealth();
  expect(before).toBeTruthy();
  const baselineDisconnects = before!.telemetry!.client_disconnect_count ?? 0;

  const a = await connectClient();
  let tabA: number | null = null;
  let tabB: number | null = null;
  try {
    const openA: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/' });
    tabA = openA.tabId as number;
    const openB: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.org/' });
    tabB = openB.tabId as number;
    expect(tabA).toBeTruthy();
    expect(tabB).toBeTruthy();

    for (let i = 0; i < 10; i++) {
      const target = i % 2 === 0 ? tabA! : tabB!;
      await a.cdp.send('Earthling.switchToTab' as any, { tabId: target });
      const tabs = await listTabs(a.cdp);
      const entry = tabs.find((t: any) => t.tabId === target);
      expect(entry, `iteration ${i}: tab ${target} missing from tab list`).toBeTruthy();
      expect(entry!.lease, `iteration ${i}: tab ${target} should be leased by us`).toBe('you');
    }

    const after = await fetchHealth();
    expect(after).toBeTruthy();
    const finalDisconnects = after!.telemetry!.client_disconnect_count ?? 0;
    expect(finalDisconnects - baselineDisconnects,
      `client_disconnect_count Δ across 10 alternating switches must be 0, got ${finalDisconnects - baselineDisconnects}`)
      .toBe(0);
  } finally {
    if (tabA !== null)
      await a.cdp.send('Earthling.closeTab' as any, { tabId: tabA }).catch(() => {});
    if (tabB !== null)
      await a.cdp.send('Earthling.closeTab' as any, { tabId: tabB }).catch(() => {});
    await a.browser.close().catch(() => {});
  }
});
