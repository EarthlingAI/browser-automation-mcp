import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerActionTool,
  ToolContext,
  execOnLeasedTab,
  resolveRef,
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
      "Click an element by `ref` from a recent snapshot. Supports modifiers, double/right click.",
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
    },
    handler: async ({ ref, tabId, button, clickCount, modifiers }) =>
      execOnLeasedTab(ctx, tabId, {
        kind: "click",
        ref,
        button,
        clickCount,
        modifiers,
      }),
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
      "Press a keyboard shortcut at page level. Key names follow KeyboardEvent.key.",
    annotations: ACTION_WRITE,
    schema: {
      key: z.string().describe('e.g. "Enter", "Tab", "a", "F5".'),
      tabId: z.coerce.number().int().optional(),
      modifiers: z
        .preprocess(coerceToArray, z.array(z.string()).optional())
        .describe('e.g. ["Control"], ["Shift", "Alt"].'),
    },
    handler: async ({ key, tabId, modifiers }) =>
      execOnLeasedTab(ctx, tabId, { kind: "press_key", key, modifiers }),
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
    },
    handler: async ({ expression, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "evaluate", expression }),
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
