/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Unit test for the Context._pendingEvents bounded buffer — exercises
// addPendingEvent past the cap and asserts drainPendingEvents emits a
// single "N earlier events dropped" sentinel followed by the surviving
// tail, preserving FIFO order.

import { test, expect } from '@playwright/test';

import { Context } from '../../../src/tools/backend/context';

function makeContext(): Context {
	return new Context(null as any, { config: {}, cwd: process.cwd() } as any);
}

test('pending buffer caps at 50 and reports drops on drain', async () => {
	const ctx = makeContext();
	for (let i = 0; i < 60; i++)
		ctx.addPendingEvent(`event-${i}`);

	const drained = ctx.drainPendingEvents();

	// 50 survivors + 1 sentinel row prepended.
	expect(drained.length).toBe(51);
	expect(drained[0]).toBe('… 10 earlier events dropped');

	// Oldest surviving event is event-10; newest is event-59 (FIFO preserved).
	expect(drained[1]).toBe('event-10');
	expect(drained[drained.length - 1]).toBe('event-59');
});

test('pending buffer drains cleanly when under cap', async () => {
	const ctx = makeContext();
	for (let i = 0; i < 5; i++)
		ctx.addPendingEvent(`event-${i}`);

	const drained = ctx.drainPendingEvents();
	expect(drained.length).toBe(5);
	expect(drained[0]).toBe('event-0');
	expect(drained[4]).toBe('event-4');
});

test('drop counter resets between drains', async () => {
	const ctx = makeContext();
	for (let i = 0; i < 55; i++)
		ctx.addPendingEvent(`a-${i}`);
	const first = ctx.drainPendingEvents();
	expect(first[0]).toBe('… 5 earlier events dropped');

	// Second fill under the cap — no sentinel expected.
	for (let i = 0; i < 3; i++)
		ctx.addPendingEvent(`b-${i}`);
	const second = ctx.drainPendingEvents();
	expect(second.length).toBe(3);
	expect(second[0]).toBe('b-0');
});
