// browser_draw — bridge-side wiring (Phase 2, trusted CDP coordinate input).
// The real Input.dispatchMouseEvent stroke (press → moves → release, button
// held) lives in background.js (extension-side) and can't be unit-tested without
// Chrome; these tests pin the bridge contract: every point is bounds-checked
// against the known viewport, then a single `draw` ExtCommand carrying the full
// point list + button is forwarded to the leased tab.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BridgeSession,
  registerInteractTools,
} from "../../dist/test-exports.mjs";

const TAB = 808;

function setup(responses = [], { viewport } = {}) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  session.lastSnapshotTabId = TAB;
  session.lastLeasedTab = TAB;
  session.isStale = false;
  if (viewport) session.lastViewport = viewport;
  const daemon = {
    sessionId: "test-draw",
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

test("browser_draw forwards a single draw ExtCommand carrying all points + button", async () => {
  const { calls, callbacks } = setup([{ drew: { points: 3 } }], {
    viewport: { w: 1280, h: 800 },
  });
  const draw = callbacks.get("browser_draw");
  assert.ok(draw, "browser_draw should be registered");

  const points = [
    { x: 10, y: 10 },
    { x: 20, y: 30 },
    { x: 40, y: 60 },
  ];
  await draw({ points, button: "left", tabId: TAB });

  assert.equal(calls.length, 1, "exactly one daemon hop");
  assert.equal(calls[0].tabId, TAB);
  const c = calls[0].command;
  assert.equal(c.kind, "draw");
  assert.deepEqual(c.points, points);
  assert.equal(c.button, "left");
});

test("browser_draw rejects when any point falls outside the known viewport", async () => {
  const { calls, callbacks } = setup([], { viewport: { w: 1000, h: 600 } });
  const draw = callbacks.get("browser_draw");
  const res = await draw({
    points: [
      { x: 10, y: 10 },
      { x: 1200, y: 50 }, // outside
    ],
    button: "left",
    tabId: TAB,
  });
  assert.equal(res.isError, true, "should surface an error envelope");
  assert.match(parse(res).error, /outside the 1000×600 viewport/);
  assert.equal(calls.length, 0, "no draw should have been sent");
});

test("browser_draw is best-effort when no viewport is known yet", async () => {
  const { calls, callbacks } = setup([{ drew: { points: 2 } }]);
  const draw = callbacks.get("browser_draw");
  await draw({
    points: [
      { x: 9000, y: 9000 },
      { x: 9100, y: 9100 },
    ],
    button: "left",
    tabId: TAB,
  });
  assert.equal(calls.length, 1, "draw should be forwarded despite large coords");
  assert.equal(calls[0].command.kind, "draw");
});
