/**
 * Entry point.
 *   --daemon : run the singleton daemon (called by spawnDaemonIfNeeded).
 *   default  : run a per-agent MCP bridge over stdio; lazy-spawns the daemon.
 *
 * Optional flags:
 *   --agent <label>   Human-readable agent label surfaced in lease records.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { startDaemon, readDaemonEndpoint } from "./daemon/server";
import { startBridge } from "./bridge/mcp";
import { DAEMON_LOCK_FILE } from "./protocol";

/**
 * Resolution order:
 *   1. BROWSER_AUTOMATION_MCP_RUNTIME_DIR — explicit override (engine sets this).
 *   2. %LOCALAPPDATA%\earthling\browser-automation-mcp  (Windows)
 *   3. $XDG_STATE_HOME / ~/.local/state / ~/Library/Application Support (Unix/macOS)
 *   4. <package>/.runtime — fallback for `node dist/index.js --daemon` smoke tests.
 */
function resolveRuntimeDir(): string {
  if (process.env.BROWSER_AUTOMATION_MCP_RUNTIME_DIR)
    return process.env.BROWSER_AUTOMATION_MCP_RUNTIME_DIR;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? (home ? join(home, "AppData", "Local") : null);
    if (base) return join(base, "earthling", "browser-automation-mcp");
  } else if (process.platform === "darwin") {
    if (home) return join(home, "Library", "Application Support", "earthling", "browser-automation-mcp");
  } else {
    const base = process.env.XDG_STATE_HOME ?? (home ? join(home, ".local", "state") : null);
    if (base) return join(base, "earthling", "browser-automation-mcp");
  }
  return join(__dirname, "..", ".runtime");
}

const runtimeDir = resolveRuntimeDir();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--daemon")) {
    await startDaemon(runtimeDir);
    await new Promise<void>(() => {}); // run forever
    return;
  }

  const agentIdx = args.indexOf("--agent");
  const agentLabel = agentIdx >= 0 ? args[agentIdx + 1] : undefined;

  const endpoint = await ensureDaemon();
  await startBridge({ agentLabel, endpoint });
}

async function ensureDaemon(): Promise<{ port: number; token: string }> {
  mkdirSync(runtimeDir, { recursive: true });
  const existing = readDaemonEndpoint(runtimeDir);
  if (existing) return existing;

  const lockPath = join(runtimeDir, DAEMON_LOCK_FILE);
  if (
    existsSync(lockPath) &&
    Date.now() - parseInt(readFileSync(lockPath, "utf8"), 10) < 5_000
  ) {
    await waitForDaemon();
    return (
      readDaemonEndpoint(runtimeDir) ??
      (() => {
        throw new Error("daemon failed to start");
      })()
    );
  }
  writeFileSync(lockPath, String(Date.now()));

  // Redirect daemon output to .runtime/daemon.log so crashes (e.g. EADDRINUSE) are diagnosable.
  const logFd = openSync(join(runtimeDir, "daemon.log"), "a");
  const child = spawn(process.execPath, [process.argv[1]!, "--daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BROWSER_AUTOMATION_MCP_RUNTIME_DIR: runtimeDir },
  });
  child.unref();

  await waitForDaemon();
  return (
    readDaemonEndpoint(runtimeDir) ??
    (() => {
      throw new Error("daemon failed to start");
    })()
  );
}

async function waitForDaemon(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readDaemonEndpoint(runtimeDir)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not write endpoint within ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error("[browser-automation-mcp]", err);
  process.exit(1);
});
