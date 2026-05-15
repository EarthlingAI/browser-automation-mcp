// Lean-JSON envelope tests. The Phase 1 contract is:
//   - JSON is emitted without whitespace pretty-printing
//   - null/undefined fields are stripped from error payloads
//   - Array results for the count-wrapped list tools get a `count`+`items`
//     top-level shape so the agent doesn't have to count the array itself.

import test from "node:test";
import assert from "node:assert/strict";
import { toolResult, toolError } from "../../dist/test-exports.mjs";

function parseText(env) {
  assert.equal(env.content.length, 1);
  assert.equal(env.content[0].type, "text");
  return JSON.parse(env.content[0].text);
}

test("toolResult: object passes through verbatim", () => {
  const env = toolResult({ hello: "world" });
  assert.deepEqual(parseText(env), { hello: "world" });
  // No pretty-print whitespace beyond what JSON.stringify produces minimally.
  assert.equal(env.content[0].text, '{"hello":"world"}');
});

test("toolResult: array from list-style tool gets count+items wrapper", () => {
  const items = [
    { id: 1, title: "Tab A" },
    { id: 2, title: "Tab B" },
  ];
  const env = toolResult(items, "browser_list_tabs");
  const decoded = parseText(env);
  assert.equal(decoded.count, 2);
  assert.deepEqual(decoded.items, items);
});

test("toolResult: array WITHOUT a wrapped tool name stays as a raw array", () => {
  // Nested-array safety net: don't auto-wrap if we don't recognise the tool.
  const env = toolResult([1, 2, 3]);
  assert.deepEqual(parseText(env), [1, 2, 3]);
});

test("toolError: omits null/undefined fields cleanly", () => {
  const err = new Error("boom");
  // Mimic a daemon-error with a couple of fields present, others absent.
  err.leasedBy = "agent-a";
  err.hint = "do the thing";
  const env = toolError(err);
  assert.equal(env.isError, true);
  const decoded = parseText(env);
  assert.equal(decoded.error, "boom");
  assert.equal(decoded.leasedBy, "agent-a");
  assert.equal(decoded.hint, "do the thing");
  assert.equal("since" in decoded, false);
  assert.equal("recovery" in decoded, false);
  assert.equal("kind" in decoded, false);
});

test("toolError: surfaces recovery + kind when present", () => {
  const err = new Error("extension not connected");
  err.kind = "extension_disconnected";
  err.recovery = "POST .../reconnect";
  err.hint = err.recovery;
  const env = toolError(err);
  const decoded = parseText(env);
  assert.equal(decoded.kind, "extension_disconnected");
  assert.match(decoded.recovery, /reconnect/);
});
