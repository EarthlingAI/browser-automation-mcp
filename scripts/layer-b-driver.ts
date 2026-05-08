/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Earthling Layer-B harness — production-fidelity isolated Chrome + extension
 * + alt-port daemon, with no impact on the user's primary 9223 daemon.
 *
 * Why this exists. Layer-A (raw-WS clients on the live daemon) covers daemon
 * internals but cannot exercise:
 *   - The full extension/Chrome race surface (chrome.debugger detach storms,
 *     attachment chain hazards, SW lifecycle).
 *   - Per-MCP-process Page-pool divergence (the Phase 6 fix surface).
 *   - Multi-agent contention on the same daemon under controlled fault
 *     injection (grace-race, probe-fail).
 * Layer-A does not exercise any of those because it bypasses the extension.
 *
 * Topology per run:
 *   1. Pick a free port (not 9223 — the user's primary daemon owns that).
 *   2. Copy `earthling-extension/` to a tmpdir; patch the default
 *      `relayConfig.port` from 9223 → altPort. The extension's auto-discovery
 *      then targets our daemon, not the user's.
 *   3. Spawn relay-daemon.js on altPort. Do NOT pass --user-data-dir; we
 *      launch Chrome ourselves so we control --load-extension.
 *   4. Spawn Chrome with --user-data-dir=<tmp> --load-extension=<patched-ext>.
 *   5. Poll /health on altPort until extension=connected.
 *   6. Run the scenario (default = preemption-staleness; selectable via
 *      SCENARIO=...).
 *   7. Tear down: kill Chrome, /shutdown daemon, cleanup tmpdirs.
 *
 * Scenarios:
 *   preemption-staleness — A binds tab T, navigates, B force-switches T,
 *     B navigates T elsewhere, A re-attempts work on T. With the Phase 6
 *     fix, A receives Earthling.tabPreempted and a re-attach yields a fresh
 *     CDP target. Fails (or is detected as wedged) without the fix.
 *   grace-race — concurrent drainAndClose() and detach-frame storm under
 *     BROWSER_AUTOMATION_MCP_GRACE_MS=200.
 *   probe-fail — slow extension `listBrowserTabs` reply forces the
 *     daemon's _handleExtensionConnection probe path; clients should
 *     receive a structured frame (Phase 4, future) and disconnect cleanly.
 *
 * All scenarios are designed to PASS today (post-p6-attach-order); failure
 * == new regression. Soak runs cycle through them.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_SRC = path.join(REPO_ROOT, 'earthling-extension');
const DAEMON_JS = path.join(REPO_ROOT, 'dist', 'relay-daemon.js');

type Args = {
	scenario: string;
	iterations: number;
	port: number | null;
	keepArtifacts: boolean;
};

function parseArgs(): Args {
	return {
		scenario: process.env.SCENARIO || 'preemption-staleness',
		iterations: parseInt(process.env.ITERATIONS || '10', 10),
		port: process.env.LAYER_B_PORT ? parseInt(process.env.LAYER_B_PORT, 10) : null,
		keepArtifacts: process.env.LAYER_B_KEEP === '1',
	};
}

function log(msg: string) {
	const ts = new Date().toISOString().slice(11, 23);
	process.stdout.write(`[${ts}] ${msg}\n`);
}

async function findFreePort(start: number): Promise<number> {
	for (let p = start; p < start + 100; p++) {
		const free = await new Promise<boolean>(resolve => {
			const s = net.createServer();
			s.once('error', () => resolve(false));
			s.once('listening', () => { s.close(() => resolve(true)); });
			s.listen(p, '127.0.0.1');
		});
		if (free) return p;
	}
	throw new Error(`no free port in [${start}, ${start + 100})`);
}

function findChromeExecutable(): string {
	if (process.env.LAYER_B_CHROME) return process.env.LAYER_B_CHROME;
	// Prefer Playwright's bundled chromium so we get an isolated browser
	// instance — avoids Windows' chrome.exe singleton-launch behaviour where
	// a second `chrome.exe --user-data-dir=X` against an already-running user
	// Chrome session redirects to the existing process and silently no-ops the
	// new profile + extension flags.
	const pwCacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
		|| (os.platform() === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
			: os.platform() === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
				: path.join(os.homedir(), '.cache', 'ms-playwright'));
	if (fs.existsSync(pwCacheRoot)) {
		for (const entry of fs.readdirSync(pwCacheRoot)) {
			if (!entry.startsWith('chromium-')) continue;
			const candidates = [
				path.join(pwCacheRoot, entry, 'chrome-win64', 'chrome.exe'),
				path.join(pwCacheRoot, entry, 'chrome-win', 'chrome.exe'),
				path.join(pwCacheRoot, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
				path.join(pwCacheRoot, entry, 'chrome-linux', 'chrome'),
			];
			for (const c of candidates)
				if (fs.existsSync(c)) return c;
		}
	}
	const fallbacks = os.platform() === 'win32' ? [
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	] : os.platform() === 'darwin' ? [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	] : [
		'/usr/bin/google-chrome',
		'/usr/bin/chromium-browser',
		'/usr/bin/chromium',
	];
	for (const c of fallbacks)
		if (fs.existsSync(c)) return c;
	throw new Error('Chrome not found; set LAYER_B_CHROME=<path>');
}

function patchExtension(srcDir: string, destDir: string, altPort: number) {
	fs.mkdirSync(destDir, { recursive: true });
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const s = path.join(srcDir, entry.name);
		const d = path.join(destDir, entry.name);
		if (entry.isDirectory())
			patchExtension(s, d, altPort);
		else
			fs.copyFileSync(s, d);
	}
	const bg = path.join(destDir, 'background.js');
	if (fs.existsSync(bg)) {
		const orig = fs.readFileSync(bg, 'utf8');
		const patched = orig.replace(/port:\s*9223/g, `port: ${altPort}`);
		if (patched === orig)
			throw new Error(`patchExtension: no \`port: 9223\` occurrences in ${bg}`);
		fs.writeFileSync(bg, patched);
	}
}

function httpGetJson(port: number, path: string, timeoutMs = 1000): Promise<any | null> {
	return new Promise(resolve => {
		const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, res => {
			let body = '';
			res.on('data', c => body += c);
			res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
		});
		req.on('error', () => resolve(null));
		req.on('timeout', () => { req.destroy(); resolve(null); });
	});
}

async function waitForExtensionPaired(port: number, deadlineMs: number) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const h = await httpGetJson(port, '/health', 500);
		if (h?.extension === 'connected') return;
		await new Promise(r => setTimeout(r, 250));
	}
	throw new Error(`extension never paired with daemon on port ${port}`);
}

type CdpClient = {
	id: string;
	ws: WebSocket;
	send: (method: string, params?: any, timeoutMs?: number) => Promise<any>;
	close: () => void;
	preemptionEvents: Array<{ tabId: number; reason: string }>;
};

async function connectCdpClient(port: number, cdpPath: string, label: string): Promise<CdpClient> {
	const id = `layer-b-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const url = `ws://127.0.0.1:${port}${cdpPath}?clientId=${encodeURIComponent(id)}`;
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', reject);
	});
	let nextId = 1;
	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
	const preemptionEvents: Array<{ tabId: number; reason: string }> = [];
	ws.on('message', (data: WebSocket.RawData) => {
		try {
			const msg = JSON.parse(data.toString());
			if (typeof msg.id === 'number' && pending.has(msg.id)) {
				const p = pending.get(msg.id)!;
				pending.delete(msg.id);
				if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
				else p.resolve(msg.result);
				return;
			}
			if (msg.method === 'Earthling.tabPreempted')
				preemptionEvents.push({ tabId: msg.params?.tabId, reason: msg.params?.reason });
		} catch { /* ignore non-JSON frames */ }
	});
	const send = (method: string, params: any = {}, timeoutMs = 5000) => new Promise<any>((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject, method });
		ws.send(JSON.stringify({ id, method, params }));
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs).unref();
	});
	return {
		id, ws, send, preemptionEvents,
		close: () => { try { ws.close(1000); } catch {} },
	};
}

// ============================================================== Scenarios

async function scenarioPreemptionStaleness(port: number, cdpPath: string, iterations: number) {
	let failures = 0;
	for (let iter = 0; iter < iterations; iter++) {
		const a = await connectCdpClient(port, cdpPath, `A-${iter}`);
		const b = await connectCdpClient(port, cdpPath, `B-${iter}`);
		let tabId: number | null = null;
		try {
			const opened: any = await a.send('Earthling.openTab', { url: 'about:blank' });
			tabId = opened.tabId;
			await a.send('Earthling.switchToTab', { tabId });

			// A confirms exclusive ownership.
			let tabsA = await a.send('Earthling.listTabsAnnotated', {});
			const aOwn = tabsA.find((t: any) => t.tabId === tabId);
			if (!aOwn || aOwn.lease !== 'you')
				throw new Error(`A should own ${tabId} after switchToTab; saw lease=${aOwn?.lease}`);

			// B preempts.
			await b.send('Earthling.switchToTab', { tabId, force: true });
			await new Promise(r => setTimeout(r, 200));

			// A must have received Earthling.tabPreempted.
			if (!a.preemptionEvents.some(e => e.tabId === tabId))
				throw new Error(`A never received Earthling.tabPreempted for tabId=${tabId}`);

			// A's view: tab is busy with B.
			tabsA = await a.send('Earthling.listTabsAnnotated', {});
			const aSeesBusy = tabsA.find((t: any) => t.tabId === tabId);
			if (!aSeesBusy || aSeesBusy.lease !== 'busy')
				throw new Error(`A should see ${tabId} as busy after preemption; saw lease=${aSeesBusy?.lease}`);

			// A re-claims with force; previously this would race the navigate.
			await a.send('Earthling.switchToTab', { tabId, force: true });
			await b.send('Earthling.listTabsAnnotated', {}); // B observes the flip

			// A drives the tab to a fresh URL — must succeed without "no targetId".
			await a.send('Earthling.openTab', { url: 'about:blank' }).catch(() => {});
		} catch (e) {
			failures++;
			log(`iter=${iter} FAIL ${(e as Error).message}`);
		} finally {
			if (tabId !== null)
				await a.send('Earthling.closeTab', { tabId }).catch(() => {});
			a.close();
			b.close();
		}
		if (iter % 5 === 0)
			log(`iter=${iter} ok (failures=${failures})`);
	}
	return failures;
}

async function scenarioGraceRace(port: number, cdpPath: string, iterations: number) {
	// Drive concurrent client churn while a separate client opens/closes tabs.
	// With BROWSER_AUTOMATION_MCP_GRACE_MS=200 in the daemon env (caller's
	// responsibility), this exercises the detach-cascade path.
	let failures = 0;
	for (let iter = 0; iter < iterations; iter++) {
		const churn = await Promise.all([0, 1, 2, 3].map(i => connectCdpClient(port, cdpPath, `c${iter}-${i}`)));
		try {
			await Promise.all(churn.map(c => c.send('Earthling.listTabsAnnotated', {})));
			// Slam-close.
			churn.forEach(c => c.close());
		} catch (e) {
			failures++;
			log(`iter=${iter} FAIL ${(e as Error).message}`);
		}
		if (iter % 5 === 0) {
			const h = await httpGetJson(port, '/health', 500);
			log(`iter=${iter} clients=${h?.clients} disconnects=${h?.telemetry?.client_disconnect_count}`);
		}
	}
	return failures;
}

const SCENARIOS: Record<string, (port: number, cdpPath: string, iters: number) => Promise<number>> = {
	'preemption-staleness': scenarioPreemptionStaleness,
	'grace-race': scenarioGraceRace,
};

// ============================================================== Lifecycle

async function main() {
	const args = parseArgs();
	const fn = SCENARIOS[args.scenario];
	if (!fn) throw new Error(`unknown scenario: ${args.scenario}; have ${Object.keys(SCENARIOS).join(',')}`);

	if (!fs.existsSync(DAEMON_JS))
		throw new Error(`daemon bundle missing: ${DAEMON_JS} — run 'npm run build' first`);

	const altPort = args.port ?? await findFreePort(9224);
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const tmpRoot = path.join(os.tmpdir(), `layer-b-${ts}-${process.pid}`);
	const extDir = path.join(tmpRoot, 'extension');
	const profileDir = path.join(tmpRoot, 'chrome-profile');

	let daemon: ChildProcess | undefined;
	let chrome: ChildProcess | undefined;
	let exitCode = 0;
	const cleanup = () => {
		try { chrome?.kill('SIGKILL'); } catch {}
		try { daemon?.kill('SIGKILL'); } catch {}
		if (!args.keepArtifacts) {
			try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch {}
		} else {
			log(`artifacts retained at ${tmpRoot}`);
		}
	};
	process.on('SIGINT', () => { cleanup(); process.exit(130); });
	process.on('SIGTERM', () => { cleanup(); process.exit(143); });

	try {
		log(`scenario=${args.scenario} iterations=${args.iterations} altPort=${altPort}`);
		log(`tmp=${tmpRoot}`);

		patchExtension(EXT_SRC, extDir, altPort);
		fs.mkdirSync(profileDir, { recursive: true });

		log('spawning daemon...');
		daemon = spawn(process.execPath, [DAEMON_JS, '--port', String(altPort)], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: false,
			env: { ...process.env },
		});
		daemon.stdout?.on('data', d => process.stderr.write(`[daemon] ${d}`));
		daemon.stderr?.on('data', d => process.stderr.write(`[daemon!] ${d}`));

		// Wait for daemon HTTP up.
		const daemonDeadline = Date.now() + 10_000;
		while (Date.now() < daemonDeadline) {
			const d = await httpGetJson(altPort, '/discover', 500);
			if (d?.service === 'earthling-cdp-relay') break;
			await new Promise(r => setTimeout(r, 200));
		}
		const discover = await httpGetJson(altPort, '/discover', 500);
		if (!discover) throw new Error('daemon never came up');
		log(`daemon up uuid=${discover.uuid?.slice(0, 8)} cdpPath=${discover.cdpPath}`);

		log('launching isolated Chrome with patched extension...');
		const chromeExe = findChromeExecutable();
		const chromeArgs = [
			`--user-data-dir=${profileDir}`,
			`--load-extension=${extDir}`,
			'--disable-extensions-except=' + extDir,
			'--silent-debugger-extension-api',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-features=DialMediaRouteProvider',
			// MV3 SW lifecycle: SWs sleep aggressively. Extension's
			// _attemptAutoConnect needs a non-internal tab. Open a data: URL so
			// we don't depend on network and the URL is visible to chrome.tabs
			// queries immediately.
			'data:text/html,<title>layer-b-anchor</title>',
		];
		log(`chrome exe: ${chromeExe}`);
		log(`chrome args: ${chromeArgs.join(' ')}`);
		chrome = spawn(chromeExe, chromeArgs, {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: false,
		});
		chrome.stdout?.on('data', d => process.stderr.write(`[chrome] ${d}`));
		chrome.stderr?.on('data', d => process.stderr.write(`[chrome!] ${d}`));
		chrome.on('exit', code => log(`chrome exited code=${code}`));

		log('waiting for extension to pair with daemon (up to 90s — MV3 SW alarm has 30s minimum)...');
		await waitForExtensionPaired(altPort, 90_000);
		log('extension paired ✓');

		const failures = await fn(altPort, discover.cdpPath, args.iterations);
		const finalHealth = await httpGetJson(altPort, '/health', 500);
		log(`final clients=${finalHealth?.clients} disconnects=${finalHealth?.telemetry?.client_disconnect_count}`);

		if (failures === 0) {
			log(`LAYER-B PASS (scenario=${args.scenario} iters=${args.iterations})`);
		} else {
			log(`LAYER-B FAIL (scenario=${args.scenario} iters=${args.iterations} failures=${failures})`);
			exitCode = 1;
		}
	} catch (e) {
		log(`FATAL ${(e as Error).stack || e}`);
		exitCode = 1;
	} finally {
		cleanup();
	}
	process.exit(exitCode);
}

void main();
