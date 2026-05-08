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
 * Earthling wedge-stab soak orchestrator.
 *
 * Runs Layer-A (concurrent-smoke / wedge-detector) and Layer-B
 * (preemption-staleness, grace-race) in a continuous ratchet for a
 * configurable wall-clock budget. Each round is a single named scenario.
 * On any non-zero exit, the failure is logged and the soak continues —
 * the rationale is that one transient flake should not bring down a 4h
 * run. A summary at termination prints round counts and the failing
 * round indices.
 *
 * Wall-clock cap: SOAK_HOURS env (default 0.5). Hard ceiling 8h.
 * Output dir: outputs/wedge-stab/<ts>/.
 *
 * Termination: clean exit on budget; SIGINT/SIGTERM also writes a final
 * summary so a user-driven Ctrl-C produces useful output.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(REPO_ROOT, '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'outputs', 'wedge-stab');

type Scenario = {
	name: string;
	cmd: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	timeoutMs: number;
};

const SCENARIOS: Scenario[] = [
	{
		name: 'concurrent-smoke-lease-churn',
		cmd: 'npx',
		args: ['tsx', 'scripts/concurrent-smoke.ts'],
		env: { MODE: 'lease-churn', ITERATIONS: '200' },
		timeoutMs: 60_000,
	},
	{
		name: 'wedge-detector-30',
		cmd: 'npx',
		args: ['tsx', 'scripts/wedge-detector.ts'],
		env: { ITERATIONS: '30' },
		timeoutMs: 60_000,
	},
	{
		name: 'layer-b-preemption-staleness-30',
		cmd: 'npx',
		args: ['tsx', 'scripts/layer-b-driver.ts'],
		env: { SCENARIO: 'preemption-staleness', ITERATIONS: '30' },
		timeoutMs: 180_000,
	},
	{
		name: 'layer-b-grace-race-30',
		cmd: 'npx',
		args: ['tsx', 'scripts/layer-b-driver.ts'],
		env: { SCENARIO: 'grace-race', ITERATIONS: '30' },
		timeoutMs: 120_000,
	},
];

type RoundResult = {
	round: number;
	scenario: string;
	startedAt: number;
	durationMs: number;
	exitCode: number | null;
	failed: boolean;
	logTail: string;
};

function nowIso() { return new Date().toISOString(); }

function logTail(buf: string, lines = 8): string {
	const arr = buf.split('\n').filter(Boolean);
	return arr.slice(-lines).join('\n');
}

async function runOnce(s: Scenario): Promise<{ exitCode: number | null; durationMs: number; output: string }> {
	const startedAt = Date.now();
	let stdout = '';
	let stderr = '';
	const exitCode = await new Promise<number | null>(resolve => {
		const child = spawn(s.cmd, s.args, {
			cwd: REPO_ROOT,
			env: { ...process.env, ...(s.env || {}) },
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			shell: os.platform() === 'win32',
		});
		const killTimer = setTimeout(() => {
			try { child.kill('SIGKILL'); } catch {}
		}, s.timeoutMs);
		child.stdout?.on('data', d => { stdout += d; });
		child.stderr?.on('data', d => { stderr += d; });
		child.on('exit', code => {
			clearTimeout(killTimer);
			resolve(code);
		});
		child.on('error', () => resolve(null));
	});
	return { exitCode, durationMs: Date.now() - startedAt, output: stdout + (stderr ? '\nSTDERR:\n' + stderr : '') };
}

async function main() {
	const hoursRaw = parseFloat(process.env.SOAK_HOURS || '0.5');
	const hours = Math.min(Math.max(hoursRaw, 0.05), 8);
	const budgetMs = hours * 3_600_000;

	const ts = nowIso().replace(/[:.]/g, '-');
	const outDir = path.join(OUTPUT_DIR, `soak-${ts}`);
	fs.mkdirSync(outDir, { recursive: true });
	const summaryPath = path.join(outDir, 'summary.md');
	const ndjsonPath = path.join(outDir, 'rounds.ndjson');
	const ndjsonStream = fs.createWriteStream(ndjsonPath, { flags: 'a' });

	process.stdout.write(`soak start ${nowIso()} budget=${hours}h outDir=${outDir}\n`);

	const results: RoundResult[] = [];
	const startedAt = Date.now();
	let stop = false;
	const onSignal = () => { stop = true; };
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	let round = 0;
	while (!stop && (Date.now() - startedAt) < budgetMs) {
		const scenario = SCENARIOS[round % SCENARIOS.length];
		round++;
		const startedAtRound = Date.now();
		process.stdout.write(`[round ${round}] ${scenario.name} ... `);
		const { exitCode, durationMs, output } = await runOnce(scenario);
		const failed = exitCode !== 0;
		const tail = logTail(output, 6);
		const result: RoundResult = {
			round, scenario: scenario.name, startedAt: startedAtRound,
			durationMs, exitCode, failed, logTail: tail,
		};
		results.push(result);
		ndjsonStream.write(JSON.stringify({ ...result, output: undefined }) + '\n');
		// Keep full log for failed rounds.
		if (failed) {
			const logPath = path.join(outDir, `round-${round}-${scenario.name}.log`);
			fs.writeFileSync(logPath, output);
			process.stdout.write(`FAIL exit=${exitCode} dur=${durationMs}ms log=${path.basename(logPath)}\n`);
		} else {
			process.stdout.write(`pass dur=${durationMs}ms\n`);
		}
	}

	const elapsedMs = Date.now() - startedAt;
	const passed = results.filter(r => !r.failed).length;
	const failed = results.filter(r => r.failed).length;
	const perScenario = SCENARIOS.map(s => {
		const subset = results.filter(r => r.scenario === s.name);
		return {
			name: s.name,
			rounds: subset.length,
			passed: subset.filter(r => !r.failed).length,
			failed: subset.filter(r => r.failed).length,
		};
	});
	const failingRounds = results.filter(r => r.failed).map(r => `${r.round}:${r.scenario}(exit=${r.exitCode})`);

	const summary = `# wedge-stab soak summary

- Started: ${new Date(startedAt).toISOString()}
- Ended:   ${nowIso()}
- Wall:    ${(elapsedMs / 60000).toFixed(2)} min (budget ${hours}h)
- Rounds:  ${round} (passed=${passed} failed=${failed})

## Per-scenario

${perScenario.map(p => `- ${p.name}: ${p.passed}/${p.rounds} pass`).join('\n')}

## Failing rounds

${failingRounds.length === 0 ? '_none_' : failingRounds.map(f => `- ${f}`).join('\n')}

## Verdict

${failed === 0 ? 'PASS — no scenario regressions across the soak window.' : `FAIL — ${failed}/${round} rounds non-zero. See round-*.log files.`}
`;

	fs.writeFileSync(summaryPath, summary);
	ndjsonStream.end();
	process.stdout.write(`\n${summary}\n`);
	process.stdout.write(`outDir=${outDir}\n`);
	process.exit(failed === 0 ? 0 : 1);
}

void main();
