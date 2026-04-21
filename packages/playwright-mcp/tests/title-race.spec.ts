/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Regression coverage for the P1 page.title() serializer race — ensures a
// concurrent `Earthling.listTabsAnnotated` issued while a tab is navigating
// never throws because of an `Execution context was destroyed` rejection
// from page.title(). The safeTitle helper in backend/utils.ts + wiring in
// tab.ts::headerSnapshot and earthlingTabs.ts should keep the response
// rendering either the cached title, URL fallback, or '<navigating>'.
//
// Requires a live relay daemon with the Browser Bridge extension attached.
// Skipped cleanly when the extension isn't present.

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
	const clientId = `title-race-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

test('listTabsAnnotated survives a concurrent mid-navigation page.title() race', async () => {
	test.setTimeout(60_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping title-race spec.');

	const a = await connectClient();
	const openedTabs: number[] = [];
	try {
		// Seed one stable tab so the list-call has a non-empty payload even if
		// the nav tab is mid-transition.
		const stable: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/' });
		openedTabs.push(stable.tabId);

		// Shake the race across multiple iterations — open + list in parallel.
		for (let i = 0; i < 4; i++) {
			const openP = a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/?i=' + i });
			// Race a list against the still-navigating target.
			const listP = a.cdp.send('Earthling.listTabsAnnotated' as any, {});

			const [openRes, listRes]: any = await Promise.all([openP, listP]);
			openedTabs.push(openRes.tabId);

			// The list call must always return an array; entries should have
			// a title (possibly the URL fallback or '<navigating>') but must
			// never bubble a thrown error.
			expect(Array.isArray(listRes)).toBe(true);
			for (const t of listRes) {
				expect(typeof t.tabId).toBe('number');
				expect(typeof t.title).toBe('string');
			}
		}
	} finally {
		for (const tabId of openedTabs)
			await a.cdp.send('Earthling.closeTab' as any, { tabId }).catch(() => {});
		await a.browser.close().catch(() => {});
	}
});
