// browser_resize — bridge-side wiring (CP6). The real work (CDP
// Emulation.setDeviceMetricsOverride) lives in background.js and can't be
// unit-tested without Chrome, so these tests pin the bridge contract: the tool
// forwards a `resize` ExtCommand carrying width/height to the leased tab, with
// no settle (resize isn't a settleable page-mutation kind) and no ref
// validation (it carries no ref).

import test from "node:test";
import assert from "node:assert/strict";
import { BridgeSession, registerTabTools } from "../../dist/test-exports.mjs";

function setup(responses = []) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  const daemon = {
    sessionId: "test-resize",
    takeEnv: () => undefined,
    peekEnv: () => undefined,
    async exec(tabId, command) {
      calls.push({ tabId, command });
      if (queue.length === 0)
        throw new Error(`unexpected daemon.exec call: ${command.kind}`);
      return queue.shift();
    },
    // Acted-tab identity for the surface member's target/title — browser_resize
    // is one of the "tab" action tools that DOES exec on the leased tab (unlike
    // list/open/close/switch/release, which are lease-free control-plane calls
    // and never carry target/title).
    takeTab: () => ({ url: "https://responsive.test/preview", title: "Responsive Preview" }),
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

test("resize forwards a resize ExtCommand to the explicit tabId", async () => {
  const { calls, callbacks } = setup([{ resized: { width: 390, height: 844 } }]);
  const resize = callbacks.get("browser_resize");
  assert.ok(resize, "browser_resize should be registered");

  const res = await resize({ width: 390, height: 844, tabId: 700, snapshot: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabId, 700);
  assert.deepEqual(calls[0].command, { kind: "resize", width: 390, height: 844 });
  // resize is not a settleable kind — no settle policy is injected.
  assert.equal(calls[0].command.settle, undefined);
  // browser_resize's static action is "tab" — surface leads and (unlike the
  // lease-free tab-list/open/close/switch/release tools) carries the acted
  // tab's host/title, since resize does exec on the leased tab.
  const decoded = JSON.parse(res.content[0].text);
  assert.deepEqual(Object.keys(decoded)[0], "surface");
  assert.deepEqual(decoded.surface, {
    kind: "automation",
    app: "Chrome",
    action: "tab",
    target: "responsive.test",
    title: "Responsive Preview",
  });
});

test("resize falls back to the leased tab when tabId is omitted", async () => {
  const { calls, callbacks, session } = setup([
    { resized: { width: 1280, height: 720 } },
  ]);
  session.lastLeasedTab = 42;
  const resize = callbacks.get("browser_resize");

  await resize({ width: 1280, height: 720 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tabId, 42, "uses the session's leased tab");
  assert.deepEqual(calls[0].command, {
    kind: "resize",
    width: 1280,
    height: 720,
  });
});
