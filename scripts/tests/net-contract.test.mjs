// browser_fetch / browser_cookies — black-box contract tests (Plan 3).
//
// The privileged data primitives are lease-free: their handlers call
// `ctx.daemon.send({type, …})` (no tabId, no debugger) rather than the
// `exec(tabId, command)` path the tab tools use. Two contract surfaces are
// covered here, each through the tool's PUBLIC surface only:
//
//   1. Input schema bounds — validated by re-parsing the registered
//      `inputSchema` (the same zod shape the SDK enforces on the wire), so
//      timeout/credentials/method/max_inline_bytes/url invariants can't drift
//      without a red.
//   2. Handler behaviour — the save-offload contract (auto-name .txt/.bin,
//      previewTruncated vs the SW's own truncated, full body on disk, base64
//      preview cut on a 4-char boundary, non-fatal write error) and the
//      cookies url|domain requirement — driven through the wrapped callback
//      with a fake daemon that returns canned FetchResult / CookieRecord[].
//
// Deliberately NOT reading net.ts / background.js internals — the contract is
// the tool descriptions + CLAUDE.md invariants, nothing below them.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  BridgeSession,
  registerNetTools,
} from "../../dist/test-exports.mjs";

// Capture both the registered config (for inputSchema bounds) and the wrapped
// callback (for handler behaviour). `responses` is a queue of daemon.send
// results; an Error entry is thrown to simulate a daemon-side failure.
function setup({ responses = [] } = {}) {
  const sends = [];
  const queue = [...responses];
  const configs = new Map();
  const callbacks = new Map();
  const daemon = {
    sessionId: "test-net-contract",
    takeEnv: () => undefined,
    peekEnv: () => undefined,
    async send(command) {
      sends.push(command);
      if (queue.length === 0)
        throw new Error(`unexpected daemon.send call: ${command.type}`);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const server = {
    registerTool(name, cfg, cb) {
      configs.set(name, cfg);
      callbacks.set(name, cb);
    },
  };
  registerNetTools(server, { daemon, session: new BridgeSession() });
  return { sends, configs, callbacks };
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

// Re-parse against the registered inputSchema exactly as the SDK would.
function schemaOf(configs, name) {
  return z.object(configs.get(name).inputSchema);
}

// ─── 1. browser_fetch input-schema bounds ───────────────────────────

test("fetch schema: timeout is 1…300000 with a 30000 default, coerced from strings", () => {
  const { configs } = setup();
  const s = schemaOf(configs, "browser_fetch");
  assert.equal(s.parse({ url: "https://e.test/" }).timeout, 30_000, "default");
  assert.equal(s.parse({ url: "https://e.test/", timeout: "5000" }).timeout, 5000, "string coerced");
  assert.throws(() => s.parse({ url: "https://e.test/", timeout: 0 }), "min 1 rejects 0");
  assert.throws(() => s.parse({ url: "https://e.test/", timeout: 300_001 }), "max 300000");
});

test("fetch schema: credentials defaults include, enum-gated", () => {
  const { configs } = setup();
  const s = schemaOf(configs, "browser_fetch");
  assert.equal(s.parse({ url: "https://e.test/" }).credentials, "include", "default");
  for (const c of ["include", "same-origin", "omit"]) {
    assert.equal(s.parse({ url: "https://e.test/", credentials: c }).credentials, c);
  }
  assert.throws(() => s.parse({ url: "https://e.test/", credentials: "sometimes" }), "enum reject");
});

test("fetch schema: method defaults GET; max_inline_bytes ≥0 default 25000; url must be absolute", () => {
  const { configs } = setup();
  const s = schemaOf(configs, "browser_fetch");
  assert.equal(s.parse({ url: "https://e.test/" }).method, "GET");
  assert.equal(s.parse({ url: "https://e.test/" }).max_inline_bytes, 25_000, "default");
  assert.equal(s.parse({ url: "https://e.test/", max_inline_bytes: 0 }).max_inline_bytes, 0, "0 allowed");
  assert.throws(() => s.parse({ url: "https://e.test/", max_inline_bytes: -1 }), "min 0");
  assert.throws(() => s.parse({ url: "not-a-url" }), "url must be absolute");
});

// ─── 2. browser_fetch handler save-offload contract ─────────────────

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "net-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Full args the RAW handler needs — no schema defaults are applied when the
// callback is invoked directly, so every field the handler forwards is explicit.
function fetchArgs(over = {}) {
  return {
    url: "https://e.test/api",
    method: "GET",
    headers: undefined,
    body: undefined,
    credentials: "include",
    timeout: 30_000,
    max_inline_bytes: 25_000,
    save_to_path: false,
    ...over,
  };
}

test("fetch: text body + save:true writes an auto-named .txt and returns fetchedTo", async (t) => {
  const dir = withTempDir(t);
  const target = path.join(dir, "out.txt");
  const { callbacks } = setup({ responses: [{ status: 200, ok: true, body: "hello world" }] });
  const res = await callbacks.get("browser_fetch")(
    fetchArgs({ save_to_path: target, max_inline_bytes: 25_000 }),
  );
  const d = parse(res);
  assert.equal(d.fetchedTo, target);
  assert.equal(fs.readFileSync(target, "utf8"), "hello world", "full body on disk");
  assert.equal(d.body, "hello world", "short body still inlined");
  assert.equal("previewTruncated" in d, false, "no preview cut when body fits");
});

test("fetch: binary body (bodyBase64) + save:true writes decoded bytes to disk", async (t) => {
  const dir = withTempDir(t);
  const target = path.join(dir, "out.bin");
  const raw = Buffer.from([0, 1, 2, 250, 251, 255]);
  const { callbacks } = setup({
    responses: [{ status: 200, ok: true, bodyBase64: raw.toString("base64") }],
  });
  const res = await callbacks.get("browser_fetch")(fetchArgs({ save_to_path: target }));
  const d = parse(res);
  assert.equal(d.fetchedTo, target);
  assert.deepEqual(fs.readFileSync(target), raw, "base64 decoded to original bytes on disk");
});

test("fetch: body over max_inline_bytes + save cuts the inline PREVIEW but disk gets the full body", async (t) => {
  const dir = withTempDir(t);
  const target = path.join(dir, "big.txt");
  const full = "x".repeat(5000);
  const { callbacks } = setup({ responses: [{ status: 200, ok: true, body: full }] });
  const res = await callbacks.get("browser_fetch")(
    fetchArgs({ save_to_path: target, max_inline_bytes: 100 }),
  );
  const d = parse(res);
  assert.equal(d.previewTruncated, true, "inline copy flagged as a cut preview");
  assert.equal(d.body.length, 100, "inline preview cut to max_inline_bytes");
  assert.equal(fs.readFileSync(target, "utf8").length, 5000, "FULL body on disk, uncut");
});

test("fetch: base64 preview is cut on a 4-char boundary (stays decodable)", async (t) => {
  const dir = withTempDir(t);
  const target = path.join(dir, "big.bin");
  const b64 = Buffer.alloc(3000, 7).toString("base64"); // long, divisible work
  const { callbacks } = setup({ responses: [{ status: 200, ok: true, bodyBase64: b64 }] });
  const res = await callbacks.get("browser_fetch")(
    fetchArgs({ save_to_path: target, max_inline_bytes: 101 }),
  );
  const d = parse(res);
  assert.equal(d.previewTruncated, true);
  assert.equal(d.bodyBase64.length % 4, 0, "preview length is a 4-char multiple");
  assert.equal(d.bodyBase64.length, 100, "floor(101/4)*4 = 100");
  assert.doesNotThrow(() => Buffer.from(d.bodyBase64, "base64"), "preview still decodes");
});

test("fetch: the SW's own `truncated` flag passes through independent of previewTruncated", async (t) => {
  const dir = withTempDir(t);
  const target = path.join(dir, "capped.txt");
  const { callbacks } = setup({
    responses: [{ status: 200, ok: true, body: "short", truncated: true }],
  });
  const res = await callbacks.get("browser_fetch")(fetchArgs({ save_to_path: target }));
  const d = parse(res);
  assert.equal(d.truncated, true, "SW hard-ceiling flag survives the spread");
  assert.equal("previewTruncated" in d, false, "distinct signal: preview not cut here");
});

test("fetch: no save → inline body passes through verbatim, no fetchedTo", async () => {
  const { callbacks, sends } = setup({ responses: [{ status: 200, ok: true, body: "inline" }] });
  const res = await callbacks.get("browser_fetch")(fetchArgs({ save_to_path: false }));
  const d = parse(res);
  assert.equal(d.body, "inline");
  assert.equal("fetchedTo" in d, false);
  assert.equal("previewTruncated" in d, false);
  assert.equal(sends[0].req.save, false, "wire req.save mirrors the no-save intent");
});

test("fetch: a save-path error is non-fatal — body still returns, flagged fetchError", async () => {
  const { callbacks } = setup({ responses: [{ status: 200, ok: true, body: "kept" }] });
  const res = await callbacks.get("browser_fetch")(fetchArgs({ save_to_path: "../escape.txt" }));
  const d = parse(res);
  assert.notEqual(res.isError, true, "save failure must NOT fail the whole fetch");
  assert.match(d.fetchError, /\.\.|not allowed/, "names the rejected path");
  assert.equal(d.body, "kept", "inline body preserved despite the save error");
  assert.equal("fetchedTo" in d, false);
});

test("fetch: the wire command is {type:'fetch', req:{…}} carrying the caller's knobs", async () => {
  const { callbacks, sends } = setup({ responses: [{ status: 200, ok: true, body: "b" }] });
  await callbacks.get("browser_fetch")(
    fetchArgs({ method: "POST", body: "{}", credentials: "omit", max_inline_bytes: 12 }),
  );
  assert.equal(sends.length, 1);
  assert.equal(sends[0].type, "fetch");
  const req = sends[0].req;
  assert.equal(req.method, "POST");
  assert.equal(req.body, "{}");
  assert.equal(req.credentials, "omit");
  assert.equal(req.maxInlineBytes, 12);
  assert.equal("tabId" in sends[0], false, "lease-free: no tab on the wire");
});

// ─── 3. browser_cookies contract ────────────────────────────────────

test("cookies: neither url nor domain → error envelope, zero daemon hops", async () => {
  const { callbacks, sends } = setup();
  const res = await callbacks.get("browser_cookies")({});
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /url.*domain|domain.*url/i, "error names the requirement");
  assert.equal(sends.length, 0, "requirement is checked before any daemon hop");
});

test("cookies: url forwards {type:'cookies', filter:{url,…}} and returns the record array", async () => {
  const jar = [{ name: "sid", value: "abc", domain: "e.test", httpOnly: true, session: true }];
  const { callbacks, sends } = setup({ responses: [jar] });
  const res = await callbacks.get("browser_cookies")({ url: "https://e.test/app" });
  // browser_cookies is count-wrapped: an array payload returns {count, items}.
  const d = parse(res);
  assert.equal(d.count, 1);
  assert.deepEqual(d.items, jar, "cookie records pass through verbatim");
  assert.equal(sends[0].type, "cookies");
  assert.equal(sends[0].filter.url, "https://e.test/app");
});

test("cookies: domain + name filter both ride the wire", async () => {
  const { callbacks, sends } = setup({ responses: [[]] });
  await callbacks.get("browser_cookies")({ domain: "e.test", name: "sid" });
  assert.equal(sends[0].filter.domain, "e.test");
  assert.equal(sends[0].filter.name, "sid");
  assert.equal("tabId" in sends[0], false, "lease-free: no tab on the wire");
});
