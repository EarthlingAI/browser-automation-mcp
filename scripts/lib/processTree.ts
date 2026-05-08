/**
 * processTree.ts — cross-platform reapable child-process orchestration.
 *
 * The wedge-stab work spawns multiple Node MCP-backend subprocesses (and on
 * teardown each backend can fork chromium descendants via `playwright-core`).
 * The previous Layer-B harness `child.kill('SIGKILL')` reaped only the launcher,
 * leaving renderer/GPU children to leak — a 1h soak attempt left ~600 zombie
 * chromium processes pinning ~16 GB of RAM on Windows.
 *
 * Contract:
 *   - `killProcessTree(pid)` walks the entire descendant tree.
 *     Windows: `taskkill /F /T /PID <pid>`.
 *     Unix:    `process.kill(-pgid, signal)` (negative pid = process group).
 *   - `ProcessTracker` registers spawned children, reaps in reverse-spawn order
 *     so dependents shut down before their daemons.
 *   - `installSignalHandlers(tracker)` wires SIGINT/SIGTERM to `tracker.cleanup()`
 *     then exits 130/143 (the conventional WIFSIGNALED codes).
 *
 * Spawn-site contract:
 *   - Unix callers must spawn with `{ detached: true }` so process-group kill works.
 *   - Windows callers can use spawn defaults (`taskkill /T` walks the tree from PID).
 *   - Always `tracker.track(child, label)` before any `await` on the child;
 *     a Ctrl-C between spawn and track leaks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

const IS_WINDOWS = os.platform() === 'win32';

export interface KillOpts {
	signal?: NodeJS.Signals;
	timeoutMs?: number; // unix: time after SIGTERM before SIGKILL on the group
}

export async function killProcessTree(pid: number, opts: KillOpts = {}): Promise<void> {
	if (!Number.isFinite(pid) || pid <= 0) return;
	const { signal = 'SIGTERM', timeoutMs = 2_000 } = opts;
	if (IS_WINDOWS) {
		await new Promise<void>(resolve => {
			const k = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(); } };
			k.on('exit', finish);
			k.on('error', finish);
			setTimeout(finish, 5_000).unref();
		});
		return;
	}
	// Unix: pgid == leader pid when child was spawned with `detached:true`.
	try { process.kill(-pid, signal); } catch { /* gone already */ }
	if (signal === 'SIGKILL') return;
	await new Promise(r => setTimeout(r, timeoutMs));
	try { process.kill(-pid, 'SIGKILL'); } catch { /* gone already */ }
}

interface Entry { child: ChildProcess; label: string; }

export class ProcessTracker {
	private entries: Entry[] = [];
	private cleaningUp = false;

	track(child: ChildProcess, label: string): ChildProcess {
		this.entries.push({ child, label });
		child.once('exit', () => {
			this.entries = this.entries.filter(e => e.child !== child);
		});
		return child;
	}

	get size(): number { return this.entries.length; }

	async cleanup(opts: KillOpts = {}): Promise<void> {
		if (this.cleaningUp) return;
		this.cleaningUp = true;
		// Reverse-spawn order: dependents first, daemons last.
		const reversed = [...this.entries].reverse();
		for (const { child, label } of reversed) {
			if (child.pid && !child.killed && child.exitCode === null) {
				try { await killProcessTree(child.pid, opts); }
				catch (e) { console.error(`[processTree] cleanup of ${label} (pid=${child.pid}) failed:`, e); }
			}
		}
		this.entries = [];
		this.cleaningUp = false;
	}
}

export function installSignalHandlers(tracker: ProcessTracker, exitOnSignal = true): void {
	const handler = (signal: NodeJS.Signals) => {
		const code = signal === 'SIGINT' ? 130 : 143;
		void (async () => {
			await tracker.cleanup({ signal: 'SIGTERM', timeoutMs: 1_500 });
			if (exitOnSignal) process.exit(code);
		})();
	};
	process.once('SIGINT', () => handler('SIGINT'));
	process.once('SIGTERM', () => handler('SIGTERM'));
}

/**
 * Spawn a child registered with the tracker. Wraps `child_process.spawn` with
 * the per-platform invariants: Unix detached + new pgid; Windows defaults.
 */
export function trackedSpawn(
	tracker: ProcessTracker,
	label: string,
	cmd: string,
	args: readonly string[],
	opts: Parameters<typeof spawn>[2] = {},
): ChildProcess {
	const merged: Parameters<typeof spawn>[2] = {
		...opts,
		detached: !IS_WINDOWS && opts.detached !== false,
		windowsHide: opts.windowsHide ?? true,
	};
	const child = spawn(cmd, [...args], merged);
	tracker.track(child, label);
	return child;
}
