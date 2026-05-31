/**
 * Entry point.
 *   --daemon : run the singleton daemon (called by spawnDaemonIfNeeded).
 *   default  : run a per-agent MCP bridge over stdio; lazy-spawns the daemon.
 *
 * Optional flags:
 *   --agent <label>   Human-readable agent label surfaced in lease records.
 */

import { join } from "node:path";
import { startDaemon } from "./daemon/server";
import { ensureDaemon } from "./daemon/spawn";
import { startBridge } from "./bridge/mcp";

/**
 * Resolution order:
 *   1. BROWSER_AUTOMATION_MCP_RUNTIME_DIR — explicit override (test harnesses only).
 *   2. %LOCALAPPDATA%\browser-automation-mcp  (Windows)
 *   3. $XDG_STATE_HOME / ~/.local/state / ~/Library/Application Support (Unix/macOS)
 *   4. <package>/.runtime — fallback for `node dist/index.js --daemon` smoke tests.
 */
function resolveRuntimeDir(): string {
  if (process.env.BROWSER_AUTOMATION_MCP_RUNTIME_DIR)
    return process.env.BROWSER_AUTOMATION_MCP_RUNTIME_DIR;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ??
      (home ? join(home, "AppData", "Local") : null);
    if (base) return join(base, "browser-automation-mcp");
  } else if (process.platform === "darwin") {
    if (home)
      return join(
        home,
        "Library",
        "Application Support",
        "browser-automation-mcp",
      );
  } else {
    const base =
      process.env.XDG_STATE_HOME ??
      (home ? join(home, ".local", "state") : null);
    if (base) return join(base, "browser-automation-mcp");
  }
  return join(__dirname, "..", ".runtime");
}

async function main(): Promise<void> {
  const runtimeDir = resolveRuntimeDir();
  const args = process.argv.slice(2);
  if (args.includes("--daemon")) {
    await startDaemon(runtimeDir);
    await new Promise<void>(() => {}); // run forever
    return;
  }

  const agentIdx = args.indexOf("--agent");
  const agentLabel = agentIdx >= 0 ? args[agentIdx + 1] : undefined;

  const scriptPath = process.argv[1]!;
  const endpoint = await ensureDaemon(runtimeDir, scriptPath);
  await startBridge({
    agentLabel,
    endpoint,
    ensureDaemonFn: () => ensureDaemon(runtimeDir, scriptPath),
  });
}

main().catch((err) => {
  console.error("[browser-automation-mcp]", err);
  process.exit(1);
});
