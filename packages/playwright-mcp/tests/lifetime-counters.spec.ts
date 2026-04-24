/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Verifies the two lifetime-scope telemetry counters exposed at /health:
// - `lifetime_clients_high_water` — peak concurrent clients ever observed.
// - `client_disconnect_count` — total ws.on('close') observations.
//
// Complements `clients_1s_high_water` (rolling 1s window) by capturing
// sub-second churn that the rolling counter can miss between resets.

import http from 'node:http';
import { test, expect } from '@playwright/test';
import { chromium, type Browser } from 'playwright';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || '9223', 10);

type HealthResponse = {
	extension?: string;
	clients?: number;
	telemetry?: {
		lifetime_clients_high_water?: number;
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

async function connectAndClose(info: { cdpPath: string }, label: string): Promise<void> {
	const clientId = `${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const endpoint = `ws://127.0.0.1:${PORT}${info.cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const browser: Browser = await chromium.connectOverCDP(endpoint, { isLocal: true });
	// Drive one CDP call so the daemon sees a real interaction before close.
	const cdp = await browser.newBrowserCDPSession();
	await cdp.send('Earthling.whoAmI' as any, {}).catch(() => {});
	await browser.close().catch(() => {});
}

test('lifetime_clients_high_water and client_disconnect_count track connect/disconnect cycles', async () => {
	test.setTimeout(60_000);
	const info = await discover();
	test.skip(!info || !(await healthy()), 'Browser Bridge extension not loaded — skipping lifetime-counters spec.');

	const before = await fetchHealth();
	expect(before).toBeTruthy();
	expect(before!.telemetry).toBeTruthy();
	expect(typeof before!.telemetry!.lifetime_clients_high_water).toBe('number');
	expect(typeof before!.telemetry!.client_disconnect_count).toBe('number');

	// Sequential connect/disconnect ×3. Each cycle drives a single client up
	// then down; the high-water may stay at baseline (since we never exceed 1
	// concurrent client here) but the disconnect counter must advance by N.
	await connectAndClose(info!, 'life-a');
	await connectAndClose(info!, 'life-b');
	await connectAndClose(info!, 'life-c');

	// Give the daemon a moment to process the close events.
	await new Promise(r => setTimeout(r, 200));

	const after = await fetchHealth();
	expect(after).toBeTruthy();

	// Counters never go backwards.
	expect(after!.telemetry!.lifetime_clients_high_water!).toBeGreaterThanOrEqual(before!.telemetry!.lifetime_clients_high_water!);
	// Disconnect count must advance by at least 3.
	expect(after!.telemetry!.client_disconnect_count!).toBeGreaterThanOrEqual(before!.telemetry!.client_disconnect_count! + 3);
	// Lifetime high-water must have seen at least one client during this test.
	expect(after!.telemetry!.lifetime_clients_high_water!).toBeGreaterThanOrEqual(1);
});
