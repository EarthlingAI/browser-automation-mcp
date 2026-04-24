/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

// Regression test for [H-NEW] browser_snapshot(filename:…) silently succeeds
// without writing the file when the parent directory doesn't exist. The fix
// adds fs.mkdirSync(dirname, {recursive: true}) inside safeWriteFile() in
// src/tools/backend/response.ts, which covers BOTH response.ts call sites
// (filename=-requested writes + oversized-inline auto-save).
//
// This spec exercises the identical fs contract in isolation: given a deeply-
// nested target path where none of the intermediate directories exist, the
// pattern `mkdirSync(dirname, {recursive:true}) + writeFile(file, data)` must
// produce an on-disk file with the expected contents. A regression that drops
// the mkdir (or mis-orders it) would fail this spec.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';

test('safeWriteFile pattern creates missing parent directories for nested paths', async () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'earthling-mkdir-'));
	// Deliberately nested, none of these intermediate dirs exist yet.
	const file = path.join(tmpRoot, 'a', 'b', 'c', 'snapshot.yml');
	const payload = '- aria-snapshot-line-1\n- aria-snapshot-line-2\n';

	// Mirror the exact sequence in safeWriteFile(): mkdir recursive then write.
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	} catch (e) {
		// mkdir is expected to succeed. EEXIST would be benign (swallowed by
		// recursive:true already), but permission errors are fatal — bubble up.
		throw e;
	}
	await fs.promises.writeFile(file, payload, 'utf-8');

	expect(fs.existsSync(file)).toBe(true);
	expect(fs.readFileSync(file, 'utf-8')).toBe(payload);

	// Second call to same path must be a no-op (mkdir recursive swallows EEXIST).
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await fs.promises.writeFile(file, payload, 'utf-8');
	expect(fs.existsSync(file)).toBe(true);

	// Cleanup.
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});
