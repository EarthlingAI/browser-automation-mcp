/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Verifies the dev-only orphan-sweep extension handler is wired end-to-end:
//   Earthling.queryOrphanBlanks → daemon → extension → response shape.
//
// The full sweep flow (daemon startup → sweep → close) runs in a separate
// daemon process and is gated on EARTHLING_MCP_SWEEP_ORPHANS=1 at boot —
// toggling that from a test would require respawning the daemon, which
// fights the shared-daemon pattern of the other ctest specs. Instead we
// assert the protocol seam the sweep relies on: open blanks, release them,
// query, and verify the returned tabs include the ones we just opened with
// the documented `{tabId, lastAccessed, historyLength}` shape.

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
	const clientId = `orphan-sweep-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

test('Earthling.queryOrphanBlanks returns about:blank tabs with sweep-filter shape', async () => {
	test.setTimeout(60_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping orphan-sweep spec.');

	const { browser, cdp } = await connectClient();
	const opened: number[] = [];
	try {
		// Open a few about:blank tabs, then release so they aren't lease-held
		// (the sweep's real-world safety filter refuses to close lease-held
		// tabs — but the extension handler itself is lease-agnostic and simply
		// lists all about:blank tabs, which is what we're exercising here).
		for (let i = 0; i < 3; i++) {
			const opened_t: any = await cdp.send('Earthling.openTab' as any, { url: 'about:blank' });
			if (typeof opened_t?.tabId === 'number') {
				opened.push(opened_t.tabId);
				// Release immediately — openTab does not acquire a lease, but
				// calling releaseTab is a safe no-op and mirrors the intended
				// sweep precondition that no client holds the tab.
				await cdp.send('Earthling.releaseTab' as any, { tabId: opened_t.tabId }).catch(() => {});
			}
		}

		const resp: any = await cdp.send('Earthling.queryOrphanBlanks' as any, {});
		expect(resp).toBeTruthy();
		expect(Array.isArray(resp.tabs)).toBe(true);

		for (const t of resp.tabs) {
			expect(typeof t.tabId).toBe('number');
			expect(typeof t.lastAccessed).toBe('number');
			expect(typeof t.historyLength).toBe('number');
			expect(t.historyLength).toBeGreaterThanOrEqual(1);
		}

		// The tabs we just opened should show up (chrome.tabs may include
		// extras — other opener-spawned blanks — which is fine; the sweep's
		// age/history/lease filters handle those).
		const reportedIds = new Set<number>(resp.tabs.map((t: any) => t.tabId));
		for (const id of opened)
			expect(reportedIds.has(id)).toBe(true);
	} finally {
		// Cleanup — close any tabs we opened, regardless of assertion outcome.
		for (const tabId of opened) {
			await cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
		}
		await browser.close().catch(() => {});
	}
});
