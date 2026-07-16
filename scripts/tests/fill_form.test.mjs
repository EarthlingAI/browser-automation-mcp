// browser_fill_form — bridge-side batch fill (CP6). Mock-daemon tests asserting
// that the tool issues the right sequence of type/select_option/click
// ExtCommands (it reuses the existing single-field actions — no new page-side
// handler), defaults `kind` to "type", and rejects a type/select_option field
// that omits `value`. The handler runs inside registerActionTool's wrapper, so a
// thrown error surfaces as an `isError` envelope (toolError), not a rejection.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  registerInteractTools,
} from "../../dist/test-exports.mjs";

const TAB = 555;

// Register the interact tools against a fake server that captures each tool's
// callback, wired to a mock daemon that records every exec and returns canned
// responses. Seeds the session so the batch's refs resolve without a liveness
// probe (refs present in the latest snapshot + isStale:false ⇒ trusted).
function setup(responses = []) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  session.lastSnapshotTabId = TAB;
  session.lastLeasedTab = TAB;
  session.isStale = false;
  for (const r of ["1", "2", "3"]) {
    const meta = { role: "textbox", tabId: TAB, snapshotAt: Date.now() };
    session.lastSnapshotRefs.set(r, meta);
    session.refRegistry.set(r, meta);
  }
  const daemon = {
    sessionId: "test-fillform",
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
  registerInteractTools(server, { daemon, session });
  return { calls, callbacks, session };
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("fill_form issues type/select_option/click ExtCommands in order", async () => {
  const { calls, callbacks } = setup([{ typed: 1 }, { selected: 1 }, { clicked: 1 }]);
  const fill = callbacks.get("browser_fill_form");
  assert.ok(fill, "browser_fill_form should be registered");

  const res = await fill({
    fields: [
      { ref: "1", value: "alice", kind: "type" },
      { ref: "2", value: "AU", kind: "select_option" },
      { ref: "3", kind: "click" },
    ],
    tabId: TAB,
  });

  assert.equal(calls.length, 3, "one daemon hop per field");
  assert.deepEqual(calls[0].command, {
    kind: "type",
    ref: "1",
    text: "alice",
    append: false,
  });
  assert.deepEqual(calls[1].command, {
    kind: "select_option",
    ref: "2",
    value: "AU",
  });
  assert.deepEqual(calls[2].command, { kind: "click", ref: "3" });
  // No settle injected on any field — fill_form clears pendingSettle so the
  // batch runs back-to-back (no `settle` key on the wire commands).
  for (const c of calls) assert.equal(c.command.settle, undefined);
  // All three target the leased tab.
  for (const c of calls) assert.equal(c.tabId, TAB);

  const payload = parse(res);
  assert.equal(payload.filled, 3);
});

test("fill_form defaults kind to type when omitted", async () => {
  const { calls, callbacks } = setup([{ typed: 1 }]);
  const fill = callbacks.get("browser_fill_form");
  await fill({ fields: [{ ref: "1", value: "hello" }], tabId: TAB });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].command, {
    kind: "type",
    ref: "1",
    text: "hello",
    append: false,
  });
});

test("fill_form rejects a type field with no value (no daemon hop)", async () => {
  const { calls, callbacks } = setup();
  const fill = callbacks.get("browser_fill_form");
  // kind defaults to "type"; value omitted → the handler throws before any hop.
  const res = await fill({ fields: [{ ref: "1" }], tabId: TAB });
  assert.equal(res.isError, true, "should surface an error envelope");
  assert.match(parse(res).error, /requires a value/);
  assert.equal(calls.length, 0, "no field should have been sent");
});

test("fill_form rejects a select_option field with no value", async () => {
  const { calls, callbacks } = setup();
  const fill = callbacks.get("browser_fill_form");
  const res = await fill({
    fields: [{ ref: "2", kind: "select_option" }],
    tabId: TAB,
  });
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /select_option.*requires a value/);
  assert.equal(calls.length, 0);
});
