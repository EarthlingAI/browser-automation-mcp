// Daemon-side watchdog inference. The 30s default protects every non-wait_for
// command; wait_for commands get (command.timeout ?? 10_000) + 5_000 so the
// extension's polite "predicate did not become truthy" response can fire
// before the daemon's safety net.

import test from "node:test";
import assert from "node:assert/strict";
import { inferExtTimeout } from "../../dist/test-exports.mjs";

test("inferExtTimeout: non-wait_for commands get the 30s default", () => {
  assert.equal(inferExtTimeout({ kind: "click", ref: "1" }), 30_000);
  assert.equal(
    inferExtTimeout({ kind: "snapshot_capture", withTree: true, withScreenshot: false }),
    30_000,
  );
  assert.equal(inferExtTimeout({ kind: "evaluate", expression: "1+1" }), 30_000);
  assert.equal(inferExtTimeout({ kind: "tabs_query" }), 30_000);
});

test("inferExtTimeout: wait_for with explicit timeout adds 5s buffer", () => {
  assert.equal(
    inferExtTimeout({ kind: "wait_for", condition: "true", timeout: 60_000 }),
    65_000,
  );
  // Schema max 300_000 → daemon allows 305_000
  assert.equal(
    inferExtTimeout({ kind: "wait_for", condition: "true", timeout: 300_000 }),
    305_000,
  );
});

test("inferExtTimeout: wait_for with undefined timeout defaults to 10s+5s", () => {
  // Mirrors the extension's own default at runWaitForCondition. Defensive —
  // the bridge schema always sets timeout, but the daemon shouldn't assume.
  assert.equal(
    inferExtTimeout({ kind: "wait_for", condition: "true" }),
    15_000,
  );
});
