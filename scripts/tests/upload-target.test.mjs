// browser_upload targeting: at most one of `ref` or `selector`; NEITHER is
// the chooser-fulfilment mode (answers the tab's pending intercepted native
// file chooser with local paths).
//
// The tool schema is a flat ZodRawShape (no cross-field validator), so the
// targeting rule is enforced in the handler. This test captures the
// registered callback and drives it to assert the guard fires on both, and
// passes through on a single target or none (failing later for a different
// reason — a nonexistent file / no leased tab).

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerInteractTools,
  BridgeSession,
} from "../../dist/test-exports.mjs";

function captureUploadCallback() {
  let cb;
  const fakeServer = {
    registerTool(name, _config, callback) {
      if (name === "browser_upload") cb = callback;
    },
  };
  const ctx = {
    daemon: {
      sessionId: "test-session",
      takeEnv: () => undefined,
      peekEnv: () => undefined,
    },
    session: new BridgeSession(),
  };
  registerInteractTools(fakeServer, ctx);
  assert.ok(cb, "browser_upload callback was not captured");
  return cb;
}

async function errorText(cb, args) {
  const res = await cb({ ...args, snapshot: false });
  assert.equal(res.isError, true, "expected an error result");
  return JSON.parse(res.content[0].text).error;
}

test("neither ref nor selector = chooser mode (fails later, not on the target guard)", async () => {
  const cb = captureUploadCallback();
  const err = await errorText(cb, { files: ["/nope.png"] });
  assert.doesNotMatch(err, /at most one of/);
});

test("rejects both ref and selector", async () => {
  const cb = captureUploadCallback();
  const err = await errorText(cb, {
    ref: "e1",
    selector: "input[type=file]",
    files: ["/nope.png"],
  });
  assert.match(err, /at most one of/);
});

test("accepts ref-only (fails later, not on the target guard)", async () => {
  const cb = captureUploadCallback();
  const err = await errorText(cb, { ref: "e1", files: ["/nonexistent.png"] });
  assert.doesNotMatch(err, /at most one of/);
});

test("accepts selector-only (fails later, not on the target guard)", async () => {
  const cb = captureUploadCallback();
  const err = await errorText(cb, {
    selector: "input[type=file]",
    files: ["/nonexistent.png"],
  });
  assert.doesNotMatch(err, /at most one of/);
});
