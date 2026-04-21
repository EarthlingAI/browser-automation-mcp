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
 * Earthling: standalone CDP relay daemon.
 *
 * One process per machine. Owns 127.0.0.1:<port> (default 9223), the
 * extension WebSocket, and the Chrome sub-process. Lazy-spawned by the
 * first MCP client; exits 60s after extension disconnects and no clients
 * remain.
 *
 * Usage: node dist/relay-daemon.js --port 9223 [--channel chrome]
 *                                  [--user-data-dir <path>] [--executable-path <path>]
 */

import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';

import { debug } from '../../../utilsBundle';
import { ensureRuntimeDir, LOG_FILE, PID_FILE, SECRET_FILE } from './paths';
import { CDPRelayServer } from './cdpRelay';
import { DEFAULT_RELAY_PORT } from './constants';
import { appendExtensionJsonl, daemonJsonl } from './debugJsonl';

const debugLogger = debug('pw:mcp:relay:daemon');

type Args = {
  port: number;
  channel: string;
  userDataDir?: string;
  executablePath?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { port: DEFAULT_RELAY_PORT, channel: 'chrome' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') args.port = parseInt(next(), 10);
    else if (a === '--channel') args.channel = next();
    else if (a === '--user-data-dir') args.userDataDir = next();
    else if (a === '--executable-path') args.executablePath = next();
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureRuntimeDir();

  // Orphan sweep: if a prior PID file exists but the process is gone, clear.
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(oldPid)) {
        try {
          process.kill(oldPid, 0);
          // Alive: bind will fail and we'll exit 78 below.
        } catch {
          fs.unlinkSync(PID_FILE);
        }
      }
    }
  } catch {}

  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });

  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const origLog = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => { try { logStream.write(chunk); } catch {} return origLog(chunk, ...rest); };
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => { try { logStream.write(chunk); } catch {} return origErr(chunk, ...rest); };

  const httpServer = http.createServer();
  let relay: CDPRelayServer | null = null;

  httpServer.on('request', (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: 'earthling-cdp-relay',
        version: 1,
        pid: process.pid,
        uuid: relay?.uuid,
        extensionPath: relay?.extensionPath(),
        cdpPath: relay?.cdpPath(),
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      // Kick off lazy browser launch if extension isn't paired yet. Idempotent.
      if (relay && !relay.isExtensionConnected())
        void relay.ensureBrowserLaunched().catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const t = relay?.telemetry();
      res.end(JSON.stringify({
        ok: true,
        extension: relay?.isExtensionConnected() ? 'connected' : 'disconnected',
        clients: relay?.clientCount() ?? 0,
        clients_1s_high_water: relay?.clientsHighWater1s() ?? 0,
        leases: relay?.leaseSnapshot() ?? [],
        telemetry: {
          hint_direct_attach: t?.hintDirectAttach ?? 0,
          hint_missed: t?.hintMissed ?? 0,
          hint_fallback_blank: t?.hintFallbackBlank ?? 0,
          serialize_retry_timeout: t?.serializeRetryTimeout ?? 0,
        },
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/debug/extension') {
      // Extension mirrors its ring-buffer entries here in batches.
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(body);
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          for (const entry of entries)
            appendExtensionJsonl(entry);
          res.writeHead(204); res.end();
        } catch (e: any) {
          res.writeHead(400); res.end(String(e?.message || e));
        }
      });
      req.on('error', () => { try { res.writeHead(400); res.end('bad request'); } catch {} });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/telemetry/bump') {
      // MCP clients bump daemon-local counters here (e.g. serialize-retry
      // timeouts) since they run in separate processes. Fire-and-forget; no
      // auth required (loopback-only server).
      const counter = url.searchParams.get('counter');
      if (counter === 'serialize_retry_timeout')
        relay?.incrementSerializeRetryTimeout();
      else
        daemonJsonl('telemetry.bump.unknown', { detail: { counter } });
      res.writeHead(204); res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      const token = url.searchParams.get('token');
      if (token !== secret) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      res.writeHead(200); res.end('shutting down');
      void gracefulShutdown('shutdown requested');
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  httpServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`Port ${args.port} in use — another relay likely owns it.\n`);
      process.exit(78);
    }
    process.stderr.write(`HTTP server error: ${err}\n`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', () => resolve());
    httpServer.once('error', reject);
    httpServer.listen(args.port, '127.0.0.1');
  });

  relay = new CDPRelayServer(httpServer, args.channel, args.userDataDir, args.executablePath);
  relay.onIdle(() => { void gracefulShutdown('idle grace elapsed'); });

  // Won the bind race — record PID.
  fs.writeFileSync(PID_FILE, String(process.pid));
  debugLogger(`Daemon listening on 127.0.0.1:${args.port}, pid=${process.pid}`);
  process.stdout.write(`earthling-cdp-relay listening on 127.0.0.1:${args.port} (pid=${process.pid})\n`);

  let shuttingDown = false;
  async function gracefulShutdown(reason: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLogger(`Graceful shutdown: ${reason}`);
    try { await relay?.shutdown(reason); } catch {}
    // Kill Chrome sub-tree if we launched it with a daemon-owned user-data-dir.
    killOwnedChrome();
    try { httpServer.close(); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(SECRET_FILE); } catch {}
    setTimeout(() => process.exit(0), 100).unref();
  }

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('uncaughtException', err => {
    process.stderr.write(`uncaughtException: ${err?.stack || err}\n`);
  });
}

function killOwnedChrome() {
  // Chrome is spawned detached; best-effort reap by pgid / taskkill is a
  // heavy hammer and requires tracking the child pid, which we intentionally
  // do not, since the user may have other Chrome windows open in the same
  // profile and we don't want to nuke them. Closing the extension WebSocket
  // on shutdown causes the extension to stop issuing CDP; Chrome itself
  // stays alive for the user.
  //
  // If future requirements demand tearing down the browser we launched:
  // capture the child.pid from spawn(), then
  //   Windows: spawn('taskkill', ['/F', '/T', '/PID', String(pid)])
  //   Unix:    process.kill(-pgid, 'SIGTERM')
}

void main().catch(err => {
  process.stderr.write(`relay-daemon fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
