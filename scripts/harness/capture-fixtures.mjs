/**
 * Captures raw a11y-tree fixtures for the snapshot regression harness by
 * driving a stdio MCP bridge child process (the same one host agents use).
 * Raw trees flow extension → daemon → bridge → this script → disk, so they
 * never transit the orchestrating agent's context (they are multi-MB).
 *
 * PREREQUISITES: `npm run build` first, and the Chrome extension must be
 * connected (the bridge connects to the running daemon → extension).
 *
 * USAGE (from the package root):
 *   node scripts/harness/capture-fixtures.mjs                 # all sites (skip existing)
 *   node scripts/harness/capture-fixtures.mjs --force         # re-capture all
 *   node scripts/harness/capture-fixtures.mjs --only hn,mdn   # subset
 *   node scripts/harness/capture-fixtures.mjs --settle-ms 4000
 *
 * Each fixture is written to scripts/harness/fixtures/<name>.json as
 *   { url, title, capturedAt, rawTree }
 * matching the envelope snapshot-harness.mjs reads.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const SNIPPET = fs.readFileSync(path.join(__dirname, "capture-snippet.js"), "utf8");

// A diverse set of real, content-rich pages: long-form article, docs, dense
// feed, strict-CSP app, news grid, media feed, docs SPA, e-commerce.
const SITES = [
  { name: "wikipedia-ai", url: "https://en.wikipedia.org/wiki/Artificial_intelligence" },
  { name: "mdn-array", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array" },
  { name: "hn", url: "https://news.ycombinator.com/" },
  { name: "github-repo", url: "https://github.com/microsoft/playwright-mcp" },
  { name: "bbc-news", url: "https://www.bbc.com/news" },
  { name: "theverge", url: "https://www.theverge.com/" },
  { name: "react-dev", url: "https://react.dev/" },
  { name: "apple-iphone", url: "https://www.apple.com/iphone/" },
];

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = (flag("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const SETTLE_MS = Number(flag("--settle-ms", "3000"));

// The capture expression: stringify the IIFE result so browser_evaluate wraps
// a STRING under `result` (a primitive) — deterministic to parse vs. an object
// that the envelope would spread.
const EXPRESSION = `JSON.stringify(${SNIPPET.trim().replace(/;?\s*$/, "")})`;

// ── minimal newline-delimited JSON-RPC client over the bridge's stdio ──
const child = spawn(process.execPath, [path.join(PKG_ROOT, "dist", "index.js"), "--agent", "harness-capture"], {
  cwd: PKG_ROOT,
  stdio: ["pipe", "pipe", "inherit"], // stderr → inherited (bridge logs)
});
let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
// A tool call returns { content:[{type:"text",text}] }; parse the text payload.
async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text);
  if (payload?.error) throw new Error(`${name}: ${payload.error}${payload.hint ? ` (${payload.hint})` : ""}`);
  return payload;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── capture flow ────────────────────────────────────────────────────
async function captureSite(site) {
  const dest = path.join(FIXTURES_DIR, `${site.name}.json`);
  if (!FORCE && fs.existsSync(dest)) { console.error(`· skip ${site.name} (exists)`); return "skip"; }
  let tabId;
  try {
    const opened = await callTool("browser_open_tab", { url: site.url, background: true });
    tabId = opened.id;
    if (SETTLE_MS > 0) await sleep(SETTLE_MS); // let SPA content hydrate past the load event
    const evald = await callTool("browser_evaluate", { expression: EXPRESSION, tabId, snapshot: false });
    const rawTree = JSON.parse(evald.result);
    const title = rawTree?.name ?? "";
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ url: site.url, title, capturedAt: new Date().toISOString(), rawTree }) + "\n");
    const bytes = fs.statSync(dest).size;
    console.error(`✓ ${site.name}: "${title}" (${(bytes / 1024).toFixed(0)} KB)`);
    return "ok";
  } catch (e) {
    console.error(`✗ ${site.name}: ${e.message}`);
    return "fail";
  } finally {
    if (tabId != null) { try { await callTool("browser_close_tab", { tabId }); } catch {} }
  }
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "harness-capture", version: "0" },
  });
  notify("notifications/initialized");
  const targets = ONLY.length ? SITES.filter((s) => ONLY.includes(s.name)) : SITES;
  const tally = { ok: 0, skip: 0, fail: 0 };
  for (const site of targets) tally[await captureSite(site)]++;
  console.error(`\n[capture] done — ${tally.ok} ok, ${tally.skip} skipped, ${tally.fail} failed.`);
  child.stdin.end();
  child.kill();
  // Any failed site is a non-zero exit — a partial capture must not silently
  // feed an incomplete fixture set into a saved baseline downstream.
  process.exit(tally.fail ? 1 : 0);
}
main().catch((e) => { console.error("[capture] fatal:", e); child.kill(); process.exit(1); });
