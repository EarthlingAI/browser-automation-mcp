/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Phase 3 — Tab Pool preemption: client B force-switches to a tab held by
// client A. A's lease is revoked at the daemon; A's view of the tab flips
// to `lease: 'busy'`, B's view becomes `lease: 'you'`, and B's
// `Earthling.whoAmI` reports the preempted tab as the primary. Preemption
// is a tab-level event, not a WS event, so A's `client_disconnect_count`
// stays flat.

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

async function connectClient(label: string, cdpPath: string): Promise<{ browser: Browser; cdp: CDPSession }> {
	const clientId = `pool-preempt-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
	return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

test('force-switch preemption flips lease without dropping the loser WS', async () => {
	test.setTimeout(60_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping tab-pool-preemption spec.');

	const before = await fetchHealth();
	expect(before).toBeTruthy();
	const baselineDisconnects = before!.telemetry!.client_disconnect_count ?? 0;

	const a = await connectClient('A', info!.cdpPath);
	const b = await connectClient('B', info!.cdpPath);
	let tabId: number | null = null;
	try {
		// A opens and switches to a tab.
		const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/' });
		tabId = openRes.tabId as number;
		expect(tabId).toBeTruthy();
		await a.cdp.send('Earthling.switchToTab' as any, { tabId });

		// Sanity: A holds the lease.
		const aBefore = await listTabs(a.cdp);
		expect(aBefore.find((t: any) => t.tabId === tabId)?.lease).toBe('you');

		// B preempts.
		await b.cdp.send('Earthling.switchToTab' as any, { tabId, force: true });

		// Brief settle — daemon emits Target.detachedFromTarget to A and
		// Target.attachedToTarget to B.
		await new Promise(r => setTimeout(r, 300));

		// A now sees the tab as busy.
		const aAfter = await listTabs(a.cdp);
		const aEntry = aAfter.find((t: any) => t.tabId === tabId);
		expect(aEntry, `tab ${tabId} should still appear in A's tab list`).toBeTruthy();
		expect(aEntry!.lease, `A's lease on ${tabId} should flip to 'busy' after preemption`).toBe('busy');

		// B holds the lease.
		const bAfter = await listTabs(b.cdp);
		const bEntry = bAfter.find((t: any) => t.tabId === tabId);
		expect(bEntry, `tab ${tabId} should appear in B's tab list`).toBeTruthy();
		expect(bEntry!.lease, `B's lease on ${tabId} should be 'you' after preemption`).toBe('you');

		// B can interact with the tab.
		const whoAmIB: any = await b.cdp.send('Earthling.whoAmI' as any, {});
		expect(whoAmIB?.primaryTab, `B's primaryTab should be ${tabId}`).toBe(tabId);

		// A's WS stays alive — preemption is not a WS event.
		const after = await fetchHealth();
		expect(after).toBeTruthy();
		const finalDisconnects = after!.telemetry!.client_disconnect_count ?? 0;
		expect(finalDisconnects - baselineDisconnects,
			`client_disconnect_count Δ across preemption must be 0, got ${finalDisconnects - baselineDisconnects}`)
			.toBe(0);
	} finally {
		if (tabId !== null)
			await b.cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
		await a.browser.close().catch(() => {});
		await b.browser.close().catch(() => {});
	}
});
