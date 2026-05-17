// VISUAL_CONSTANTS is the cross-tool visual contract — the badge colour /
// font / sizing the agent learns to recognise. Lock the surface so an
// accidental rename or removal trips this test loudly rather than silently
// shipping a different look.

import test from "node:test";
import assert from "node:assert/strict";
import { VISUAL_CONSTANTS } from "../../dist/test-exports.mjs";

test("VISUAL_CONSTANTS exposes the badge fill the agent learns to recognise", () => {
  // Matches windows-native-mcp::annotate_screenshot so the two MCPs share one
  // visual language. Changing this value is a deliberate cross-tool decision.
  assert.equal(VISUAL_CONSTANTS.BADGE_FILL, "#FF4444");
});

test("VISUAL_CONSTANTS skips tiny elements at MIN_ANNOTATABLE_PX (8 px)", () => {
  assert.equal(VISUAL_CONSTANTS.MIN_ANNOTATABLE_PX, 8);
});

test("VISUAL_CONSTANTS has every key the extension's annotate handler reads", () => {
  // The extension trusts the bridge to send a complete constants object; a
  // dropped key would surface as `undefined` paint mid-draw. Lock the surface.
  const required = [
    "BADGE_FILL",
    "BADGE_TEXT_COLOR",
    "BADGE_FONT",
    "BBOX_STROKE",
    "BBOX_STROKE_WIDTH",
    "BADGE_PADDING",
    "BADGE_OFFSET_Y",
    "MIN_ANNOTATABLE_PX",
  ];
  for (const k of required) {
    assert.ok(k in VISUAL_CONSTANTS, `VISUAL_CONSTANTS missing required key ${k}`);
    assert.notEqual(VISUAL_CONSTANTS[k], undefined);
  }
});
