/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Unit test for `safeTitle` — verifies the helper defuses the
// "Execution context was destroyed" rejection that Playwright's
// `page.title()` throws during navigation, falling back through:
// cachedTitle → page.url() → '<navigating>'.

import { test, expect } from '@playwright/test';

import { safeTitle } from '../../../src/tools/backend/utils';

function mockPage(opts: { title?: () => Promise<string>; url?: string }): { title(): Promise<string>; url(): string } {
  return {
    title: opts.title ?? (async () => 'resolved'),
    url: () => opts.url ?? '',
  };
}

test('safeTitle: returns cached title when page.title rejects with navigation error', async () => {
  const page = mockPage({
    title: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.'); },
    url: 'https://example.com/',
  });
  const result = await safeTitle(page, 'prev');
  expect(result).toBe('prev');
});

test('safeTitle: falls back to url when no cache and title rejects', async () => {
  const page = mockPage({
    title: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.'); },
    url: 'https://x.example.com/',
  });
  const result = await safeTitle(page, undefined);
  expect(result).toBe('https://x.example.com/');
});

test('safeTitle: falls back to <navigating> when no cache and no url', async () => {
  const page = mockPage({
    title: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.'); },
    url: '',
  });
  const result = await safeTitle(page, undefined);
  expect(result).toBe('<navigating>');
});

test('safeTitle: returns resolved title on happy path', async () => {
  const page = mockPage({
    title: async () => 'Example Domain',
    url: 'https://example.com/',
  });
  const result = await safeTitle(page, 'stale');
  expect(result).toBe('Example Domain');
});
