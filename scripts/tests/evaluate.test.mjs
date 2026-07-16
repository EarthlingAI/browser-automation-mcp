// Regression test for Issue #2 — browser_evaluate must return primitive
// strings as strings, not as char-indexed objects (`{0:"h",1:"e",...}`).
//
// Root cause of the original bug was in the action-tool wrapper which did
// `{...result}` on the handler's return value — spreading a string produces a
// char-indexed object. The fix detects primitives and wraps them under a
// `result` key instead.
//
// This test exercises the wrapper end-to-end with a stubbed daemon that
// returns the string verbatim, and asserts the envelope shape.

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerInteractTools,
  BridgeSession,
} from "../../dist/test-exports.mjs";

function captureRegistration(name) {
  const captured = new Map();
  const fakeServer = {
    registerTool(toolName, config, cb) {
      captured.set(toolName, { config, cb });
    },
  };
  const stubDaemon = {
    sessionId: "test-session",
    takeEnv: () => undefined,
    peekEnv: () => undefined,
    // browser_evaluate runs through execOnLeasedTab → daemon.exec → returns
    // the value verbatim. The bug used to live in the wrapper *after* this.
    async exec(_tabId, command) {
      if (command.kind === "evaluate") {
        // Pretend the page returned a 60-char URL. If the wrapper's
        // primitive-handling is wrong, this string becomes a char-indexed
        // object on the way to the envelope.
        return "https://chatgpt.com/c/6a05538f-1234-5678-9abc-def012345678";
      }
      throw new Error("unexpected command kind: " + command.kind);
    },
  };
  const session = new BridgeSession();
  // Pretend a switch_tab has already happened.
  session.lastLeasedTab = 99;
  const ctx = { daemon: stubDaemon, session };
  registerInteractTools(fakeServer, ctx);
  if (!captured.has(name))
    throw new Error(`tool ${name} not registered`);
  return captured.get(name);
}

function parsePayload(envelope) {
  assert.equal(envelope.content.length, 1);
  return JSON.parse(envelope.content[0].text);
}

test("browser_evaluate returns a string as a string, not a char-indexed object", async () => {
  const { cb } = captureRegistration("browser_evaluate");
  // Pass snapshot:false so the wrapper doesn't try to call replaySnapshot
  // (which would round-trip back through the daemon).
  const envelope = await cb({
    expression: "location.href",
    snapshot: false,
    delay: 0,
    wait_for_settle: "none",
    settle_timeout: 0,
  });
  const decoded = parsePayload(envelope);
  // The string must round-trip as a string under the `result` key.
  assert.equal(typeof decoded.result, "string");
  assert.equal(
    decoded.result,
    "https://chatgpt.com/c/6a05538f-1234-5678-9abc-def012345678",
  );
  // And critically, must NOT be a char-indexed object — no keys like 0, 1, 2.
  assert.equal(
    "0" in decoded,
    false,
    "envelope decoded into char-indexed object — primitive-handling regression",
  );
  assert.equal(
    "1" in decoded,
    false,
    "envelope decoded into char-indexed object — primitive-handling regression",
  );
  // Also pin the exact lean-JSON envelope text so a regression to pretty-
  // printing (`JSON.stringify(payload, null, 2)`) or a stray field surfaces
  // in the diff. The single-key payload here has a deterministic shape.
  assert.equal(
    envelope.content[0].text,
    '{"result":"https://chatgpt.com/c/6a05538f-1234-5678-9abc-def012345678"}',
  );
});
