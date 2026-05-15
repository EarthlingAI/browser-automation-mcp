// Build fingerprint surfaces in SERVER_INSTRUCTIONS so the host agent can
// detect schema staleness. Esbuild's `define` substitutes __BUILD_STAMP__ at
// bundle time; this test confirms the substitution happened (vs. a literal
// "dev" fallback) AND that the value appears in the instructions string.

import test from "node:test";
import assert from "node:assert/strict";
import { BUILD_STAMP, SERVER_INSTRUCTIONS } from "../../dist/test-exports.mjs";

test("BUILD_STAMP is non-empty", () => {
  assert.ok(typeof BUILD_STAMP === "string" && BUILD_STAMP.length > 0);
});

test("BUILD_STAMP looks like a real stamp (not the dev fallback)", () => {
  // Either a git-sha@ISO-timestamp or just an ISO timestamp. Both contain
  // an ISO date fragment (YYYY-MM-DD) so we anchor on that.
  assert.match(BUILD_STAMP, /\d{4}-\d{2}-\d{2}/, "BUILD_STAMP missing ISO date");
});

test("SERVER_INSTRUCTIONS contains a Build line with the stamp", () => {
  assert.match(SERVER_INSTRUCTIONS, /\nBuild: \S+/);
  assert.ok(
    SERVER_INSTRUCTIONS.includes(BUILD_STAMP),
    "SERVER_INSTRUCTIONS does not contain BUILD_STAMP",
  );
});
