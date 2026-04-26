/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Phase 3 — Tab Pool routing: a single client opens 3 tabs and switches
// between them via Earthling.switchToTab. Each switch must update the
// `lease: 'you'` annotation on the target tab and the URL must match what
// was opened. The H1 win — `client_disconnect_count` flat across switches —
// is asserted by construction: in the per-tab pool model the WS lives for
// the session's lifetime, so switching never drops the client.

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
	const clientId = `pool-route-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
	return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

test('tab pool routes switch_tab between 3 tabs without dropping the WS', async () => {
	test.setTimeout(60_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping tab-pool-routing spec.');

	const before = await fetchHealth();
	expect(before).toBeTruthy();
	const baselineDisconnects = before!.telemetry!.client_disconnect_count ?? 0;

	const a = await connectClient();
	const opened: Array<{ tabId: number; url: string }> = [];
	try {
		const urls = ['https://example.com/', 'https://example.org/', 'https://example.net/'];
		for (const url of urls) {
			const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url });
			expect(openRes?.tabId).toBeTruthy();
			opened.push({ tabId: openRes.tabId as number, url });
		}

		// Switch to each tab in turn and verify the lease + URL.
		for (const { tabId, url } of opened) {
			await a.cdp.send('Earthling.switchToTab' as any, { tabId });
			const tabs = await listTabs(a.cdp);
			const entry = tabs.find((t: any) => t.tabId === tabId);
			expect(entry, `tab ${tabId} missing from tab list after switch`).toBeTruthy();
			expect(entry!.lease, `tab ${tabId} not leased by us after switch`).toBe('you');
			expect(entry!.url, `tab ${tabId} URL mismatch — expected ${url}`).toContain(new URL(url).host);
		}

		// H1 win: the WS must not have closed across the entire flow.
		const after = await fetchHealth();
		expect(after).toBeTruthy();
		const finalDisconnects = after!.telemetry!.client_disconnect_count ?? 0;
		expect(finalDisconnects - baselineDisconnects,
			`client_disconnect_count Δ across 3 switches must be 0, got ${finalDisconnects - baselineDisconnects}`)
			.toBe(0);
	} finally {
		for (const { tabId } of opened)
			await a.cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
		await a.browser.close().catch(() => {});
	}
});
