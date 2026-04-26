/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Phase 3 — H1 win, by construction. After the per-tab pool replaces the
// dispose-on-switch model, the WS survives a 30-second cross-turn thinking
// gap with the lease intact. No transparent reconnect, no `_lastSwitchedTab`
// hint chain reactivation — the same Page handle is still valid, the lease
// is still ours, and `client_disconnect_count` has not advanced.

import http from 'node:http';
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type CDPSession } from 'playwright';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || '9223', 10);

type HealthResponse = {
	extension?: string;
	clients?: number;
	telemetry?: {
		client_disconnect_count?: number;
	};
};

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

async function healthy(): Promise<boolean> {
	const h = await fetchHealth();
	return h?.extension === 'connected';
}

async function connectClient(): Promise<{ browser: Browser; cdp: CDPSession }> {
	const info = await discover();
	if (!info) throw new Error('relay not discoverable');
	const clientId = `pool-thinkgap-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
	return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

test('lease survives a 30s cross-turn thinking gap with WS intact', async () => {
	test.setTimeout(90_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping tab-pool-survives-thinkgap spec.');

	const before = await fetchHealth();
	expect(before).toBeTruthy();
	const baselineDisconnects = before!.telemetry!.client_disconnect_count ?? 0;

	const a = await connectClient();
	let tabId: number | null = null;
	try {
		const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/' });
		tabId = openRes.tabId as number;
		expect(tabId).toBeTruthy();
		await a.cdp.send('Earthling.switchToTab' as any, { tabId });

		const beforeGap = await listTabs(a.cdp);
		const beforeEntry = beforeGap.find((t: any) => t.tabId === tabId);
		expect(beforeEntry, `tab ${tabId} should be in tab list pre-gap`).toBeTruthy();
		expect(beforeEntry!.lease).toBe('you');
		const beforeUrl = beforeEntry!.url as string;

		// 30s cross-turn thinking gap.
		await new Promise(r => setTimeout(r, 30_000));

		// Post-gap assertions: WS alive, lease intact, URL stable.
		expect(a.browser.isConnected(), 'browser.isConnected() should remain true across thinkgap').toBe(true);

		const afterGap = await listTabs(a.cdp);
		const afterEntry = afterGap.find((t: any) => t.tabId === tabId);
		expect(afterEntry, `tab ${tabId} should still be in tab list post-gap`).toBeTruthy();
		expect(afterEntry!.lease, `lease on tab ${tabId} should still be 'you' after 30s gap`).toBe('you');
		expect(afterEntry!.url, `URL on tab ${tabId} should not have drifted`).toBe(beforeUrl);

		const whoAmI: any = await a.cdp.send('Earthling.whoAmI' as any, {});
		expect(whoAmI?.primaryTab, `whoAmI.primaryTab should still be ${tabId}`).toBe(tabId);

		// THE H1 WIN: zero disconnects across the 30s gap.
		const after = await fetchHealth();
		expect(after).toBeTruthy();
		const finalDisconnects = after!.telemetry!.client_disconnect_count ?? 0;
		expect(finalDisconnects - baselineDisconnects,
			`client_disconnect_count Δ across 30s thinkgap must be 0, got ${finalDisconnects - baselineDisconnects}`)
			.toBe(0);
	} finally {
		if (tabId !== null)
			await a.cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
		await a.browser.close().catch(() => {});
	}
});
