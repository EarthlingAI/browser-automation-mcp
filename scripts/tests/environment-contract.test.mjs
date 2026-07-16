// Environment Awareness — black-box contract tests over the registered tools.
//
// Three contract surfaces (Plan 2), tested through the public tool callbacks
// with a fake daemon (same mock shape as handle_dialog.test.mjs):
//
//   1. Envelope stamping — every tool wrapper drains `ctx.daemon.takeEnv()`
//      once per call and stamps the report verbatim as a top-level
//      `environment` field on BOTH success and error envelopes; the key is
//      omitted entirely when there is nothing to report (lean by
//      construction), and a non-object payload is wrapped as
//      `{result, environment}` so the report has somewhere to live.
//   2. browser_upload targetless (chooser-fulfilment) mode — local paths are
//      validated on disk BEFORE any daemon hop, and the wire command carries
//      absolute `paths` (never base64 `files`).
//   3. browser_snapshot NOTE leads — a standing `fileChooser` /
//      `attachBlocked` from `peekEnv(tabId)` prepends a NOTE line to the
//      outline so the agent can't miss the stalled/broken state.
//
// The targeting xor guard is covered by upload-target.test.mjs and the
// handle_dialog wire shape by handle_dialog.test.mjs — not duplicated here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BridgeSession,
  registerTabTools,
  registerInteractTools,
  registerObserveTools,
} from "../../dist/test-exports.mjs";

// Fake daemon + captured tool callbacks. `env` feeds takeEnv (consumed by the
// envelope stamp); `standing` feeds peekEnv (read by the snapshot NOTE lead).
// `responses` is a queue of daemon.exec results; an Error entry is thrown to
// simulate a daemon-side failure.
function setup({ responses = [], env, standing } = {}) {
  const calls = [];
  const queue = [...responses];
  let takeEnvCalls = 0;
  const session = new BridgeSession();
  const daemon = {
    sessionId: "test-environment-contract",
    takeEnv: () => {
      takeEnvCalls += 1;
      return env;
    },
    peekEnv: () => standing,
    async exec(tabId, command) {
      calls.push({ tabId, command });
      if (queue.length === 0)
        throw new Error(`unexpected daemon.exec call: ${command.kind}`);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const callbacks = new Map();
  const server = {
    registerTool(name, _cfg, cb) {
      callbacks.set(name, cb);
    },
  };
  const ctx = { daemon, session };
  registerTabTools(server, ctx);
  registerInteractTools(server, ctx);
  registerObserveTools(server, ctx);
  session.lastLeasedTab = 7;
  return { calls, callbacks, session, takeEnvCalls: () => takeEnvCalls };
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

const DIALOG_ENV = {
  tabId: 7,
  events: [
    {
      kind: "dialog",
      type: "confirm",
      message: "Leave page?",
      disposition: "dismiss",
      wasArmed: false,
    },
  ],
};

// ─── 1. envelope stamping ───────────────────────────────────────────

test("takeEnv() undefined → envelope has NO environment key (lean)", async () => {
  const { callbacks, takeEnvCalls } = setup({
    responses: [{ dialogHandler: null }],
  });
  const res = await callbacks.get("browser_handle_dialog")({ clear: true, tabId: 7 });
  const decoded = parse(res);
  assert.equal("environment" in decoded, false, "lean envelope must omit the key");
  assert.equal(takeEnvCalls(), 1, "the wrapper still drains takeEnv once");
});

test("takeEnv() report appears verbatim as `environment` on a success envelope", async () => {
  const { callbacks, takeEnvCalls } = setup({
    responses: [{ dialogHandler: null }],
    env: DIALOG_ENV,
  });
  const res = await callbacks.get("browser_handle_dialog")({ clear: true, tabId: 7 });
  const decoded = parse(res);
  assert.deepEqual(decoded.environment, DIALOG_ENV, "report must pass through verbatim");
  assert.equal(takeEnvCalls(), 1, "consume-once: exactly one takeEnv drain per call");
});

test("takeEnv() report rides the ERROR envelope too (daemon-side failure)", async () => {
  const daemonError = Object.assign(new Error("tab 7 is leased by another agent"), {
    kind: "lease_required",
  });
  const { callbacks } = setup({ responses: [daemonError], env: DIALOG_ENV });
  const res = await callbacks.get("browser_handle_dialog")({ clear: true, tabId: 7 });
  assert.equal(res.isError, true);
  const decoded = parse(res);
  assert.deepEqual(decoded.environment, DIALOG_ENV);
  // Structured error fields survive alongside the environment report.
  assert.equal(decoded.kind, "lease_required");
  assert.match(decoded.error, /leased/);
});

test("takeEnv() report rides a pre-hop validation error envelope (zero daemon hops)", async () => {
  // handle_dialog's xor guard fires before any daemon.exec — the environment
  // report must still be delivered, not silently dropped on the floor.
  const { calls, callbacks } = setup({ env: DIALOG_ENV });
  const res = await callbacks.get("browser_handle_dialog")({ tabId: 7 });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0, "validation error must not reach the daemon");
  assert.deepEqual(parse(res).environment, DIALOG_ENV);
});

test("non-object payload is wrapped as {result, environment}", async () => {
  // A tool whose payload is a bare string can't carry a sibling key — the
  // wrapper must hoist it under `result` instead of spreading/char-indexing.
  const { callbacks } = setup({ responses: ["OK"], env: DIALOG_ENV });
  const res = await callbacks.get("browser_press_key")({
    key: "Enter",
    tabId: 7,
    snapshot: false,
  });
  const decoded = parse(res);
  assert.equal(decoded.result, "OK");
  assert.deepEqual(decoded.environment, DIALOG_ENV);
});

test("EnvReport array form passes through verbatim (multi-tab report)", async () => {
  const multi = [
    DIALOG_ENV,
    {
      tabId: 9,
      events: [
        {
          kind: "popup",
          tabId: 10,
          url: "https://example.com/popup",
          restoredFocus: true,
          leased: true,
        },
      ],
      attachBlocked: { error: "Another debugger is already attached" },
    },
  ];
  const { callbacks } = setup({ responses: [{ dialogHandler: null }], env: multi });
  const res = await callbacks.get("browser_handle_dialog")({ clear: true, tabId: 7 });
  const decoded = parse(res);
  assert.ok(Array.isArray(decoded.environment), "array report stays an array");
  assert.deepEqual(decoded.environment, multi, "every entry (dialog + popup + standing state) verbatim");
});

// ─── 2. browser_upload targetless (chooser-fulfilment) mode ────────

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("targetless upload sends {kind:'upload', paths:[…]} — absolute paths, no base64 files", async (t) => {
  const dir = withTempDir(t);
  const f1 = path.join(dir, "a.png");
  const f2 = path.join(dir, "b.pdf");
  fs.writeFileSync(f1, "x");
  fs.writeFileSync(f2, "y");
  const { calls, callbacks } = setup({ responses: [{ fulfilled: true }] });
  const res = await callbacks.get("browser_upload")({
    files: [f1, f2],
    tabId: 7,
    snapshot: false,
  });
  assert.notEqual(res.isError, true, `unexpected error: ${res.content[0].text}`);
  assert.equal(calls.length, 1, "exactly one daemon hop");
  const cmd = calls[0].command;
  assert.equal(cmd.kind, "upload");
  assert.deepEqual(cmd.paths, [f1, f2], "paths on the wire, in caller order");
  assert.ok(cmd.paths.every((p) => path.isAbsolute(p)), "wire paths must be absolute");
  assert.equal("files" in cmd, false, "chooser mode must NOT read/ship base64 payloads");
  assert.equal("ref" in cmd, false);
  assert.equal("selector" in cmd, false);
});

test("targetless upload: nonexistent file → error envelope, zero daemon hops", async (t) => {
  const dir = withTempDir(t);
  const { calls, callbacks } = setup();
  const res = await callbacks.get("browser_upload")({
    files: [path.join(dir, "missing.png")],
    tabId: 7,
    snapshot: false,
  });
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /missing\.png/, "error names the offending path");
  assert.equal(calls.length, 0, "path validation must precede any daemon hop");
});

test("targetless upload: relative path to nowhere → error envelope, zero daemon hops", async () => {
  const { calls, callbacks } = setup();
  const res = await callbacks.get("browser_upload")({
    files: ["no-such-dir/definitely-missing.png"],
    tabId: 7,
    snapshot: false,
  });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test("targetless upload: relative path is rejected even when it WOULD resolve (cwd is not the caller's)", async () => {
  // "package.json" exists relative to the bridge process's cwd during tests —
  // accepting it would ship a cwd-resolved path the caller never intended.
  // The contract requires absolute paths outright.
  const { calls, callbacks } = setup();
  const res = await callbacks.get("browser_upload")({
    files: ["package.json"],
    tabId: 7,
    snapshot: false,
  });
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /absolute/, "error explains the absolute-path requirement");
  assert.equal(calls.length, 0);
});

test("targetless upload: one bad path poisons the whole batch before any hop", async (t) => {
  const dir = withTempDir(t);
  const good = path.join(dir, "exists.png");
  fs.writeFileSync(good, "x");
  const { calls, callbacks } = setup();
  const res = await callbacks.get("browser_upload")({
    files: [good, path.join(dir, "gone.png")],
    tabId: 7,
    snapshot: false,
  });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0, "EVERY path is validated before the daemon hop");
});

// ─── 3. browser_snapshot NOTE leads from standing env state ────────

const TREE_ONE_BUTTON = {
  role: "WebArea",
  name: "T",
  depth: 0,
  cssViewport: { w: 1024, h: 768 },
  children: [
    {
      nodeId: "1",
      role: "button",
      name: "Click me",
      depth: 1,
      rect: { x: 100, y: 200, w: 120, h: 40 },
      inViewport: true,
      children: [],
    },
  ],
};

const CAPTURE_RESPONSE = {
  tree: TREE_ONE_BUTTON,
  screenshot: undefined,
  cssViewport: { w: 1024, h: 768 },
};

test("standing fileChooser → snapshot outline leads with a NOTE naming browser_upload", async () => {
  const { callbacks } = setup({
    responses: [CAPTURE_RESPONSE],
    standing: { fileChooser: { mode: "selectSingle" } },
  });
  const res = await callbacks.get("browser_snapshot")({ tabId: 7 });
  const tree = parse(res).tree;
  const firstLine = tree.split("\n")[0];
  assert.ok(firstLine.startsWith("NOTE: "), `outline must lead with NOTE, got: ${firstLine}`);
  assert.match(firstLine, /file chooser/i, "NOTE names the intercepted chooser");
  assert.match(firstLine, /browser_upload/, "NOTE points at the fulfilment tool");
});

test("standing attachBlocked → snapshot outline leads with a NOTE naming the attach problem", async () => {
  const { callbacks } = setup({
    responses: [CAPTURE_RESPONSE],
    standing: {
      attachBlocked: {
        error: "Another debugger is already attached",
        conflicting: ["chrome-extension://abc"],
      },
    },
  });
  const res = await callbacks.get("browser_snapshot")({ tabId: 7 });
  const firstLine = parse(res).tree.split("\n")[0];
  assert.ok(firstLine.startsWith("NOTE: "), `outline must lead with NOTE, got: ${firstLine}`);
  assert.match(firstLine, /attach/i, "NOTE names the attach problem");
  assert.match(
    firstLine,
    /Another debugger is already attached/,
    "NOTE carries the underlying error",
  );
});

test("no standing state → snapshot outline has no NOTE lead", async () => {
  const { callbacks } = setup({ responses: [CAPTURE_RESPONSE] });
  const res = await callbacks.get("browser_snapshot")({ tabId: 7 });
  const firstLine = parse(res).tree.split("\n")[0];
  assert.ok(!firstLine.startsWith("NOTE: "), `unexpected NOTE lead: ${firstLine}`);
  assert.match(firstLine, /^- WebArea/, "outline starts straight at the root node");
});
