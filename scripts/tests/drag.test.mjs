// browser_drag — bridge-side wiring (CP7). The synthetic event sequence (HTML5
// DnD or pointer) lives in helpers.js (page-side) and can't be unit-tested
// without Chrome; these tests pin the bridge contract: the tool validates the
// target ref bridge-side (the source ref is validated by execOnLeasedTab), then
// forwards a single `drag` ExtCommand carrying {ref, targetRef, mechanism} to
// the leased tab. A bad target ref errors before any daemon hop.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  registerInteractTools,
} from "../../dist/test-exports.mjs";

const TAB = 909;

// Seed the session so both refs resolve without a liveness probe (present in
// the latest snapshot + isStale:false ⇒ trusted), mirroring fill_form.test.mjs.
function setup(responses = [], refs = ["1", "2"]) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  session.lastSnapshotTabId = TAB;
  session.lastLeasedTab = TAB;
  session.isStale = false;
  for (const r of refs) {
    const meta = { role: "listitem", tabId: TAB, snapshotAt: Date.now() };
    session.lastSnapshotRefs.set(r, meta);
    session.refRegistry.set(r, meta);
  }
  const daemon = {
    sessionId: "test-drag",
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

test("drag forwards a single drag ExtCommand carrying ref/targetRef/mechanism", async () => {
  const { calls, callbacks } = setup([
    { dragged: "1", to: "2", mechanism: "pointer" },
  ]);
  const drag = callbacks.get("browser_drag");
  assert.ok(drag, "browser_drag should be registered");

  await drag({ ref: "1", targetRef: "2", mechanism: "pointer", tabId: TAB });

  assert.equal(
    calls.length,
    1,
    "exactly one daemon hop (both refs validated bridge-side, no extra probe)",
  );
  assert.equal(calls[0].tabId, TAB);
  assert.equal(calls[0].command.kind, "drag");
  assert.equal(calls[0].command.ref, "1");
  assert.equal(calls[0].command.targetRef, "2");
  assert.equal(calls[0].command.mechanism, "pointer");
});

test("drag passes the mechanism through verbatim (native)", async () => {
  const { calls, callbacks } = setup([
    { dragged: "1", to: "2", mechanism: "native" },
  ]);
  const drag = callbacks.get("browser_drag");
  await drag({ ref: "1", targetRef: "2", mechanism: "native", tabId: TAB });
  assert.equal(calls[0].command.mechanism, "native");
});

test("drag defaults mechanism to auto when omitted", async () => {
  // The handler applies `mechanism ?? "auto"` so non-zod callers (and this
  // test, which bypasses schema parsing) still send an explicit "auto" rather
  // than undefined — matching browser_fill_form's `kind ?? "type"` pattern.
  const { calls, callbacks } = setup([
    { dragged: "1", to: "2", mechanism: "pointer" },
  ]);
  const drag = callbacks.get("browser_drag");
  await drag({ ref: "1", targetRef: "2", tabId: TAB });
  assert.equal(calls[0].command.mechanism, "auto");
});

test("drag rejects an unknown target ref before any daemon hop", async () => {
  const { calls, callbacks } = setup([], ["1"]); // only the source ref exists
  const drag = callbacks.get("browser_drag");
  const res = await drag({
    ref: "1",
    targetRef: "99",
    mechanism: "auto",
    tabId: TAB,
  });
  assert.equal(res.isError, true, "should surface an error envelope");
  assert.match(parse(res).error, /99 not found/);
  assert.equal(calls.length, 0, "no drag should have been sent");
});
