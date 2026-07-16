// browser_type(trusted) — bridge-side wiring for trusted text entry into
// controlled rich-text editors (DraftJS/Slate, e.g. TikTok's DM composer). A
// synthetic value-set / execCommand insert (the default path) lands in the DOM
// but never reaches the editor's internal model, so its send affordance stays
// disarmed and the text is inert. The real CDP Input.insertText dispatch lives
// in background.js (extension-side) and can't be unit-tested without Chrome;
// this pins the bridge contract: browser_type forwards the `trusted` flag on the
// `type` ExtCommand so the extension routes to the trusted path.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  registerInteractTools,
} from "../../dist/test-exports.mjs";

const TAB = 707;

// Seed a session with a live ref so execOnLeasedTab's ref validation passes and
// the type command reaches the daemon hop.
function setup(responses = [], { refs = {} } = {}) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  session.lastSnapshotTabId = TAB;
  session.lastLeasedTab = TAB;
  session.isStale = false;
  for (const [ref, rect] of Object.entries(refs)) {
    const meta = { role: "textbox", tabId: TAB, snapshotAt: Date.now(), rect };
    session.lastSnapshotRefs.set(ref, meta);
    session.refRegistry.set(ref, meta);
  }
  const daemon = {
    sessionId: "test-type-trusted",
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

test("browser_type(trusted) forwards trusted:true on the type command", async () => {
  const { calls, callbacks } = setup([{ typed: "hi", trusted: true }], {
    refs: { 5: { x: 10, y: 10, w: 100, h: 20 } },
  });
  const type = callbacks.get("browser_type");
  assert.ok(type, "browser_type should be registered");
  await type({ ref: "5", text: "hi", append: false, trusted: true, tabId: TAB });

  assert.equal(calls.length, 1, "exactly one daemon hop");
  const c = calls[0].command;
  assert.equal(c.kind, "type");
  assert.equal(c.ref, "5");
  assert.equal(c.text, "hi");
  assert.equal(c.append, false);
  assert.equal(c.trusted, true, "trusted flag forwarded for the CDP insert path");
});

test("browser_type(trusted:false) forwards trusted:false (synthetic path)", async () => {
  const { calls, callbacks } = setup([{ typed: "hi" }], {
    refs: { 5: { x: 10, y: 10, w: 100, h: 20 } },
  });
  const type = callbacks.get("browser_type");
  await type({ ref: "5", text: "hi", append: false, trusted: false, tabId: TAB });
  assert.equal(calls[0].command.kind, "type");
  assert.equal(calls[0].command.trusted, false);
});
