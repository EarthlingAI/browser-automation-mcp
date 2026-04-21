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

import type * as playwright from 'playwright-core';
import type { Tab } from './tab';

import { raceAgainstDeadline } from '../../utils/isomorphic/timeoutRunner';
import { monotonicTime } from '../../utils/isomorphic/time';

/**
 * Maximum wait/timeout any tool argument may request. Past this, agents
 * should use polling patterns (repeated list-then-check calls).
 */
export const MAX_TOOL_WAIT_MS = 120_000;

/**
 * Race an async operation against a timeout budget, resolving to a
 * `{ result, timedOut }` pair. On timeout, returns the supplied fallback
 * (or the result of the fallback factory) in the `result` slot. Never
 * throws for timeout.
 *
 * Primary use-cases in this codebase:
 *   - post-action snapshot capture with a sentinel on timeout
 *   - relay-layer `Earthling.*` CDP calls with per-method budgets
 *   - page.title()/headerSnapshot races against wedged pages
 */
export async function withTimeoutMarker<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  fallback: T | (() => T),
): Promise<{ result: T, timedOut: boolean }> {
  void label; // label is preserved in signature for logging at call sites
  const outcome = await raceAgainstDeadline<T>(fn, monotonicTime() + timeoutMs);
  if (outcome.timedOut) {
    const value = typeof fallback === 'function' ? (fallback as () => T)() : fallback;
    return { result: value, timedOut: true };
  }
  return { result: outcome.result, timedOut: false };
}

/**
 * Read a page's title without letting a mid-navigation rejection poison the
 * tool response. Playwright's `page.title()` throws "Execution context was
 * destroyed, most likely because of a navigation." while a target is
 * navigating; a single helper keeps the fallback chain consistent across
 * serializers (cached → URL → sentinel).
 */
export async function safeTitle(page: { title(): Promise<string>; url(): string }, cachedTitle?: string): Promise<string> {
  try {
    return await page.title();
  } catch {
    return cachedTitle || page.url() || '<navigating>';
  }
}

/**
 * Fire a CDP detach without letting it stall teardown. Playwright's
 * CDPSession.detach() can hang indefinitely (neither resolve nor reject) when
 * the session's underlying target has been swapped out from under it — e.g.
 * during the atomic tab-switch commit in `Earthling.switchToTab`.
 * `.catch(() => {})` only handles rejections; a never-settling promise
 * bypasses it entirely. This helper races the detach against a deadline and
 * resolves either way.
 */
export async function safeDetach(cdp: { detach(): Promise<void> } | undefined, timeoutMs: number = 500): Promise<void> {
  if (!cdp)
    return;
  await Promise.race([
    cdp.detach().catch(() => {}),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Hard budget for action tools; on timeout, throws with a snapshot-retry hint.
 */
export async function withActionBudget<T>(label: string, fn: () => Promise<T>, budgetMs: number = 30_000): Promise<T> {
  const clampedBudget = Math.min(budgetMs, MAX_TOOL_WAIT_MS);
  const outcome = await withTimeoutMarker<T>(label, fn, clampedBudget, () => undefined as unknown as T);
  if (outcome.timedOut)
    throw new Error(`${label} exceeded ${clampedBudget}ms budget — the action may not have completed. Call browser_snapshot to verify page state.`);
  return outcome.result;
}

/**
 * Validate a caller-supplied timeout against MAX_TOOL_WAIT_MS. Returns the
 * value (unchanged) if within cap. Throws with a clear message pointing
 * agents at the polling pattern if over cap. Pass undefined to opt out.
 */
export function assertWithinMaxTimeout(label: string, ms: number | undefined, max: number = MAX_TOOL_WAIT_MS): number | undefined {
  if (ms === undefined)
    return undefined;
  if (ms > max)
    throw new Error(`${label} timeout ${ms}ms exceeds maximum of ${max}ms. Use a polling pattern (repeated list-then-check tool calls) for long waits.`);
  return ms;
}

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const requests: playwright.Request[] = [];

  const requestListener = (request: playwright.Request) => requests.push(request);
  const disposeListeners = () => {
    tab.page.off('request', requestListener);
  };
  tab.page.on('request', requestListener);

  let result: R;
  try {
    result = await callback();
    await tab.waitForTimeout(500);
  } finally {
    disposeListeners();
  }

  const requestedNavigation = requests.some(request => request.isNavigationRequest());
  if (requestedNavigation) {
    await tab.page.mainFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    return result;
  }

  const promises: Promise<any>[] = [];
  for (const request of requests) {
    if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType()))
      promises.push(request.response().then(r => r?.finished()).catch(() => {}));
    else
      promises.push(request.response().catch(() => {}));
  }
  const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
  await Promise.race([Promise.all(promises), timeout]);
  if (requests.length)
    await tab.waitForTimeout(500);

  return result;
}

export function eventWaiter<T>(page: playwright.Page, event: string, timeout: number): { promise: Promise<T | undefined>, abort: () => void } {
  const disposables: (() => void)[] = [];

  const eventPromise = new Promise<T | undefined>((resolve, reject) => {
    page.on(event as any, resolve as any);
    disposables.push(() => page.off(event as any, resolve as any));
  });

  let abort: () => void;
  const abortPromise = new Promise<T | undefined>((resolve, reject) => {
    abort = () => resolve(undefined);
  });

  const timeoutPromise = new Promise<T | undefined>(f => {
    const timeoutId = setTimeout(() => f(undefined), timeout);
    disposables.push(() => clearTimeout(timeoutId));
  });

  return {
    promise: Promise.race([eventPromise, abortPromise, timeoutPromise]).finally(() => disposables.forEach(dispose => dispose())),
    abort: abort!
  };
}
