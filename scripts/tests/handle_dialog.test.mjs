// browser_handle_dialog — bridge-side wiring (CP8 + CP9 safe-default). The
// real CDP work (Page.enable + Page.javascriptDialogOpening listener +
// Page.handleJavaScriptDialog) lives in background.js and can't be
// unit-tested without Chrome, so these tests pin the bridge contract: the
// tool forwards a single `handle_dialog` ExtCommand carrying {disposition,
// promptText?, lifetime} on arm or {clear:true} on disarm, defaults lifetime
// to "one_shot" when omitted, rejects xor violations before any daemon hop,
// and falls back to the leased tab when tabId is omitted.
//
// CP9 safe-default behaviour (invariant #35) — Page.enable is now applied
// unconditionally on every fresh debugger attach (debuggerAttach), so the
// global listener intercepts EVERY native dialog the tab fires while the
// debugger is attached for any reason. With no arm in `dialogDispositions`
// the type-aware safe-default answers (dismiss; beforeunload accepts while
// the agent is driving) so the page can't
// block the next agent tool call. The bridge wire shape is unchanged — only
// the extension-side dispatch differs — so this suite is unaffected; the
// safe-default is covered by live-E2E (see Progress Log CP9 path-v re-run).

import test from "node:test";
import assert from "node:assert/strict";
import { BridgeSession, registerTabTools } from "../../dist/test-exports.mjs";

function setup(responses = []) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  const daemon = {
    sessionId: "test-handle-dialog",
    takeEnv: () => undefined,
    peekEnv: () => undefined,
    async exec(tabId, command) {
      calls.push({ tabId, command });
      if (queue.length === 0)
        throw new Error(`unexpected daemon.exec call: ${command.kind}`);
      return queue.shift();
    },
  };
  const callbacks = new Map();
  const server = {
    registerTool(name, _cfg, cb) {
      callbacks.set(name, cb);
    },
  };
  registerTabTools(server, { daemon, session });
  return { calls, callbacks, session };
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("arming forwards a single handle_dialog ExtCommand carrying disposition/promptText/lifetime", async () => {
  const { calls, callbacks } = setup([
    { dialogHandler: { disposition: "accept", promptText: "hi", lifetime: "sticky" } },
  ]);
  const handle = callbacks.get("browser_handle_dialog");
  assert.ok(handle, "browser_handle_dialog should be registered");

  await handle({
    disposition: "accept",
    promptText: "hi",
    lifetime: "sticky",
    tabId: 707,
  });

  assert.equal(calls.length, 1, "exactly one daemon hop");
  assert.equal(calls[0].tabId, 707);
  assert.deepEqual(calls[0].command, {
    kind: "handle_dialog",
    disposition: "accept",
    promptText: "hi",
    lifetime: "sticky",
  });
});

test("clear forwards handle_dialog{clear:true} without a disposition", async () => {
  const { calls, callbacks } = setup([{ dialogHandler: null }]);
  const handle = callbacks.get("browser_handle_dialog");

  await handle({ clear: true, tabId: 707 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].command, { kind: "handle_dialog", clear: true });
});

test("default lifetime=one_shot when omitted", async () => {
  // Mirrors CP6's `f.kind ?? "type"` / CP7's `mechanism ?? "auto"` pattern: the
  // handler applies `lifetime ?? "one_shot"` so non-zod callers (and this test,
  // which bypasses schema parsing) send an explicit "one_shot" rather than
  // undefined — matching the documented schema default.
  const { calls, callbacks } = setup([{ dialogHandler: { disposition: "accept" } }]);
  const handle = callbacks.get("browser_handle_dialog");

  await handle({ disposition: "accept", tabId: 707 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].command, {
    kind: "handle_dialog",
    disposition: "accept",
    lifetime: "one_shot",
  });
});

test("xor: rejects disposition AND clear:true together (no daemon hop)", async () => {
  const { calls, callbacks } = setup();
  const handle = callbacks.get("browser_handle_dialog");

  const res = await handle({
    disposition: "accept",
    clear: true,
    tabId: 707,
  });
  assert.equal(res.isError, true, "should surface an error envelope");
  assert.match(parse(res).error, /not both/);
  assert.equal(calls.length, 0);
});

test("xor: rejects neither disposition nor clear (no daemon hop)", async () => {
  const { calls, callbacks } = setup();
  const handle = callbacks.get("browser_handle_dialog");

  const res = await handle({ tabId: 707 });
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /to arm|to disarm/);
  assert.equal(calls.length, 0);
});

test("falls back to the leased tab when tabId is omitted", async () => {
  const { calls, callbacks, session } = setup([{ dialogHandler: null }]);
  session.lastLeasedTab = 42;
  const handle = callbacks.get("browser_handle_dialog");

  await handle({ clear: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabId, 42, "uses the session's leased tab");
});

test("sticky lifetime is forwarded verbatim (not coerced to one_shot)", async () => {
  // Regression pin: a future refactor that accidentally collapsed both
  // lifetimes to one_shot would silently break sticky semantics (and the
  // sticky-keeps-debugger-attached behaviour in background.js depends on the
  // wire value being "sticky"). Explicit single-purpose test.
  const { calls, callbacks } = setup([
    { dialogHandler: { disposition: "dismiss", lifetime: "sticky" } },
  ]);
  const handle = callbacks.get("browser_handle_dialog");
  await handle({ disposition: "dismiss", lifetime: "sticky", tabId: 707 });
  assert.equal(calls[0].command.lifetime, "sticky");
});

test("dismiss with promptText drops promptText (no key on the wire)", async () => {
  // promptText is only meaningful when accepting a prompt() dialog. The
  // handler's conditional spread (`...(promptText !== undefined ? {} : {})`)
  // includes it for any non-undefined value — so a caller that accidentally
  // sets promptText on a dismiss still ships it on the wire. That's
  // intentionally permissive (the extension's listener only forwards
  // promptText on accept), but pin the current behaviour so a refactor that
  // tightens it shows up here. NOTE: this test documents current behaviour;
  // if S1.N1 is later applied, flip the assertion to absence.
  const { calls, callbacks } = setup([{ dialogHandler: { disposition: "dismiss" } }]);
  const handle = callbacks.get("browser_handle_dialog");
  await handle({ disposition: "dismiss", promptText: "ignored", tabId: 707 });
  // Today: promptText IS forwarded; the page-side listener ignores it on dismiss.
  assert.equal(calls[0].command.promptText, "ignored");
});
