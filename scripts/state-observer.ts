/**
 * state-observer.ts — passive read-only health probe of the live 9223 daemon.
 *
 * Connects to the daemon as a *passive* client: never acquires a lease, never
 * sends `Earthling.*` commands. Polls `/health` every 2s and tails
 * `.runtime/debug/daemon.jsonl` for anomaly patterns:
 *
 *   - extCallbacks > 5                     (extension callback table backed up)
 *   - leasesPending > 1 sustained for 5s+  (commit-vs-cancel deadlock signal)
 *   - any `callExtensionDirect.timeout`    (extension-side timeout fired)
 *   - any `lease.pending.sweep.fired`      (sweepExpiredPending evicted entries)
 *   - clients high-water rising            (stuck connections)
 *
 * Runs alongside Phase-2 wedge reproductions (in another tool window) so the
 * trace excerpts the implementer attaches to repro-status.md are scoped to
 * the actual contention window. Output: one-line console pings + a markdown
 * summary at `outputs/wedge-stab/<ts>/state-observer.md` on exit.
 *
 * Usage:
 *   npx tsx scripts/state-observer.ts                # runs 5 minutes
 *   npx tsx scripts/state-observer.ts --duration 30s
 *   npx tsx scripts/state-observer.ts --duration 10m --label dual-agent-wedge
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ProcessTracker, installSignalHandlers } from './lib/processTree';

const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(REPO_ROOT, '..', '..');
const DAEMON_JSONL = path.join(REPO_ROOT, '.runtime', 'debug', 'daemon.jsonl');
const PORT = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || '9223', 10);

interface Anomaly { ts: number; kind: string; detail: string; }

interface RunSummary {
	startedAt: number;
	endedAt: number;
	port: number;
	durationMs: number;
	healthPolls: number;
	healthFailures: number;
	jsonlLinesScanned: number;
	jsonlOffsetStart: number;
	jsonlOffsetEnd: number;
	highWater: { clients: number; pendingCmds: number; extCallbacks: number; leasesPending: number };
	anomalies: Anomaly[];
	label: string;
}

function parseDuration(arg: string): number {
	const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(arg.trim());
	if (!m) throw new Error(`bad --duration ${arg}`);
	const n = parseInt(m[1], 10);
	const unit = (m[2] || 's').toLowerCase();
	const mult: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
	return n * mult[unit];
}

function getArg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1 || i + 1 >= process.argv.length) return fallback;
	return process.argv[i + 1];
}

function ts(): string { return new Date().toISOString().slice(11, 23); }

function httpGet(urlPath: string, timeoutMs = 2_000): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, timeout: timeoutMs }, res => {
			let buf = '';
			res.on('data', c => buf += c);
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error(`http ${urlPath} timeout`)); });
	});
}

class JsonlTailer {
	offset = 0;
	private leaseHighStart: Map<number, number> = new Map();

	constructor(private path: string) {
		try {
			const stat = fs.statSync(this.path);
			this.offset = stat.size;
		} catch { /* file may not exist yet */ }
	}

	scan(onAnomaly: (a: Anomaly) => void): { lines: number; latest?: Record<string, unknown> } {
		let stat: fs.Stats;
		try { stat = fs.statSync(this.path); }
		catch { return { lines: 0 }; }
		if (stat.size === this.offset) return { lines: 0 };
		// Handle rotation/truncation.
		if (stat.size < this.offset) this.offset = 0;
		const fd = fs.openSync(this.path, 'r');
		try {
			const len = stat.size - this.offset;
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, this.offset);
			this.offset += len;
			const text = buf.toString('utf8');
			const lines = text.split('\n').filter(Boolean);
			let latest: Record<string, unknown> | undefined;
			for (const line of lines) {
				let obj: Record<string, unknown>;
				try { obj = JSON.parse(line); }
				catch { continue; }
				const evt = obj.event as string | undefined;
				const detail = (obj.detail || {}) as Record<string, unknown>;
				const tsv = (obj.ts as number) || Date.now();
				if (evt === 'daemon.snapshot') {
					latest = obj;
					const lp = Number(detail.leasesPending || 0);
					const ec = Number(detail.extCallbacks || 0);
					if (ec > 5) onAnomaly({ ts: tsv, kind: 'extCallbacks-high', detail: `extCallbacks=${ec}` });
					if (lp > 1) {
						if (!this.leaseHighStart.has(lp)) this.leaseHighStart.set(lp, tsv);
						const since = this.leaseHighStart.get(lp)!;
						if (tsv - since > 5_000) {
							onAnomaly({ ts: tsv, kind: 'leasesPending-stuck', detail: `leasesPending=${lp} sustained ${tsv - since}ms` });
							this.leaseHighStart.delete(lp);
						}
					} else {
						this.leaseHighStart.clear();
					}
				} else if (evt === 'callExtensionDirect.timeout') {
					onAnomaly({ ts: tsv, kind: 'callExtensionDirect.timeout', detail: JSON.stringify(detail).slice(0, 200) });
				} else if (evt === 'lease.pending.sweep.fired') {
					onAnomaly({ ts: tsv, kind: 'lease.pending.sweep.fired', detail: JSON.stringify(detail).slice(0, 200) });
				} else if (evt === 'callExtensionDirect.error') {
					onAnomaly({ ts: tsv, kind: 'callExtensionDirect.error', detail: JSON.stringify(detail).slice(0, 200) });
				}
			}
			return { lines: lines.length, latest };
		} finally {
			fs.closeSync(fd);
		}
	}
}

async function main(): Promise<void> {
	const tracker = new ProcessTracker();
	installSignalHandlers(tracker, false);

	const durationStr = getArg('duration', '5m')!;
	const durationMs = parseDuration(durationStr);
	const label = getArg('label', 'observe');

	const probe = await httpGet('/discover').catch(e => ({ status: 0, body: String(e) }));
	if (probe.status !== 200) {
		console.error(`[state-observer] FAIL — daemon /discover not reachable on 127.0.0.1:${PORT} (${probe.status} ${probe.body.slice(0, 120)})`);
		console.error('Open the user\'s Chrome with the Earthling Browser Bridge extension installed; the extension auto-spawns the daemon.');
		process.exit(2);
	}
	const discover = JSON.parse(probe.body);
	console.log(`[${ts()}] state-observer — daemon pid=${discover.pid} uuid=${String(discover.uuid).slice(0, 8)} duration=${durationStr} label=${label}`);

	const tsStamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outDir = path.join(PROJECT_ROOT, 'outputs', 'wedge-stab', `observe-${tsStamp}`);
	fs.mkdirSync(outDir, { recursive: true });
	const summaryPath = path.join(outDir, `state-observer-${label}.md`);

	const tailer = new JsonlTailer(DAEMON_JSONL);
	const anomalies: Anomaly[] = [];
	const seenAnomalyKey = new Set<string>();
	const summary: RunSummary = {
		startedAt: Date.now(), endedAt: 0, port: PORT, durationMs: 0,
		healthPolls: 0, healthFailures: 0,
		jsonlLinesScanned: 0, jsonlOffsetStart: tailer.offset, jsonlOffsetEnd: 0,
		highWater: { clients: 0, pendingCmds: 0, extCallbacks: 0, leasesPending: 0 },
		anomalies, label: label!,
	};

	const onAnomaly = (a: Anomaly) => {
		const key = `${a.kind}|${a.detail.slice(0, 80)}`;
		if (seenAnomalyKey.has(key)) return;
		seenAnomalyKey.add(key);
		anomalies.push(a);
		console.log(`[${ts()}] ANOMALY ${a.kind}: ${a.detail}`);
	};

	const deadline = Date.now() + durationMs;
	while (Date.now() < deadline) {
		summary.healthPolls++;
		try {
			const h = await httpGet('/health');
			if (h.status !== 200) summary.healthFailures++;
			else {
				const obj = JSON.parse(h.body) as Record<string, unknown>;
				const c = Number(obj.clients || 0);
				if (c > summary.highWater.clients) summary.highWater.clients = c;
			}
		} catch { summary.healthFailures++; }

		const scan = tailer.scan(onAnomaly);
		summary.jsonlLinesScanned += scan.lines;
		if (scan.latest) {
			const detail = (scan.latest.detail || {}) as Record<string, number>;
			summary.highWater.pendingCmds = Math.max(summary.highWater.pendingCmds, Number(detail.pendingCmds_high_water || detail.pendingCmds || 0));
			summary.highWater.extCallbacks = Math.max(summary.highWater.extCallbacks, Number(detail.extCallbacks_high_water || detail.extCallbacks || 0));
			summary.highWater.leasesPending = Math.max(summary.highWater.leasesPending, Number(detail.leasesPending || 0));
		}
		await new Promise(r => setTimeout(r, 2_000));
	}

	summary.endedAt = Date.now();
	summary.durationMs = summary.endedAt - summary.startedAt;
	summary.jsonlOffsetEnd = tailer.offset;

	const md = renderSummary(summary);
	fs.writeFileSync(summaryPath, md);
	console.log(`[${ts()}] wrote ${summaryPath}`);
	console.log(`[${ts()}] anomalies=${anomalies.length} highWater=${JSON.stringify(summary.highWater)}`);
	process.exit(0);
}

function renderSummary(s: RunSummary): string {
	const lines: string[] = [];
	lines.push(`# state-observer summary — ${s.label}`);
	lines.push('');
	lines.push(`- Started:  ${new Date(s.startedAt).toISOString()}`);
	lines.push(`- Ended:    ${new Date(s.endedAt).toISOString()}`);
	lines.push(`- Duration: ${(s.durationMs / 1000).toFixed(1)}s`);
	lines.push(`- Daemon port: ${s.port}`);
	lines.push(`- Health polls: ${s.healthPolls} (failures: ${s.healthFailures})`);
	lines.push(`- daemon.jsonl scanned: ${s.jsonlLinesScanned} lines (offset ${s.jsonlOffsetStart} → ${s.jsonlOffsetEnd})`);
	lines.push('');
	lines.push('## High-water marks');
	lines.push('');
	lines.push(`- clients:        ${s.highWater.clients}`);
	lines.push(`- pendingCmds:    ${s.highWater.pendingCmds}`);
	lines.push(`- extCallbacks:   ${s.highWater.extCallbacks}`);
	lines.push(`- leasesPending:  ${s.highWater.leasesPending}`);
	lines.push('');
	lines.push(`## Anomalies (${s.anomalies.length})`);
	lines.push('');
	if (s.anomalies.length === 0) {
		lines.push('_none_');
	} else {
		for (const a of s.anomalies) {
			lines.push(`- \`${new Date(a.ts).toISOString()}\` **${a.kind}** — ${a.detail}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

main().catch(e => { console.error('[state-observer] FAIL:', e?.stack || e); process.exit(1); });
