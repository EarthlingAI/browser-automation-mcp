import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActionTool, ToolContext, execOnLeasedTab } from "../registry";

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

export function registerInteractTools(
  server: McpServer,
  ctx: ToolContext,
): void {
  registerActionTool(server, ctx, {
    name: "browser_navigate",
    description: "Navigate the leased tab to a URL.",
    schema: {
      url: z.string().url(),
      tabId: z.number().int().optional(),
      waitUntil: z
        .enum(["load", "domcontentloaded"])
        .default("domcontentloaded"),
    },
    handler: async ({ url, tabId, waitUntil }) =>
      execOnLeasedTab(ctx, tabId, { kind: "navigate", url, waitUntil }),
  });

  registerActionTool(server, ctx, {
    name: "browser_navigate_back",
    description: "Go back one entry in the leased tab's history.",
    schema: {
      tabId: z.number().int().optional(),
    },
    handler: async ({ tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "navigate_back" }),
  });

  registerActionTool(server, ctx, {
    name: "browser_click",
    description:
      "Click an element by `ref` from a recent snapshot. Supports modifiers, double/right click.",
    schema: {
      ref: z.string().describe('Element ref from browser_snapshot (e.g. "5").'),
      tabId: z.number().int().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clickCount: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .default(1),
      modifiers: z
        .array(z.string())
        .optional()
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
    description:
      "Type text into a textbox by `ref`. Clears existing value unless append:true.",
    schema: {
      ref: z.string(),
      text: z.string(),
      tabId: z.number().int().optional(),
      append: z.boolean().default(false),
    },
    handler: async ({ ref, text, tabId, append }) =>
      execOnLeasedTab(ctx, tabId, { kind: "type", ref, text, append }),
  });

  registerActionTool(server, ctx, {
    name: "browser_select_option",
    description:
      "Select an option in a <select> element by value or visible label.",
    schema: {
      ref: z.string(),
      value: z.string().describe("Option value or visible label."),
      tabId: z.number().int().optional(),
    },
    handler: async ({ ref, value, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "select_option", ref, value }),
  });

  registerActionTool(server, ctx, {
    name: "browser_hover",
    description:
      "Hover the pointer over an element by `ref`. Useful for revealing hover menus.",
    schema: {
      ref: z.string(),
      tabId: z.number().int().optional(),
    },
    handler: async ({ ref, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "hover", ref }),
  });

  registerActionTool(server, ctx, {
    name: "browser_scroll",
    description:
      "Scroll the page or a specific scrollable element by deltas (positive = down/right).",
    schema: {
      ref: z
        .string()
        .optional()
        .describe("Element ref to scroll. Omit to scroll the page."),
      tabId: z.number().int().optional(),
      deltaY: z.number().default(400),
      deltaX: z.number().default(0),
    },
    handler: async ({ ref, tabId, deltaY, deltaX }) =>
      execOnLeasedTab(ctx, tabId, { kind: "scroll", ref, deltaY, deltaX }),
  });

  registerActionTool(server, ctx, {
    name: "browser_upload",
    description: "Upload local files to a file input by `ref`.",
    schema: {
      ref: z.string(),
      files: z
        .array(z.string())
        .min(1)
        .describe("Absolute paths to local files."),
      tabId: z.number().int().optional(),
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
    name: "browser_press_key",
    description:
      "Press a keyboard shortcut at page level. Key names follow KeyboardEvent.key.",
    schema: {
      key: z.string().describe('e.g. "Enter", "Tab", "a", "F5".'),
      tabId: z.number().int().optional(),
      modifiers: z
        .array(z.string())
        .optional()
        .describe('e.g. ["Control"], ["Shift", "Alt"].'),
    },
    handler: async ({ key, tabId, modifiers }) =>
      execOnLeasedTab(ctx, tabId, { kind: "press_key", key, modifiers }),
  });

  registerActionTool(server, ctx, {
    name: "browser_evaluate",
    description:
      "Run a JS expression in the leased tab and return the JSON-serialisable result.",
    schema: {
      expression: z
        .string()
        .describe(
          "JS expression; the value of the last expression is returned.",
        ),
      tabId: z.number().int().optional(),
    },
    handler: async ({ expression, tabId }) =>
      execOnLeasedTab(ctx, tabId, { kind: "evaluate", expression }),
  });

  registerActionTool(server, ctx, {
    name: "browser_wait_for",
    description: "Wait for a CSS selector, network idle, or timeout.",
    schema: {
      selector: z.string().optional().describe("CSS selector to wait for."),
      networkIdle: z
        .boolean()
        .default(false)
        .describe("Wait until no network activity for 500ms."),
      timeout: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .default(10_000)
        .describe("Max wait in ms."),
      tabId: z.number().int().optional(),
    },
    handler: async ({ selector, networkIdle, timeout, tabId }) =>
      execOnLeasedTab(ctx, tabId, {
        kind: "wait_for",
        selector,
        networkIdle,
        timeout,
      }),
  });
}
