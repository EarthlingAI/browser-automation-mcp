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

function parseMixedText(env) {
  // Image at index 0 (Anthropic vision attention ordering), text at index 1.
  assert.equal(env.content.length, 2);
  assert.equal(env.content[0].type, "image");
  assert.equal(env.content[1].type, "text");
  return JSON.parse(env.content[1].text);
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

// Round 5 — mixed-content envelope. Unified-capture calls (browser_snapshot and
// the auto-snapshot replay path) emit a native MCP image content block alongside
// the text payload so vision-capable hosts can attend to the picture directly.

test("toolResult: with image arg emits image-then-text mixed envelope", () => {
  const env = toolResult(
    { format: "jpeg", tree: { ref: "0", role: "WebArea" } },
    undefined,
    { data: "abc", mimeType: "image/jpeg" },
  );
  assert.equal(env.content.length, 2);
  // Image FIRST — Anthropic vision attention reliability.
  assert.equal(env.content[0].type, "image");
  assert.equal(env.content[0].data, "abc");
  assert.equal(env.content[0].mimeType, "image/jpeg");
  assert.equal(env.content[1].type, "text");
  const decoded = parseMixedText(env);
  assert.equal(decoded.format, "jpeg");
});

test("toolResult: without image arg keeps the single-text envelope", () => {
  // Existing behaviour must be preserved for every non-unified-capture tool.
  const env = toolResult({ hello: "world" });
  assert.equal(env.content.length, 1);
  assert.equal(env.content[0].type, "text");
});

test("toolResult: text payload never carries the image bytes (no double-tokenisation)", () => {
  // The original screenshot tool stuffed base64 into the JSON. The mixed
  // envelope eliminates that — the text block must NOT contain dataBase64.
  const env = toolResult(
    { format: "jpeg", resizedTo: { width: 1024, height: 768 } },
    undefined,
    { data: "x".repeat(10_000), mimeType: "image/jpeg" },
  );
  const decoded = parseMixedText(env);
  assert.equal("dataBase64" in decoded, false);
  // And the text length is small (no base64 leakage) regardless of image size.
  assert.ok(
    env.content[1].text.length < 1_000,
    `text payload is ${env.content[1].text.length} bytes — image must not leak in`,
  );
});

test("toolResult: PNG image gets image/png mimeType", () => {
  const env = toolResult(
    { format: "png" },
    undefined,
    { data: "y", mimeType: "image/png" },
  );
  assert.equal(env.content[0].mimeType, "image/png");
});

// Regression guard for the `isCaptureResult` duck-type in registry.ts. A
// future tool handler accidentally returning `{payload: "txn-1234"}` (string
// payload) would be misinterpreted as a CaptureResult and JSON-stringified
// differently. The guard requires `payload` to be a non-null object — this
// test confirms toolResult itself never infers, so the only path that turns
// `{payload, image?}` into a mixed envelope is the explicit one in
// `registerTool`'s wrapper.

test("toolResult passthrough: { payload: <primitive> } stays as plain envelope", () => {
  const env = toolResult({ payload: "txn-1234" });
  assert.equal(env.content.length, 1);
  const decoded = parseText(env);
  assert.deepEqual(decoded, { payload: "txn-1234" });
});
