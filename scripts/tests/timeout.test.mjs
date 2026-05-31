// Daemon-side watchdog inference. The 30s default protects slow commands
// (page loads, screenshots, evaluate, upload). Synthetic-event action kinds
// get a tighter 10s budget so a wedged action surfaces in ~10s, not 30s —
// the defensive backup for the page-side safe-default dialog auto-dismiss
// (invariant #35). wait_for commands get (command.timeout ?? 10_000) + 5_000
// so the extension's polite "predicate did not become truthy" response can
// fire before the daemon's safety net.

import test from "node:test";
import assert from "node:assert/strict";
import { inferExtTimeout } from "../../dist/test-exports.mjs";

test("inferExtTimeout: fast synthetic-event action kinds get the 10s budget", () => {
  // Every synthetic-event action that flows through helpers.js::__mcpAct gets
  // the tighter budget — they all complete in ms plus the 1.5s settle.
  assert.equal(inferExtTimeout({ kind: "click", ref: "1" }), 10_000);
  assert.equal(inferExtTimeout({ kind: "type", ref: "1", text: "x" }), 10_000);
  assert.equal(
    inferExtTimeout({ kind: "select_option", ref: "1", value: "x" }),
    10_000,
  );
  assert.equal(inferExtTimeout({ kind: "hover", ref: "1" }), 10_000);
  assert.equal(inferExtTimeout({ kind: "scroll", direction: "down" }), 10_000);
  assert.equal(inferExtTimeout({ kind: "press_key", key: "Enter" }), 10_000);
  assert.equal(
    inferExtTimeout({ kind: "drag", ref: "1", targetRef: "2" }),
    10_000,
  );
  assert.equal(inferExtTimeout({ kind: "drop", ref: "1", files: [] }), 10_000);
  assert.equal(inferExtTimeout({ kind: "resolve_ref", ref: "1" }), 10_000);
});

test("inferExtTimeout: slow commands keep the 30s default", () => {
  // Snapshot/screenshot — bitmap encode + a11y walk can take seconds.
  assert.equal(
    inferExtTimeout({ kind: "snapshot_capture", withTree: true, withScreenshot: false }),
    30_000,
  );
  // Evaluate — user-supplied expression may include long awaits.
  assert.equal(inferExtTimeout({ kind: "evaluate", expression: "1+1" }), 30_000);
  // Upload — base64 file payload (up to 25 MB) over the WS.
  assert.equal(
    inferExtTimeout({ kind: "upload", ref: "1", files: [] }),
    30_000,
  );
  // Navigation family — page loads can be slow.
  assert.equal(
    inferExtTimeout({ kind: "navigate", url: "https://example.com" }),
    30_000,
  );
  assert.equal(inferExtTimeout({ kind: "navigate_back" }), 30_000);
  assert.equal(inferExtTimeout({ kind: "tabs_query" }), 30_000);
  // CDP/chrome.* glue commands.
  assert.equal(
    inferExtTimeout({ kind: "set_focus_emulation", enabled: true }),
    30_000,
  );
  assert.equal(inferExtTimeout({ kind: "bring_to_front" }), 30_000);
  assert.equal(
    inferExtTimeout({ kind: "resize", width: 1280, height: 800 }),
    30_000,
  );
  assert.equal(
    inferExtTimeout({ kind: "handle_dialog", disposition: "accept" }),
    30_000,
  );
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
