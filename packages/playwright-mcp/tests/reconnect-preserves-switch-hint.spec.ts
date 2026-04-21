/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Regression: the `_lastSwitchedTab` hint MUST survive a client-WS close
// (triggered by `response.setClose()` on the MCP side after `switch_tab`) so
// that the next backend's `setAutoAttach` can re-bind to the intended tab
// via the three-step hint chain.
//
// Prior bug (landed 2026-04-22 during Scenario 1 stress): the daemon's
// ws.on('close') handler called `_cleanupTabSessions(tabId)` for each lease
// released on disconnect, and that helper also wiped `_lastSwitchedTab`
// entries pointing at the tab. With the hint gone, `_handleSetAutoAttach`
// took priority 3 (open fresh blank) on every reconnect and the lease landed
// on a newly-spawned about:blank instead of the user-requested tab. The fix
// splits a dedicated `_forgetTab(tabId)` helper (sessions + hints) used only
// on actual tab-close paths; `_cleanupTabSessions` no longer touches hints.
//
// This spec drives the exact production path: openTab → switchToTab →
// dispose (WS close) → reconnect with same clientId → trigger setAutoAttach
// via `newBrowserCDPSession` → assert the second connection's primary tab is
// the one we switched to, and the lease on that tab is held by us.

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

async function connectClient(cdpPath: string, clientId: string): Promise<{ browser: Browser; cdp: CDPSession }> {
	const endpoint = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	const cdp = await browser.newBrowserCDPSession();
	return { browser, cdp };
}

async function listTabs(cdp: CDPSession): Promise<any[]> {
	return (await cdp.send('Earthling.listTabsAnnotated' as any, {})) as any;
}

test('last-switched hint survives client WS close → reconnect, lease stays on requested tab', async () => {
	test.setTimeout(90_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping reconnect-hint regression spec.');

	const clientId = `reconnect-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	let switchedTabId: number | null = null;

	try {
		// Phase 1 — connect, open a URL-bearing tab, switch to it, capture the tabId.
		const a = await connectClient(info!.cdpPath, clientId);
		const openRes: any = await a.cdp.send('Earthling.openTab' as any, { url: 'https://example.com/' });
		switchedTabId = openRes.tabId as number;
		expect(switchedTabId).toBeTruthy();
		const switchRes: any = await a.cdp.send('Earthling.switchToTab' as any, { tabId: switchedTabId });
		expect(switchRes?.claimed, 'switchToTab did not claim the requested tab').toBe(switchedTabId);

		// Dispose — this mirrors `response.setClose()` in the MCP tool handler.
		await a.browser.close();
		// Brief settle so the daemon's ws.on('close') handler has fired
		// (releaseAllFor + cleanupTabSessions) before we reconnect.
		await new Promise(r => setTimeout(r, 200));

		// Phase 2 — reconnect with the SAME clientId. This is exactly what
		// the MCP does on the next tool call after setClose. A fresh
		// `newBrowserCDPSession()` triggers `Target.setAutoAttach` which
		// drives `_handleSetAutoAttach` → the hint chain must pick up
		// `switchedTabId` here, not spawn a fresh about:blank.
		const b = await connectClient(info!.cdpPath, clientId);
		try {
			const post = await listTabs(b.cdp);
			const postEntry = post.find((t: any) => t.tabId === switchedTabId);
			expect(postEntry, `reconnect: switched tabId ${switchedTabId} missing from tab list`).toBeTruthy();
			expect(postEntry!.lease, `reconnect: lease lost — landed on a racing blank instead of ${switchedTabId}`).toBe('you');
			expect(postEntry!.url, `reconnect: leased tab URL regressed — expected example.com, got ${postEntry!.url}`).toContain('example.com');

			// Smoking-gun check: no stray about:blank leased by us.
			const strayBlanks = post.filter((t: any) => t.lease === 'you' && t.tabId !== switchedTabId && (t.url === 'about:blank' || t.url === ''));
			expect(strayBlanks.length, `reconnect: stray about:blank leased by us: ${JSON.stringify(strayBlanks)}`).toBe(0);
		} finally {
			await b.browser.close().catch(() => {});
		}
	} finally {
		// Final cleanup — close the test tab via a fresh connection.
		if (switchedTabId !== null) {
			try {
				const c = await connectClient(info!.cdpPath, `reconnect-cleanup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
				await c.cdp.send('Earthling.closeTab' as any, { tabId: switchedTabId }).catch(() => {});
				await c.browser.close().catch(() => {});
			} catch {}
		}
	}
});
