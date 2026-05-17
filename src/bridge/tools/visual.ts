/**
 * Visual constants for snapshot annotation. Ported from windows-native-mcp's
 * `core/screen.py::annotate_screenshot` so the two MCP servers share one
 * badge style — the agent learns one visual language.
 *
 * The constants live ONE-WAY on the bridge: every `annotate_image` ExtCommand
 * carries the full constants object in its payload, and the extension is a
 * dumb canvas renderer that draws what it's told. Tweaking a color or font
 * size here takes effect on the next snapshot — no extension reload required.
 */
export const VISUAL_CONSTANTS = {
  BADGE_FILL: "#FF4444",
  BADGE_TEXT_COLOR: "#FFFFFF",
  BADGE_FONT: "12px Arial, sans-serif",
  BBOX_STROKE: "#FF4444",
  BBOX_STROKE_WIDTH: 1,
  BADGE_PADDING: 2,           // px interior padding inside the badge box
  BADGE_OFFSET_Y: 4,          // px above the bbox top
  MIN_ANNOTATABLE_PX: 8,      // skip badges for elements smaller than this (post-clamp)
} as const;

export type VisualConstants = typeof VISUAL_CONSTANTS;
