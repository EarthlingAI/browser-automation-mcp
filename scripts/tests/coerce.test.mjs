// Defensive coercion sweep across schema params. The Anthropic agent SDK
// (and others in the wild) stringifies typed args on the wire — e.g.
// tabId=1594871391 arrives as "1594871391", force=true as "true",
// methodIn=["POST"] as '["POST"]'. The bridge schemas must tolerate that.

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTabTools,
  registerObserveTools,
  registerInteractTools,
  BridgeSession,
  coerceToArray,
  coerceLiteralNumber,
  coerceBoolean,
} from "../../dist/test-exports.mjs";
import { z } from "zod";

function collectRegisteredTools() {
  const captured = new Map();
  const fakeServer = {
    registerTool(name, config) {
      captured.set(name, config);
    },
  };
  const ctx = {
    daemon: { sessionId: "test-session" },
    session: new BridgeSession(),
  };
  registerTabTools(fakeServer, ctx);
  registerObserveTools(fakeServer, ctx);
  registerInteractTools(fakeServer, ctx);
  return captured;
}

function schemaFor(toolName) {
  const tools = collectRegisteredTools();
  const cfg = tools.get(toolName);
  assert.ok(cfg, `tool ${toolName} not registered`);
  return z.object(cfg.inputSchema);
}

test("coerceToArray: array passes through", () => {
  assert.deepEqual(coerceToArray(["a", "b"]), ["a", "b"]);
});

test("coerceToArray: JSON-string array parses", () => {
  assert.deepEqual(coerceToArray('["POST","GET"]'), ["POST", "GET"]);
});

test("coerceToArray: bare string wraps into single-element array", () => {
  assert.deepEqual(coerceToArray("POST"), ["POST"]);
});

test("coerceToArray: undefined/null pass through", () => {
  assert.equal(coerceToArray(undefined), undefined);
  assert.equal(coerceToArray(null), null);
});

test("coerceLiteralNumber: numeric string becomes number", () => {
  assert.equal(coerceLiteralNumber("2"), 2);
  assert.equal(coerceLiteralNumber(2), 2);
});

test("coerceBoolean: 'true' / 'false' / 'TRUE' / '0' / '1' map correctly", () => {
  assert.equal(coerceBoolean("true"), true);
  assert.equal(coerceBoolean("false"), false);
  assert.equal(coerceBoolean("TRUE"), true);
  assert.equal(coerceBoolean("False"), false);
  assert.equal(coerceBoolean("1"), true);
  assert.equal(coerceBoolean("0"), false);
  assert.equal(coerceBoolean(true), true);
  assert.equal(coerceBoolean(false), false);
});

test("coerceBoolean: empty string falls through unchanged (preserves .default)", () => {
  // Critical: must NOT map "" to false. Doing so flips background:"" to
  // false and would activate a new tab — violating invariant #1.
  assert.equal(coerceBoolean(""), "");
});

test("tabId accepts stringified number across tools", () => {
  // Sample tools across all three groups — interact, observe, tabs.
  for (const name of ["browser_click", "browser_snapshot", "browser_close_tab"]) {
    const s = schemaFor(name);
    const r = s.safeParse({ tabId: "1594871391", ref: "1" });
    assert.ok(r.success, `${name}: ${r.error?.message ?? ""}`);
    assert.equal(r.data.tabId, 1594871391);
  }
});

test("browser_switch_tab.force accepts 'true'/'false' strings", () => {
  const s = schemaFor("browser_switch_tab");
  const r1 = s.safeParse({ tabId: 1, force: "true", reason: "x" });
  assert.ok(r1.success, r1.error?.message);
  assert.equal(r1.data.force, true);
  const r2 = s.safeParse({ tabId: 1, force: "false" });
  assert.ok(r2.success, r2.error?.message);
  assert.equal(r2.data.force, false);
});

test("browser_click.modifiers accepts single string AND JSON-string array", () => {
  const s = schemaFor("browser_click");
  const r1 = s.safeParse({ ref: "1", modifiers: "Shift" });
  assert.ok(r1.success, r1.error?.message);
  assert.deepEqual(r1.data.modifiers, ["Shift"]);
  const r2 = s.safeParse({ ref: "1", modifiers: '["Shift","Control"]' });
  assert.ok(r2.success, r2.error?.message);
  assert.deepEqual(r2.data.modifiers, ["Shift", "Control"]);
});

test("browser_network_requests.methodIn accepts stringified enum array", () => {
  const s = schemaFor("browser_network_requests");
  const r = s.safeParse({ methodIn: '["POST","GET"]' });
  assert.ok(r.success, r.error?.message);
  assert.deepEqual(r.data.methodIn, ["POST", "GET"]);
});

test("browser_click.clickCount coerces from string", () => {
  const s = schemaFor("browser_click");
  const r = s.safeParse({ ref: "1", clickCount: "2" });
  assert.ok(r.success, r.error?.message);
  assert.equal(r.data.clickCount, 2);
});

test("browser_type.append coerces string boolean", () => {
  const s = schemaFor("browser_type");
  const r = s.safeParse({ ref: "1", text: "hi", append: "true" });
  assert.ok(r.success, r.error?.message);
  assert.equal(r.data.append, true);
});

test("browser_wait_for.timeout + pollIntervalMs coerce", () => {
  const s = schemaFor("browser_wait_for");
  const r = s.safeParse({
    condition: "true",
    timeout: "60000",
    poll_interval_ms: "500",
  });
  assert.ok(r.success, r.error?.message);
  assert.equal(r.data.timeout, 60000);
  assert.equal(r.data.poll_interval_ms, 500);
});
