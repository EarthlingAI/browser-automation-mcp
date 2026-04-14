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

/**
 * Earthling: runtime path helpers for the CDP relay daemon.
 *
 * All paths resolve relative to the built bundle — `dist/relay-daemon.js`
 * lives at `<pkg>/dist/relay-daemon.js`, so `../.runtime` points at
 * `<pkg>/.runtime`. When running from dev (`tsx`), __dirname resolves to
 * `src/tools/mcp/relay`, so we walk up four levels.
 */

import fs from 'fs';
import path from 'path';

function findPkgRoot(): string {
  // Walk upwards looking for package.json with name "playwright-mcp-internal".
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (j.name === 'playwright-mcp-internal')
          return dir;
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  // Fallback: one level up from dist/ (i.e. the pkg dir) when package.json
  // probing didn't match. Safe because every layout (src, dist, tsx) has the
  // runtime files under `<pkg>/.runtime`.
  return path.resolve(__dirname, '..');
}

export const PKG_ROOT = findPkgRoot();
export const RUNTIME_DIR = path.join(PKG_ROOT, '.runtime');
export const PID_FILE = path.join(RUNTIME_DIR, 'relay-daemon.pid');
export const SECRET_FILE = path.join(RUNTIME_DIR, 'relay-daemon.secret');
export const LOG_FILE = path.join(RUNTIME_DIR, 'relay-daemon.log');

export function ensureRuntimeDir(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}
