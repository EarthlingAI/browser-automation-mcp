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
 * Earthling: discover-or-spawn handshake for MCP clients connecting to the
 * relay daemon.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';

import { PKG_ROOT } from './paths';

export type DiscoverResult = {
  service: 'earthling-cdp-relay';
  version: number;
  pid: number;
  uuid: string;
  extensionPath: string;
  cdpPath: string;
};

async function discover(port: number, timeoutMs = 200): Promise<DiscoverResult | null | 'wrong-service'> {
  return await new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/discover', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed?.service === 'earthling-cdp-relay')
            resolve(parsed as DiscoverResult);
          else
            resolve('wrong-service');
        } catch {
          resolve('wrong-service');
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function health(port: number, timeoutMs = 200): Promise<{ ok: boolean; extension: string } | null> {
  return await new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function spawnDaemon(port: number, channel?: string): void {
  // Resolve the built daemon. PKG_ROOT/dist/relay-daemon.js in production;
  // in dev (tsx) we fall back to src via tsx.
  const builtPath = path.join(PKG_ROOT, 'dist', 'relay-daemon.js');
  const srcPath = path.join(PKG_ROOT, 'src', 'tools', 'mcp', 'relay', 'daemon.ts');
  let cmd: string;
  let args: string[];
  if (fs.existsSync(builtPath)) {
    cmd = process.execPath;
    args = [builtPath, '--port', String(port)];
  } else {
    cmd = process.execPath;
    args = ['-r', 'tsx/cjs', srcPath, '--port', String(port)];
  }
  if (channel)
    args.push('--channel', channel);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

/**
 * Connect to (or spawn) the local relay daemon. Returns discovery info once
 * the extension is reported as connected — callers can immediately issue
 * CDP commands without racing the extension handshake.
 */
export async function acquireDaemon(port: number, channel?: string): Promise<DiscoverResult> {
  let lastErr = '';
  // Budget generously: MV3 service-worker cold-start + extension auto-reconnect
  // can legitimately take 15-20s on a slow machine. 120 * 250ms ≈ 30s.
  for (let attempt = 0; attempt < 120; attempt++) {
    const found = await discover(port);
    if (found && found !== 'wrong-service') {
      // Daemon is up; wait for extension to be connected before returning.
      const h = await health(port);
      if (h?.extension === 'connected')
        return found;
      // Daemon is up but extension not yet ready — keep polling.
      lastErr = 'daemon up, extension not connected yet';
      await sleep(250);
      continue;
    }
    if (found === 'wrong-service')
      throw new Error(`Port ${port} is held by a non-Earthling service. Set BROWSER_AUTOMATION_MCP_RELAY_PORT to override.`);
    // Not reachable — spawn a new daemon (race-safe: losers exit 78).
    if (attempt === 0 || attempt % 8 === 0)
      spawnDaemon(port, channel);
    await sleep(150 + Math.floor(Math.random() * 80));
  }
  throw new Error(`Failed to acquire relay daemon on port ${port} after retries (${lastErr})`);
}
