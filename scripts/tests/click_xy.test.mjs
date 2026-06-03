// browser_click_xy / browser_click(trusted) / browser_press_key(trusted) —
// bridge-side wiring (Phase 2, trusted CDP coordinate input). The real
// Input.dispatchMouseEvent / dispatchKeyEvent sequence lives in background.js
// (extension-side) and can't be unit-tested without Chrome; these tests pin the
// bridge contract: coordinate validation against the last-known viewport, the
// trusted-click ref→centre resolution, and the ExtCommand shapes forwarded to
// the leased tab.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  registerInteractTools,
} from "../../dist/test-exports.mjs";

const TAB = 707;

// Seed a session with optional refs (each given a rect so trusted-click can
// compute a centre) and an optional viewport for the bounds check.
function setup(responses = [], { refs = {}, viewport } = {}) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  session.lastSnapshotTabId = TAB;
  session.lastLeasedTab = TAB;
  session.isStale = false;
  if (viewport) session.lastViewport = viewport;
  for (const [ref, rect] of Object.entries(refs)) {
    const meta = { role: "button", tabId: TAB, snapshotAt: Date.now(), rect };
    session.lastSnapshotRefs.set(ref, meta);
    session.refRegistry.set(ref, meta);
  }
  const daemon = {
    sessionId: "test-click-xy",
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

test("browser_click_xy forwards a click_xy ExtCommand with coordinates + options", async () => {
  const { calls, callbacks } = setup([{ clicked: { x: 100, y: 200 }, trusted: true }]);
  const click_xy = callbacks.get("browser_click_xy");
  assert.ok(click_xy, "browser_click_xy should be registered");

  await click_xy({
    x: 100,
    y: 200,
    button: "left",
    clickCount: 2,
    modifiers: ["Shift"],
    tabId: TAB,
  });

  assert.equal(calls.length, 1, "exactly one daemon hop");
  assert.equal(calls[0].tabId, TAB);
  const c = calls[0].command;
  assert.equal(c.kind, "click_xy");
  assert.equal(c.x, 100);
  assert.equal(c.y, 200);
  assert.equal(c.button, "left");
  assert.equal(c.clickCount, 2);
  assert.deepEqual(c.modifiers, ["Shift"]);
  // click_xy carries no ref → no resolve_ref probe was inserted.
});

test("browser_click_xy rejects a coordinate outside the known viewport before any daemon hop", async () => {
  const { calls, callbacks } = setup([], { viewport: { w: 1280, h: 800 } });
  const click_xy = callbacks.get("browser_click_xy");
  const res = await click_xy({ x: 2000, y: 400, button: "left", clickCount: 1, tabId: TAB });
  assert.equal(res.isError, true, "should surface an error envelope");
  const body = parse(res);
  assert.match(body.error, /outside the 1280×800 viewport/);
  assert.match(body.hint, /re-run browser_snapshot/);
  assert.equal(calls.length, 0, "no click should have been sent");
});

test("browser_click_xy is best-effort when no viewport is known yet (lets it through)", async () => {
  const { calls, callbacks } = setup([{ clicked: { x: 5000, y: 5000 }, trusted: true }]);
  const click_xy = callbacks.get("browser_click_xy");
  // No snapshot yet ⇒ session.lastViewport unset ⇒ bounds check is skipped.
  await click_xy({ x: 5000, y: 5000, button: "left", clickCount: 1, tabId: TAB });
  assert.equal(calls.length, 1, "click should be forwarded despite large coords");
  assert.equal(calls[0].command.kind, "click_xy");
});

test("browser_click(trusted) resolves the ref's rect centre into a click_xy command", async () => {
  const { calls, callbacks } = setup([{ clicked: { x: 60, y: 120 }, trusted: true }], {
    refs: { 5: { x: 50, y: 100, w: 20, h: 40 } },
    viewport: { w: 1280, h: 800 },
  });
  const click = callbacks.get("browser_click");
  await click({ ref: "5", button: "left", clickCount: 1, trusted: true, tabId: TAB });

  assert.equal(calls.length, 1, "exactly one daemon hop (centre computed bridge-side)");
  const c = calls[0].command;
  assert.equal(c.kind, "click_xy", "trusted click escalates to click_xy");
  assert.equal(c.x, 60, "centre X = rect.x + w/2");
  assert.equal(c.y, 120, "centre Y = rect.y + h/2");
});

test("browser_click(trusted) on a rect-less ref errors before any daemon hop", async () => {
  const { calls, callbacks, session } = setup([], {});
  // Seed a ref with NO rect (e.g. a synthetic root that was never laid out).
  const meta = { role: "button", tabId: TAB, snapshotAt: Date.now() };
  session.lastSnapshotRefs.set("9", meta);
  session.refRegistry.set("9", meta);
  const click = callbacks.get("browser_click");
  const res = await click({ ref: "9", button: "left", clickCount: 1, trusted: true, tabId: TAB });
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /no bounding rect/);
  assert.equal(calls.length, 0, "no command should have been sent");
});

test("browser_click(trusted) liveness-probes a stale ref and proceeds to click_xy when live", async () => {
  // refNeedsVerification is true when isStale ⇒ a resolve_ref probe runs first;
  // a live (truthy) probe lets the trusted click proceed with the snapshot rect.
  const { calls, callbacks, session } = setup(
    [{ name: "Save", role: "button", rect: { x: 50, y: 100, w: 20, h: 40 } }, { clicked: { x: 60, y: 120 }, trusted: true }],
    { refs: { 5: { x: 50, y: 100, w: 20, h: 40 } } },
  );
  session.isStale = true; // force the liveness probe
  const click = callbacks.get("browser_click");
  await click({ ref: "5", button: "left", clickCount: 1, trusted: true, tabId: TAB });
  assert.equal(calls.length, 2, "resolve_ref probe + click_xy");
  assert.equal(calls[0].command.kind, "resolve_ref");
  assert.equal(calls[1].command.kind, "click_xy");
  assert.equal(calls[1].command.x, 60, "uses the snapshot rect centre, not the probe rect");
});

test("browser_click(trusted) errors when the liveness probe shows the element is gone", async () => {
  const { calls, callbacks, session } = setup([null], {
    refs: { 5: { x: 50, y: 100, w: 20, h: 40 } },
  });
  session.isStale = true; // force the probe; daemon returns null ⇒ gone
  const click = callbacks.get("browser_click");
  const res = await click({ ref: "5", button: "left", clickCount: 1, trusted: true, tabId: TAB });
  assert.equal(res.isError, true);
  assert.match(parse(res).error, /no longer exists/);
  assert.equal(calls.length, 1, "only the resolve_ref probe ran; no click_xy");
  assert.equal(calls[0].command.kind, "resolve_ref");
});

test("browser_click(trusted:false) stays on the synthetic click path", async () => {
  const { calls, callbacks } = setup([{ clicked: "5" }], {
    refs: { 5: { x: 50, y: 100, w: 20, h: 40 } },
  });
  const click = callbacks.get("browser_click");
  await click({ ref: "5", button: "left", clickCount: 1, trusted: false, tabId: TAB });
  assert.equal(calls[0].command.kind, "click", "non-trusted stays synthetic");
  assert.equal(calls[0].command.ref, "5");
});

test("browser_press_key(trusted) forwards the trusted flag on the press_key command", async () => {
  const { calls, callbacks } = setup([{ pressed: "Enter", trusted: true }]);
  const press = callbacks.get("browser_press_key");
  await press({ key: "Enter", modifiers: ["Control"], trusted: true, tabId: TAB });
  const c = calls[0].command;
  assert.equal(c.kind, "press_key");
  assert.equal(c.key, "Enter");
  assert.equal(c.trusted, true);
  assert.deepEqual(c.modifiers, ["Control"]);
});

test("browser_press_key(trusted:false) forwards trusted:false (synthetic path)", async () => {
  const { calls, callbacks } = setup([{ pressed: "a" }]);
  const press = callbacks.get("browser_press_key");
  await press({ key: "a", trusted: false, tabId: TAB });
  assert.equal(calls[0].command.kind, "press_key");
  assert.equal(calls[0].command.trusted, false);
});
