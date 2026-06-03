import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerActionTool,
  ToolContext,
  execOnLeasedTab,
  resolveRef,
  refNeedsVerification,
  nearbyRefsError,
} from "../registry";
import { coerceToArray, coerceLiteralNumber, coerceBoolean } from "./coerce";

const UPLOAD_MAX_FILES = 10;
const UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function readUploadPayloads(
  paths: string[],
): Array<{ name: string; mimeType: string; dataBase64: string }> {
  if (paths.length > UPLOAD_MAX_FILES)
    throw new Error(`too many files: ${paths.length} > ${UPLOAD_MAX_FILES}`);
  let total = 0;
  return paths.map((p) => {
    const st = statSync(p);
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    if (st.size > UPLOAD_MAX_FILE_BYTES)
      throw new Error(
        `file exceeds ${UPLOAD_MAX_FILE_BYTES} bytes: ${p} (${st.size})`,
      );
    total += st.size;
    if (total > UPLOAD_MAX_TOTAL_BYTES)
      throw new Error(
        `total upload size exceeds ${UPLOAD_MAX_TOTAL_BYTES} bytes`,
      );
    const buf = readFileSync(p);
    return {
      name: basename(p),
      mimeType:
        MIME_BY_EXT[extname(p).toLowerCase()] ?? "application/octet-stream",
      dataBase64: buf.toString("base64"),
    };
  });
}

// Reject a trusted-input coordinate that falls outside the last-known CSS
// viewport with an actionable error — trusted CDP input has no ref indirection,
// so a stale (post-scroll) or typo'd coordinate would otherwise dispatch into
// nothing. Best-effort: a no-op until the first snapshot populates the viewport.
function assertInViewport(ctx: ToolContext, x: number, y: number): void {
  const vp = ctx.session.lastViewport;
  if (!vp) return;
  // Half-open [0, w) / [0, h) — a coordinate at exactly w/h is one past the last
  // addressable pixel (matches helpers.js::inViewportAbs's `left < vw`).
  if (x < 0 || y < 0 || x >= vp.w || y >= vp.h) {
    const err = new Error(
      `coordinate (${x}, ${y}) is outside the ${vp.w}×${vp.h} viewport`,
    ) as Error & { hint?: string };
    err.hint = `coordinate outside viewport ${vp.w}×${vp.h}; re-run browser_snapshot or a screenshot for current coordinates (scrolling shifts them)`;
    throw err;
  }
}

// Standard annotations for write-y action tools (click, type, navigate, etc).
// These mutate page state, are not safely repeatable, and may touch external services.
const ACTION_WRITE: import("@modelcontextprotocol/sdk/types.js").ToolAnnotations =
  {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };

// Annotations for non-destructive interactions (hover, scroll) — mutate
// transient UI state but don't trigger submissions or destructive actions.
const ACTION_SOFT: import("@modelcontextprotocol/sdk/types.js").ToolAnnotations =
  {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

export function registerInteractTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  registerActionTool(server, ctx, {
    name: "browser_navigate",
    title: "Navigate or reload the leased tab",
    description:
      "Navigate the leased tab to a URL. Omit `url` to reload the current page.",
    annotations: ACTION_WRITE,
    schema: {
      url: z
        .string()
        .url()
        .optional()
        .describe("URL to navigate to. Omit to reload the current page."),
      tabId: z.coerce.number().int().optional(),
      waitUntil: z
        .enum(["load", "domcontentloaded"])
        .default("domcontentloaded"),
    },
    handler: async ({ url, tabId, waitUntil }) =>
      execOnLeasedTab(ctx, tabId, { kind: "navigate", url, waitUntil }),
  });

  registerActionTool(server, ctx, {
    name: "browser_navigate_back",
    title: "Navigate back in history",
    description: "Go back one entry in the leased tab's history.",
    annotations: ACTION_WRITE,
    schema: {
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "navigate_back" }),
  });

  registerActionTool(server, ctx, {
    name: "browser_click",
    title: "Click an element",
    description:
      "Click an element by `ref` from a recent snapshot. Supports modifiers, double/right click. Set trusted:true to escalate to a real CDP coordinate click (clicks the ref's centre) for widgets that gate on event.isTrusted or sit under an overlay — costs the debugger infobar; see browser_click_xy for arbitrary coordinates.",
    annotations: ACTION_WRITE,
    schema: {
      ref: z.string().describe('Element ref from browser_snapshot (e.g. "5").'),
      tabId: z.coerce.number().int().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clickCount: z.preprocess(
        coerceLiteralNumber,
        z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
      ),
      modifiers: z
        .preprocess(coerceToArray, z.array(z.string()).optional())
        .describe('Keys held during click, e.g. ["Control"], ["Shift"].'),
      trusted: z
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe(
          "Fire a real CDP mouse click at the ref's centre instead of a page-side synthetic event. For isTrusted-gated or overlay-occluded widgets.",
        ),
    },
    handler: async ({ ref, tabId, button, clickCount, modifiers, trusted }) => {
      if (trusted) {
        // Resolve the ref's rect (validates it too) and click its centre via a
        // trusted coordinate click. A ref without a rect (synthetic root, never
        // laid out) can't be coordinate-clicked — point the agent at the
        // explicit-coordinate tool. Cross-tab guard first: the ref's rect is in
        // its snapshot tab's viewport space, so clicking those coords on a
        // different tab would land at a stale point (execOnLeasedTab's own guard
        // never sees these coords — click_xy carries no ref).
        const target = tabId ?? ctx.session.lastLeasedTab;
        if (
          ctx.session.lastSnapshotTabId !== undefined &&
          target !== undefined &&
          ctx.session.lastSnapshotTabId !== target
        ) {
          throw new Error(
            `ref ${ref} was captured on tab ${ctx.session.lastSnapshotTabId} but this trusted click targets tab ${target}. Call browser_snapshot on tab ${target} first.`,
          );
        }
        const meta = resolveRef(ctx.session, ref);
        if (!meta.rect)
          throw new Error(
            `ref ${ref} has no bounding rect — can't compute a trusted-click coordinate. Re-run browser_snapshot, or use browser_click_xy with explicit coordinates.`,
          );
        // Liveness parity with the synthetic path: click_xy carries no ref, so
        // execOnLeasedTab's probe never runs — probe here so a since-removed
        // element errors instead of clicking empty space. We keep the SNAPSHOT
        // rect for coordinates (it's offset-accumulated to top-viewport space);
        // resolve_ref returns a frame-LOCAL rect, which would be wrong for a
        // same-origin-iframe element, so its rect is deliberately not used.
        if (target !== undefined && refNeedsVerification(ctx.session, ref)) {
          const live = await ctx.daemon.exec(target, {
            kind: "resolve_ref",
            ref,
          });
          if (!live) throw nearbyRefsError(ctx.session, ref, { gone: true });
        }
        const x = meta.rect.x + meta.rect.w / 2;
        const y = meta.rect.y + meta.rect.h / 2;
        return execOnLeasedTab(ctx, tabId, {
          kind: "click_xy",
          x,
          y,
          button,
          clickCount,
          modifiers,
        });
      }
      return execOnLeasedTab(ctx, tabId, {
        kind: "click",
        ref,
        button,
        clickCount,
        modifiers,
      });
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_click_xy",
    title: "Trusted click at viewport coordinates",
    description:
      "Click at an absolute (x, y) CSS-pixel coordinate in the viewport via a TRUSTED CDP mouse event — it hit-tests through overlays/iframes and satisfies event.isTrusted gates that page-side synthetic clicks can't. Use when there's no usable ref (cross-origin iframe, canvas widget, a custom control that ignores synthetic events). Coordinates share the snapshot's coordinate space (top-left origin, pre-scroll). Costs the debugger infobar and auto-asserts focus-emulation. Prefer browser_click(ref) for ordinary elements.",
    annotations: ACTION_WRITE,
    schema: {
      x: z.coerce.number().describe("Viewport X in CSS pixels (left origin)."),
      y: z.coerce.number().describe("Viewport Y in CSS pixels (top origin)."),
      tabId: z.coerce.number().int().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clickCount: z.preprocess(
        coerceLiteralNumber,
        z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
      ),
      modifiers: z
        .preprocess(coerceToArray, z.array(z.string()).optional())
        .describe('Keys held during click, e.g. ["Control"], ["Shift"].'),
    },
    handler: async ({ x, y, tabId, button, clickCount, modifiers }) => {
      assertInViewport(ctx, x, y);
      return execOnLeasedTab(ctx, tabId, {
        kind: "click_xy",
        x,
        y,
        button,
        clickCount,
        modifiers,
      });
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_draw",
    title: "Trusted freehand pointer stroke",
    description:
      "Draw a continuous pointer stroke through a list of (x, y) CSS-pixel viewport coordinates via TRUSTED CDP mouse events (press → moves → release, button held throughout). For signature pads, canvas drawing surfaces, slider drags, and pointer-based drag-and-drop that need real coordinate input. Give at least 2 points; more points trace a smoother path. Costs the debugger infobar and auto-asserts focus-emulation.",
    annotations: ACTION_WRITE,
    schema: {
      points: z
        .preprocess(
          coerceToArray,
          z
            .array(
              z.object({
                x: z.coerce.number(),
                y: z.coerce.number(),
              }),
            )
            .min(2),
        )
        .describe("Ordered viewport coordinates to trace; minimum 2."),
      tabId: z.coerce.number().int().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
    },
    handler: async ({ points, tabId, button }) => {
      for (const p of points) assertInViewport(ctx, p.x, p.y);
      return execOnLeasedTab(ctx, tabId, { kind: "draw", points, button });
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_type",
    title: "Type into an element",
    description:
      "Type text into a textbox by `ref`. Clears existing value unless append:true.",
    annotations: ACTION_WRITE,
    schema: {
      ref: z.string(),
      text: z.string(),
      tabId: z.coerce.number().int().optional(),
      append: z.preprocess(coerceBoolean, z.boolean().default(false)),
    },
    handler: async ({ ref, text, tabId, append }) =>
      execOnLeasedTab(ctx, tabId, { kind: "type", ref, text, append }),
  });

  registerActionTool(server, ctx, {
    name: "browser_select_option",
    title: "Select a <select> option",
    description:
      "Select an option in a <select> element by value or visible label.",
    annotations: ACTION_WRITE,
    schema: {
      ref: z.string(),
      value: z.string().describe("Option value or visible label."),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ ref, value, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "select_option", ref, value }),
  });

  registerActionTool(server, ctx, {
    name: "browser_fill_form",
    title: "Fill multiple form fields",
    description:
      'Fill several form fields in one batch. Each field is {ref, value, kind?}: kind defaults to "type" (set a textbox value), "select_option" picks a <select> option by value or visible label, "click" toggles a checkbox/radio (value ignored). Fields apply in order; faster than one browser_type/browser_select_option per field. Fills run back-to-back with no inter-field settle — the single auto-snapshot after the batch covers the final repaint.',
    annotations: ACTION_WRITE,
    schema: {
      fields: z
        .preprocess(
          coerceToArray,
          z
            .array(
              z.object({
                ref: z
                  .string()
                  .describe("Element ref from browser_snapshot."),
                value: z
                  .string()
                  .optional()
                  .describe(
                    'Text for kind:"type", or option value/label for kind:"select_option". Omit for kind:"click".',
                  ),
                kind: z
                  .enum(["type", "select_option", "click"])
                  .default("type")
                  .describe(
                    'How to fill the field: "type" (textbox), "select_option" (<select>), or "click" (checkbox/radio).',
                  ),
              }),
            )
            .min(1),
        )
        .describe("Fields to fill, applied in order."),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ fields, tabId }) => {
      // Batch fill: clear the wrapper's pending settle so no field stalls
      // waiting for a DOM delta (a plain value-set fires none). The single
      // auto-snapshot after the batch covers the final repaint.
      ctx.pendingSettle = undefined;
      const results: Array<{ ref: string; kind: string; result: unknown }> = [];
      for (const f of fields) {
        const kind = f.kind ?? "type";
        let result: unknown;
        if (kind === "click") {
          result = await execOnLeasedTab(ctx, tabId, {
            kind: "click",
            ref: f.ref,
          });
        } else if (kind === "select_option") {
          if (f.value === undefined)
            throw new Error(
              `browser_fill_form: field ref ${f.ref} (kind "select_option") requires a value`,
            );
          result = await execOnLeasedTab(ctx, tabId, {
            kind: "select_option",
            ref: f.ref,
            value: f.value,
          });
        } else {
          if (f.value === undefined)
            throw new Error(
              `browser_fill_form: field ref ${f.ref} (kind "type") requires a value`,
            );
          result = await execOnLeasedTab(ctx, tabId, {
            kind: "type",
            ref: f.ref,
            text: f.value,
            append: false,
          });
        }
        results.push({ ref: f.ref, kind, result });
      }
      return { filled: results.length, fields: results };
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_hover",
    title: "Hover over an element",
    description:
      "Hover the pointer over an element by `ref`. Useful for revealing hover menus.",
    annotations: ACTION_SOFT,
    schema: {
      ref: z.string(),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ ref, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "hover", ref }),
  });

  registerActionTool(server, ctx, {
    name: "browser_scroll",
    title: "Scroll the page or an element",
    description:
      "Scroll the page or a specific scrollable element by deltas (positive = down/right).",
    annotations: ACTION_SOFT,
    schema: {
      ref: z
        .string()
        .optional()
        .describe("Element ref to scroll. Omit to scroll the page."),
      tabId: z.coerce.number().int().optional(),
      deltaY: z.coerce.number().default(400),
      deltaX: z.coerce.number().default(0),
    },
    handler: async ({ ref, tabId, deltaY, deltaX }) =>
      execOnLeasedTab(ctx, tabId, { kind: "scroll", ref, deltaY, deltaX }),
  });

  registerActionTool(server, ctx, {
    name: "browser_upload",
    title: "Upload files to a file input",
    description: "Upload local files to a file input by `ref`.",
    annotations: ACTION_WRITE,
    schema: {
      ref: z.string(),
      files: z
        .preprocess(coerceToArray, z.array(z.string()).min(1))
        .describe("Absolute paths to local files."),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ ref, files, tabId }) => {
      const payloads = readUploadPayloads(files);
      return execOnLeasedTab(ctx, tabId, {
        kind: "upload",
        ref,
        files: payloads,
      });
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_drag",
    title: "Drag one element onto another",
    description:
      'Drag the source element (`ref`) onto a target element (`targetRef`). mechanism="auto" (default) inspects the source\'s draggable flag: "native" fires the HTML5 drag-and-drop event sequence (dragstart→dragover→drop with a shared DataTransfer) for draggable="true" sources (file managers, HTML5-DnD demos, SortableJS default); "pointer" fires a mouse/pointer press→move→release sequence for pointer-based libraries (react-beautiful-dnd, SortableJS forceFallback, most kanban boards). Pass mechanism explicitly to override the heuristic if the auto pick does not move the element. All synthetic and page-side — no window raise, no focus theft.',
    annotations: ACTION_WRITE,
    schema: {
      ref: z
        .string()
        .describe("Source element ref to drag (from browser_snapshot)."),
      targetRef: z
        .string()
        .describe("Target element ref to drop onto (from browser_snapshot)."),
      mechanism: z
        .enum(["auto", "native", "pointer"])
        .default("auto")
        .describe(
          'Event family: "auto" (pick by the source\'s draggable flag), "native" (HTML5 DnD events), or "pointer" (mouse/pointer sequence).',
        ),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ ref, targetRef, mechanism, tabId }) => {
      // The source `ref` is validated + liveness-probed by execOnLeasedTab.
      // Validate the target up-front too so a TYPO'd target gives a nearby-refs
      // error rather than a page-side "not found" buried in the result. (A
      // target removed since the snapshot still passes this registry check —
      // it's non-evicting — and surfaces page-side; only the source is
      // liveness-probed.) Skip when the action targets a different tab than the
      // last snapshot: the target can't be validated against this tab's
      // registry, and execOnLeasedTab's source-ref cross-tab guard owns the
      // canonical error in that case.
      const target = tabId ?? ctx.session.lastLeasedTab;
      const crossTab =
        ctx.session.lastSnapshotTabId !== undefined &&
        target !== undefined &&
        ctx.session.lastSnapshotTabId !== target;
      if (!crossTab) resolveRef(ctx.session, targetRef);
      return execOnLeasedTab(ctx, tabId, {
        kind: "drag",
        ref,
        targetRef,
        mechanism: mechanism ?? "auto",
      });
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_drop",
    title: "Drop files onto an element",
    description:
      "Drop local files onto a drop-zone element by `ref` — synthesizes the HTML5 dragenter→dragover→drop sequence carrying the files in a DataTransfer, exactly as a desktop file-drop would. Use for 'drag files here' upload zones that expose no <input type=file> for browser_upload to target.",
    annotations: ACTION_WRITE,
    schema: {
      ref: z
        .string()
        .describe("Drop-target element ref (from browser_snapshot)."),
      files: z
        .preprocess(coerceToArray, z.array(z.string()).min(1))
        .describe("Absolute paths to local files to drop."),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({ ref, files, tabId }) => {
      const payloads = readUploadPayloads(files);
      return execOnLeasedTab(ctx, tabId, { kind: "drop", ref, files: payloads });
    },
  });

  registerActionTool(server, ctx, {
    name: "browser_press_key",
    title: "Press a keyboard key/shortcut",
    description:
      "Press a keyboard shortcut at page level. Key names follow KeyboardEvent.key. Set trusted:true to escalate to a real CDP key event for inputs that gate on event.isTrusted or need the browser's own key handling (real form-submit on Enter, focus navigation on Tab) — costs the debugger infobar; see invariant #34.",
    annotations: ACTION_WRITE,
    schema: {
      key: z.string().describe('e.g. "Enter", "Tab", "a", "F5".'),
      tabId: z.coerce.number().int().optional(),
      modifiers: z
        .preprocess(coerceToArray, z.array(z.string()).optional())
        .describe('e.g. ["Control"], ["Shift", "Alt"].'),
      trusted: z
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe(
          "Fire a real CDP key event instead of a page-side synthetic one. For isTrusted-gated inputs or when the browser's native key action is needed.",
        ),
    },
    handler: async ({ key, tabId, modifiers, trusted }) =>
      execOnLeasedTab(ctx, tabId, { kind: "press_key", key, modifiers, trusted }),
  });

  registerActionTool(server, ctx, {
    name: "browser_evaluate",
    title: "Evaluate JavaScript in the leased tab",
    description:
      "Run a JS expression in the leased tab and return the JSON-serialisable result. Strings come back as strings (not char-indexed objects). For unfamiliar SPAs, call browser_network_requests first to discover real backend endpoints from xhr/fetch traffic before guessing endpoint paths.",
    annotations: ACTION_WRITE,
    schema: {
      expression: z
        .string()
        .describe(
          "JS expression; the value of the last expression is returned.",
        ),
      tabId: z.coerce.number().int().optional(),
      timeout: z
        .coerce.number()
        .int()
        .min(0)
        .max(300_000)
        .optional()
        .describe(
          "Max ms for the expression (including any awaited promise) before it is aborted and a {timed_out:true, elapsedMs} result returns. Omit for the default ~30s watchdog; max 300000 (5 min). Set this for long async loops so a runaway promise can't keep running unsupervised.",
        ),
    },
    handler: async ({ expression, tabId, timeout }) =>
      execOnLeasedTab(ctx, tabId, { kind: "evaluate", expression, timeout }),
  });

  registerActionTool(server, ctx, {
    name: "browser_wait_for",
    title: "Wait for a condition",
    description:
      'Wait for a CSS selector, a JS predicate, network idle, or a timeout. Use `condition` for state-machine SPAs — e.g. condition: "document.querySelectorAll(\'[data-clip-status=\\"complete\\"]\').length === 4" — instead of polling externally. Selectors should be passed raw (the JSON layer handles escaping). Exactly one of `selector`, `condition`, or `networkIdle:true` must be set.',
    readOnly: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      selector: z
        .string()
        .optional()
        .describe(
          'CSS selector to wait for. Pass raw selectors with literal quotes; the JSON layer handles escaping (e.g. `[data-testid="row"]`).',
        ),
      condition: z
        .string()
        .optional()
        .describe(
          "JS expression evaluated in-page on a polling loop. Returns when the expression is truthy. Use for attribute-value transitions and state-machine SPAs (data-status, aria-busy, react state etc.).",
        ),
      networkIdle: z
        .preprocess(coerceBoolean, z.boolean().default(false))
        .describe("Wait until no network activity for 500ms."),
      timeout: z
        .coerce.number()
        .int()
        .min(0)
        .max(300_000)
        .default(10_000)
        .describe("Max wait in ms. Default 10s, max 5 minutes."),
      poll_interval_ms: z
        .coerce.number()
        .int()
        .min(50)
        .max(5000)
        .default(250)
        .describe("Polling interval for `condition` mode."),
      tabId: z.coerce.number().int().optional(),
    },
    handler: async ({
      selector,
      condition,
      networkIdle,
      timeout,
      poll_interval_ms,
      tabId,
    }) => {
      const set = [
        selector ? 1 : 0,
        condition ? 1 : 0,
        networkIdle ? 1 : 0,
      ].reduce((a, b) => a + b, 0);
      if (set === 0)
        throw new Error(
          "browser_wait_for requires one of: selector, condition, or networkIdle:true",
        );
      if (set > 1)
        throw new Error(
          "browser_wait_for: pass only one of selector, condition, networkIdle",
        );
      return execOnLeasedTab(ctx, tabId, {
        kind: "wait_for",
        selector,
        condition,
        networkIdle,
        timeout,
        pollIntervalMs: poll_interval_ms,
      });
    },
  });
}
