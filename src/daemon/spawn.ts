/**
 * Daemon-spawn helpers shared by the bridge entry point and the in-bridge
 * recovery path. Race protection (daemon.lock + endpoint-file polling +
 * probePort) is identical for cold start and mid-session recovery — a single
 * implementation serves both.
 *
 * Daemon re-exec auto-selects by whether the entry script exists on disk:
 * direct `process.execPath` re-exec when it does (dev / standalone), else
 * re-enter via the host dispatcher (`MCP_HOST_DISPATCHER`) since the compiled
 * host runs the source from memory. See `ensureDaemon` for the branch.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { readDaemonEndpoint } from "./server";
import {
  DAEMON_LOCK_FILE,
  DAEMON_PORT_FILE,
  DAEMON_TOKEN_FILE,
} from "../protocol";

export function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

export function clearStaleEndpoint(runtimeDir: string): void {
  for (const f of [DAEMON_PORT_FILE, DAEMON_TOKEN_FILE, DAEMON_LOCK_FILE]) {
    try {
      unlinkSync(join(runtimeDir, f));
    } catch {
      /* ignore */
    }
  }
}

export async function waitForDaemon(
  runtimeDir: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readDaemonEndpoint(runtimeDir)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not write endpoint within ${timeoutMs}ms`);
}

export async function ensureDaemon(
  runtimeDir: string,
  scriptPath: string,
): Promise<{ port: number; token: string }> {
  mkdirSync(runtimeDir, { recursive: true });
  const existing = readDaemonEndpoint(runtimeDir);
  // Daemon cleans up its endpoint files on SIGINT/SIGTERM, but a hard kill (reboot,
  // Task Manager, OOM) leaves them behind. Probe before trusting them so we self-heal.
  if (existing) {
    if (await probePort(existing.port)) return existing;
    console.error(
      `[browser-automation-mcp] stale endpoint on :${existing.port}; respawning daemon`,
    );
    clearStaleEndpoint(runtimeDir);
  }

  const lockPath = join(runtimeDir, DAEMON_LOCK_FILE);
  // Lock TTL must cover a full cold start (waitForDaemon budget) so a concurrent starter waits it out instead of double-spawning a daemon that is merely slow on a loaded machine.
  if (
    existsSync(lockPath) &&
    Date.now() - parseInt(readFileSync(lockPath, "utf8"), 10) < 30_000
  ) {
    await waitForDaemon(runtimeDir);
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
  let cmd: string;
  let cmdArgs: string[];
  if (existsSync(scriptPath)) {
    // Dev / standalone: real entry file on disk — re-exec it directly.
    cmd = process.execPath;
    cmdArgs = [scriptPath, "--daemon"];
  } else {
    // Compiled host mode: source is compiled into the host binary and run in
    // memory, so scriptPath is synthetic. Re-enter through the host dispatcher
    // (same contract ai-image-mcp uses for its sidecar).
    const dispatcher = process.env.MCP_HOST_DISPATCHER;
    if (!dispatcher) {
      throw new Error(
        "daemon entry not on disk and MCP_HOST_DISPATCHER unset — cannot spawn daemon",
      );
    }
    cmd = dispatcher;
    cmdArgs = ["run-mcp", "browser-automation-mcp", "--daemon"];
  }
  const child = spawn(cmd, cmdArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BROWSER_AUTOMATION_MCP_RUNTIME_DIR: runtimeDir },
  });
  child.unref();

  await waitForDaemon(runtimeDir);
  return (
    readDaemonEndpoint(runtimeDir) ??
    (() => {
      throw new Error("daemon failed to start");
    })()
  );
}
