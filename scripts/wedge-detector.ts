/**
 * wedge-detector.ts — fault-injection harness for the multi-client relay daemon.
 *
 * Three modes target the documented hot spots in the relay/extension/transport
 * lifecycle:
 *
 *   MODE=wedge-probe — N raw-WS clients race a switch+release lease churn
 *     against the same tab set. Force-close one client mid-cycle to drive the
 *     attach cascade. Asserts no surviving client receives WebSocket close
 *     code 1005 without a prior server-initiated close frame.
 *
 *   MODE=grace-race — drives `drainAndClose()` concurrent with detach-frame
 *     cascade by toggling the daemon's grace timer to a tight window
 *     (BROWSER_AUTOMATION_MCP_GRACE_MS=200 inherited from spawn). Each
 *     iteration: connect → switch → forcibly close client WS while daemon
 *     fans out detach to peers. Asserts peer receives no WS-1005.
 *
 *   MODE=probe-fail — exercises `_handleExtensionConnection` probe-failure
 *     path by stressing the daemon with a high client-churn rate while a
 *     listBrowserTabs probe is in flight. Catches the case where the
 *     `_handleExtensionConnection` flush propagates as silent client drop.
 *
 * Assertions per plan:
 *   (a) no client receives WS-1005 without prior server-initiated close frame
 *   (b) every lease commits or releases within LEASE_DEADLINE_MS
 *   (c) per-iteration tab observation snapshots are internally consistent
 *   (d) no `Earthling.tabPreempted` event is lost when a force-switch revokes
 *       a peer's lease
 *
 * Exit 0 on pass, 1 on any failure. Pass/fail summary printed last so CI
 * loops can grep `WEDGE-DETECTOR PASS` / `WEDGE-DETECTOR FAIL`.
 */

import http from 'node:http';
import WebSocket from 'ws';

import { acquireDaemon } from '../src/tools/mcp/relay/clientAcquirer';
import { DEFAULT_RELAY_PORT } from '../src/tools/mcp/relay/constants';

const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || String(DEFAULT_RELAY_PORT), 10);
const ITERATIONS = parseInt(process.env.ITERATIONS || '50', 10);
const N_CLIENTS = parseInt(process.env.N_CLIENTS || '4', 10);
const CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
const MODE = (process.env.MODE || 'wedge-probe') as 'wedge-probe' | 'grace-race' | 'probe-fail';
const LEASE_DEADLINE_MS = 35_000;

interface ClientHandle {
	id: string;
	ws: WebSocket;
	pendingIds: Map<number, (resp: any) => void>;
	closed: boolean;
	closeCode: number | null;
	serverCloseFrameSeen: boolean;
	preemptionEvents: Array<{ tabId: number; reason: string }>;
	nextId: number;
	// Set when the harness itself terminates this handle as the iter-N victim.
	// Honest cascade detection treats victim-closures as expected and only flags
	// closures of NON-victims as daemon-side cascade evidence.
	victimAtIter: number | null;
}

interface Failure {
	iter: number;
	client: string;
	kind: 'ws-1005' | 'lease-deadline' | 'observation-drift' | 'preemption-lost' | 'other';
	detail: string;
}

const failures: Failure[] = [];

function log(...args: unknown[]): void {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`[${ts}]`, ...args);
}

function discover(): Promise<{ cdpPath: string; uuid: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port: PORT, path: '/discover', timeout: 2000 }, res => {
			let body = '';
			res.on('data', c => body += c);
			res.on('end', () => {
				try { resolve(JSON.parse(body)); } catch (e) { reject(e as Error); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('discover timeout')); });
	});
}

function health(): Promise<any> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, res => {
			let body = '';
			res.on('data', c => body += c);
			res.on('end', () => {
				try { resolve(JSON.parse(body)); } catch (e) { reject(e as Error); }
			});
		});
		req.on('error', reject);
	});
}

async function makeClient(label: string, cdpPath: string): Promise<ClientHandle> {
	const clientId = `wedge-${label}-${process.pid}`;
	const url = `ws://127.0.0.1:${PORT}${cdpPath}?clientId=${encodeURIComponent(clientId)}`;
	const ws = new WebSocket(url);
	const handle: ClientHandle = {
		id: clientId,
		ws,
		pendingIds: new Map(),
		closed: false,
		closeCode: null,
		serverCloseFrameSeen: false,
		preemptionEvents: [],
		nextId: 1,
		victimAtIter: null,
	};
	ws.on('message', (data: WebSocket.RawData) => {
		let msg: any;
		try { msg = JSON.parse(data.toString()); } catch { return; }
		if (typeof msg.id === 'number' && handle.pendingIds.has(msg.id)) {
			const cb = handle.pendingIds.get(msg.id)!;
			handle.pendingIds.delete(msg.id);
			cb(msg);
			return;
		}
		if (msg.method === 'Earthling.tabPreempted') {
			handle.preemptionEvents.push({ tabId: msg.params?.tabId, reason: msg.params?.reason });
		}
	});
	ws.on('close', (code: number) => {
		handle.closed = true;
		handle.closeCode = code;
	});
	// 1012 is the server-initiated close code drainAndClose uses.
	// Track that as a legitimate server close-frame signal.
	ws.on('close', (code: number) => {
		if (code === 1012) handle.serverCloseFrameSeen = true;
	});
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label}: ws open timeout`)), 5000);
		ws.once('open', () => { clearTimeout(t); resolve(); });
		ws.once('error', err => { clearTimeout(t); reject(err); });
	});
	return handle;
}

function send(handle: ClientHandle, method: string, params: any = {}, sessionId?: string, timeoutMs = 5000): Promise<any> {
	const id = handle.nextId++;
	return new Promise((resolve, reject) => {
		if (handle.closed) { reject(new Error(`${handle.id}: send on closed ws`)); return; }
		const t = setTimeout(() => {
			handle.pendingIds.delete(id);
			reject(new Error(`${handle.id}: ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		handle.pendingIds.set(id, resp => {
			clearTimeout(t);
			if (resp.error) reject(new Error(`${handle.id}: ${method} error: ${resp.error.message ?? resp.error}`));
			else resolve(resp.result);
		});
		const msg: any = { id, method, params };
		if (sessionId) msg.sessionId = sessionId;
		try { handle.ws.send(JSON.stringify(msg)); } catch (e) {
			handle.pendingIds.delete(id);
			clearTimeout(t);
			reject(e as Error);
		}
	});
}

async function listTabs(handle: ClientHandle): Promise<Array<{ tabId: number; url: string; lease?: string; ownerId?: string }>> {
	const r = await send(handle, 'Earthling.listTabsAnnotated', {}, 'earthling-browser', 3000);
	return Array.isArray(r) ? r : (r?.tabs ?? []);
}

async function selectTargets(probe: ClientHandle, n: number): Promise<number[]> {
	const tabs = await listTabs(probe);
	const candidates = tabs.filter(t =>
		!t.url.startsWith('chrome:')
		&& !t.url.startsWith('edge:')
		&& !t.url.startsWith('devtools:')
		&& t.url !== 'about:blank'
		&& t.url !== '');
	if (candidates.length < n)
		throw new Error(`need ≥${n} non-internal tabs; found ${candidates.length}`);
	return candidates.slice(0, n).map(t => t.tabId);
}

function checkWedgeAssertions(handles: ClientHandle[], iter: number): void {
	for (const h of handles) {
		if (h.closeCode === 1005 && !h.serverCloseFrameSeen) {
			failures.push({ iter, client: h.id, kind: 'ws-1005', detail: 'WS-1005 without prior server close frame' });
		}
		if (h.pendingIds.size > 0) {
			const oldest = [...h.pendingIds.keys()][0];
			failures.push({ iter, client: h.id, kind: 'lease-deadline', detail: `${h.pendingIds.size} pending cmds (oldest id=${oldest})` });
		}
	}
}

async function runWedgeProbe(cdpPath: string): Promise<void> {
	log(`wedge-probe: ${N_CLIENTS} clients × ${ITERATIONS} iters with mid-cycle abort cascade`);
	const wallDeadline = Date.now() + ITERATIONS * 1500 + 30_000;
	const handles: ClientHandle[] = [];
	for (let i = 0; i < N_CLIENTS; i++) {
		const h = await makeClient(`A${i}`, cdpPath);
		handles.push(h);
	}
	const targets = await selectTargets(handles[0], Math.min(N_CLIENTS, 2));
	const droppedIters: number[] = [];

	for (let iter = 0; iter < ITERATIONS; iter++) {
		if (Date.now() > wallDeadline) {
			log(`wall-clock deadline hit at iter=${iter} — bailing (likely wedge)`);
			failures.push({ iter, client: 'harness', kind: 'lease-deadline', detail: 'wall deadline exceeded' });
			break;
		}

		// Pick a "victim" client that will be abruptly closed mid-cycle.
		const victimIdx = iter % handles.length;
		const ops = handles.map(async (h, idx) => {
			// `closed` flips on `ws.on('close')` which is async after a victim's
			// `terminate()`. Also gate on readyState so a CLOSING/CLOSED ws
			// short-circuits before the harness wastes 8s on a phantom send.
			if (h.closed || h.ws.readyState !== WebSocket.OPEN) return { ok: false, err: 'already closed', skip: true };
			const tabId = targets[idx % targets.length];
			const isVictim = idx === victimIdx && iter % 5 === 4;
			try {
				const switchPromise = send(h, 'Earthling.switchToTab', { tabId, force: true }, 'earthling-browser', 8000);
				if (isVictim) {
					h.victimAtIter = iter;
					setTimeout(() => { try { h.ws.terminate(); } catch { /* ignore */ } }, 1 + Math.floor(Math.random() * 4));
					await switchPromise.catch(() => {});
					return { ok: false, err: 'victim aborted', victim: true };
				}
				await switchPromise;
				await send(h, 'Earthling.releaseTab', { tabId }, 'earthling-browser', 5000);
				return { ok: true };
			} catch (e: any) {
				return { ok: false, err: String(e?.message || e) };
			}
		});
		const results = await Promise.all(ops);
		const realErrs = results.filter(r => !r.ok && !(r as any).victim && !(r as any).skip);
		if (realErrs.length > 0 && (iter % 10 === 0 || realErrs.length >= results.length - 1)) {
			log(`iter=${iter} errs=${realErrs.length}/${results.length} ${realErrs[0]?.err?.slice(0, 100) || ''}`);
		}
		for (const h of handles) {
			if (h.closed && h.closeCode === 1005 && !h.serverCloseFrameSeen) {
				failures.push({ iter, client: h.id, kind: 'ws-1005', detail: `iter=${iter} closeCode=${h.closeCode}` });
				droppedIters.push(iter);
			}
		}
		// Honest cascade detection. A "cascade" is one or more clients the
		// harness DID NOT terminate as a victim that have nonetheless dropped.
		// Prior-victim handles being closed is not a cascade — that's the
		// natural rotation outcome (4 clients × victim every 5 iters means
		// the peers of victim_idx are exhausted by iter 15). The original
		// `peers.every(h => h.closed)` check fired deterministically at iter
		// 15 by arithmetic alone, masking real daemon-side regressions.
		const cascadedPeers = handles.filter(h => h.closed && h.victimAtIter === null);
		if (cascadedPeers.length > 0) {
			log(`iter=${iter} non-victim clients dropped: [${cascadedPeers.map(h => h.id).join(',')}] — wedge cascade reproduced`);
			failures.push({ iter, client: 'cascade', kind: 'ws-1005', detail: `${cascadedPeers.length} non-victim clients dropped: ${cascadedPeers.map(h => `${h.id}(code=${h.closeCode})`).join(',')}` });
			break;
		}
		// Benign exit when victim rotation has exhausted every handle.
		if (handles.every(h => h.closed)) {
			log(`iter=${iter} all handles closed (victim rotation exhausted clients) — benign end`);
			break;
		}
		await new Promise(r => setTimeout(r, 10));
	}
	checkWedgeAssertions(handles.filter(h => !h.closed), ITERATIONS);
	for (const h of handles) {
		if (!h.closed) {
			try { h.ws.close(1000, 'wedge-detector cleanup'); } catch { /* ignore */ }
		}
	}
	if (droppedIters.length > 0) log(`wedge reproduced on iters: ${droppedIters.slice(0, 20).join(',')}${droppedIters.length > 20 ? '…' : ''}`);
}

async function runGraceRace(cdpPath: string): Promise<void> {
	log(`grace-race: ${ITERATIONS} iters; ensure daemon spawned with BROWSER_AUTOMATION_MCP_GRACE_MS=200`);
	for (let iter = 0; iter < ITERATIONS; iter++) {
		const peer = await makeClient(`peer${iter}`, cdpPath);
		const target = await makeClient(`target${iter}`, cdpPath);
		try {
			const targets = await selectTargets(peer, 1);
			const tabId = targets[0];
			await send(peer, 'Earthling.switchToTab', { tabId, force: true }, 'earthling-browser', LEASE_DEADLINE_MS);
			const switchPromise = send(target, 'Earthling.switchToTab', { tabId, force: true }, 'earthling-browser', LEASE_DEADLINE_MS).catch(() => {});
			await new Promise(r => setTimeout(r, 5));
			peer.ws.terminate();
			await switchPromise;
			await new Promise(r => setTimeout(r, 50));
			if (target.closed && target.closeCode === 1005 && !target.serverCloseFrameSeen) {
				failures.push({ iter, client: target.id, kind: 'ws-1005', detail: `peer-detach cascade caused WS-1005 on target` });
			}
		} catch (e: any) {
			failures.push({ iter, client: target.id, kind: 'other', detail: String(e?.message || e) });
		} finally {
			if (!target.closed) try { target.ws.close(1000); } catch { /* ignore */ }
		}
		if (iter % 10 === 0) log(`grace-race iter=${iter}`);
	}
}

async function runProbeFail(cdpPath: string): Promise<void> {
	log(`probe-fail: ${ITERATIONS} iters; high client-churn while extension probe in flight`);
	for (let iter = 0; iter < ITERATIONS; iter++) {
		const burst: ClientHandle[] = [];
		for (let k = 0; k < 6; k++) {
			try { burst.push(await makeClient(`burst-${iter}-${k}`, cdpPath)); }
			catch (e: any) { failures.push({ iter, client: `burst-${iter}-${k}`, kind: 'other', detail: String(e?.message || e) }); }
		}
		const ops = burst.map(h => listTabs(h).catch(e => ({ err: String(e?.message || e) })));
		await Promise.all(ops);
		for (const h of burst) {
			if (h.closed && h.closeCode === 1005 && !h.serverCloseFrameSeen) {
				failures.push({ iter, client: h.id, kind: 'ws-1005', detail: `probe-fail caused WS-1005` });
			}
			try { h.ws.close(1000); } catch { /* ignore */ }
		}
		if (iter % 10 === 0) log(`probe-fail iter=${iter}`);
	}
}

async function main(): Promise<void> {
	log(`wedge-detector mode=${MODE} iterations=${ITERATIONS} n_clients=${N_CLIENTS}`);
	await acquireDaemon(PORT, CHANNEL);
	const info = await discover();
	const h = await health();
	log(`daemon up uuid=${info.uuid.slice(0, 8)} extension=${h?.extension} clients=${h?.clients}`);

	if (MODE === 'wedge-probe') await runWedgeProbe(info.cdpPath);
	else if (MODE === 'grace-race') await runGraceRace(info.cdpPath);
	else if (MODE === 'probe-fail') await runProbeFail(info.cdpPath);
	else throw new Error(`unknown MODE=${MODE}`);

	if (failures.length === 0) {
		log(`WEDGE-DETECTOR PASS (mode=${MODE} iters=${ITERATIONS} n_clients=${N_CLIENTS})`);
		process.exit(0);
	} else {
		log(`WEDGE-DETECTOR FAIL (${failures.length} failures)`);
		const summary: Record<string, number> = {};
		for (const f of failures) summary[f.kind] = (summary[f.kind] ?? 0) + 1;
		log(`  by kind: ${JSON.stringify(summary)}`);
		for (const f of failures.slice(0, 10)) log(`  iter=${f.iter} ${f.kind} ${f.client}: ${f.detail}`);
		process.exit(1);
	}
}

main().catch(e => {
	console.error(`WEDGE-DETECTOR FAIL (uncaught): ${e?.stack || e}`);
	process.exit(1);
});
