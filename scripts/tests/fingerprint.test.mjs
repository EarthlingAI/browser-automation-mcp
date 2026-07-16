// Build fingerprint is logged to stderr at bridge startup, NOT surfaced in
// SERVER_INSTRUCTIONS — hosts inject instructions into the model's system
// prefix, so a per-build stamp there would bust the host's prompt cache on
// every rebuild. Esbuild's `define` substitutes __BUILD_STAMP__ at bundle
// time; this test confirms the substitution happened (vs. a literal "dev"
// fallback) AND that the stamp stays OUT of the instructions string.

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

test("SERVER_INSTRUCTIONS carries no build stamp (prompt-cache stability)", () => {
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /\nBuild: /, "Build: line must stay out of instructions");
  assert.ok(
    !SERVER_INSTRUCTIONS.includes(BUILD_STAMP),
    "per-build stamp in instructions would bust the host's prompt cache on every rebuild",
  );
});
