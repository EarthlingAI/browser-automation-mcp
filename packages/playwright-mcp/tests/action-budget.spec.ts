/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Direct unit tests for the tool-layer timeout helpers introduced by the
// browser-automation-mcp fork (Phase A ProgressController hard ceiling +
// Phase B withActionBudget wrapper + MAX_TOOL_WAIT_MS cap).
//
// NOTE ON TEST HARNESS. The Playwright Test harness under this folder
// spawns the MCP server via `cli.js`, which resolves to the vendored
// `node_modules/playwright-core/lib/tools/...` — that copy does NOT
// receive fork changes in `src/`. The shipped product (`dist/index.js`,
// consumed by agents via `.mcp.json`) and the daemon entry
// (`dist/relay-daemon.js`, consumed by `scripts/concurrent-smoke.ts`)
// are the authoritative runtime. To exercise fork code, this spec
// imports helpers directly from `src/tools/backend/utils`, bypassing
// the MCP round-trip. End-to-end behaviour is covered by
// `smoke-concurrent` (daemon + src/) and Terra E2E (dist/).

import { test, expect } from '@playwright/test';
import { withActionBudget, assertWithinMaxTimeout, MAX_TOOL_WAIT_MS } from '../../../src/tools/backend/utils';

test('withActionBudget resolves the result when the callback completes within budget', async () => {
  const started = Date.now();
  const result = await withActionBudget('test.fast', async () => 'ok', 1_000);
  const elapsed = Date.now() - started;
  expect(result).toBe('ok');
  expect(elapsed).toBeLessThan(500);
});

test('withActionBudget throws with the snapshot-retry hint when the callback exceeds budget', async () => {
  const started = Date.now();
  let threw: Error | undefined;
  try {
    await withActionBudget('test.slow', () => new Promise(() => { /* never resolves */ }), 250);
  } catch (e) {
    threw = e as Error;
  }
  const elapsed = Date.now() - started;
  expect(threw).toBeInstanceOf(Error);
  expect(threw!.message).toMatch(/test\.slow exceeded 250ms budget/);
  expect(threw!.message).toMatch(/browser_snapshot/);
  expect(elapsed).toBeGreaterThanOrEqual(200);
  expect(elapsed).toBeLessThan(1_000);
});

test('withActionBudget error text reports the applied (clamped) budget', async () => {
  expect(MAX_TOOL_WAIT_MS).toBe(120_000);
  const started = Date.now();
  let threw: Error | undefined;
  try {
    await withActionBudget('test.clamped', () => new Promise(() => {}), 300);
  } catch (e) {
    threw = e as Error;
  }
  expect(threw!.message).toMatch(/test\.clamped exceeded 300ms budget/);
  expect(Date.now() - started).toBeLessThan(1_500);
});

test('assertWithinMaxTimeout rejects values over MAX_TOOL_WAIT_MS with a polling hint', () => {
  expect(() => assertWithinMaxTimeout('test.time', 200_000)).toThrow(/exceeds maximum of 120000ms/);
  expect(() => assertWithinMaxTimeout('test.time', 200_000)).toThrow(/polling pattern/);
});

test('assertWithinMaxTimeout is a no-op for values within the cap (including undefined)', () => {
  expect(assertWithinMaxTimeout('test.time', 30_000)).toBe(30_000);
  expect(assertWithinMaxTimeout('test.time', 120_000)).toBe(120_000);
  expect(assertWithinMaxTimeout('test.time', undefined)).toBeUndefined();
});
