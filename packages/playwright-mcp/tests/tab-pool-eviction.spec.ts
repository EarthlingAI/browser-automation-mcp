/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Phase 3 — Tab Pool eviction on close: a closed tab is removed from the
// pool, peers in the pool stay healthy and routable, and `closeTab` does
// not perturb the WS (`client_disconnect_count` Δ === 0).

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
	const clientId = `pool-evict-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
	return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

test('closing a tab evicts it from the pool; peers remain healthy', async () => {
	test.setTimeout(60_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping tab-pool-eviction spec.');

	const before = await fetchHealth();
	expect(before).toBeTruthy();
	const baselineDisconnects = before!.telemetry!.client_disconnect_count ?? 0;

	const a = await connectClient();
	let tab1: number | null = null;
	let tab2: number | null = null;
	try {
		const open1: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/' });
		tab1 = open1.tabId as number;
		const open2: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.org/' });
		tab2 = open2.tabId as number;
		expect(tab1).toBeTruthy();
		expect(tab2).toBeTruthy();

		// Switch to tab 1 and confirm it is leased.
		await a.cdp.send('Earthling.switchToTab' as any, { tabId: tab1 });
		const beforeClose = await listTabs(a.cdp);
		expect(beforeClose.find((t: any) => t.tabId === tab1)?.lease).toBe('you');

		// Close tab 1 — the pool must evict it.
		await a.cdp.send('Earthling.closeTab' as any, { tabId: tab1 });

		// listTabsAnnotated no longer contains tab 1.
		const afterClose = await listTabs(a.cdp);
		const survivor = afterClose.find((t: any) => t.tabId === tab1);
		expect(survivor, `tab ${tab1} should be gone from the tab list after close`).toBeFalsy();

		// Tab 2 is still listable and routable — switching to it must succeed
		// without re-binding errors.
		const tab2Entry = afterClose.find((t: any) => t.tabId === tab2);
		expect(tab2Entry, `tab ${tab2} should still be listable`).toBeTruthy();
		await a.cdp.send('Earthling.switchToTab' as any, { tabId: tab2 });
		const afterSwitch = await listTabs(a.cdp);
		expect(afterSwitch.find((t: any) => t.tabId === tab2)?.lease,
			`tab ${tab2} should be leased by us after switch`).toBe('you');

		// closeTab is not a WS event — disconnect counter must be flat.
		const after = await fetchHealth();
		expect(after).toBeTruthy();
		const finalDisconnects = after!.telemetry!.client_disconnect_count ?? 0;
		expect(finalDisconnects - baselineDisconnects,
			`client_disconnect_count Δ across closeTab must be 0, got ${finalDisconnects - baselineDisconnects}`)
			.toBe(0);

		// tab 1 already closed — clear so finally block doesn't double-close.
		tab1 = null;
	} finally {
		if (tab1 !== null)
			await a.cdp.send('Earthling.closeTab' as any, { tabId: tab1 }).catch(() => {});
		if (tab2 !== null)
			await a.cdp.send('Earthling.closeTab' as any, { tabId: tab2 }).catch(() => {});
		await a.browser.close().catch(() => {});
	}
});
