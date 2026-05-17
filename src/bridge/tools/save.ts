/**
 * Single source of truth for `save_to_path` resolution and file write.
 *
 * Shared by `browser_snapshot` and `browser_screenshot`. The schema for the
 * shared `save_to_path` parameter (with the `coerceBoolean` preprocess that
 * stops `"true"` from being interpreted as a literal path) lives here too so
 * the resolve/write/schema trio sits in one file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { coerceBoolean } from "./coerce";

const DEFAULT_OUTPUT_SUBDIR = "browser";

export function getOutputsDir(): string {
  if (process.env.BROWSER_AUTOMATION_MCP_OUTPUTS_DIR) {
    return process.env.BROWSER_AUTOMATION_MCP_OUTPUTS_DIR;
  }
  if (process.env.BROWSER_AUTOMATION_MCP_RUNTIME_DIR) {
    return join(process.env.BROWSER_AUTOMATION_MCP_RUNTIME_DIR, "outputs");
  }
  return join(process.cwd(), "outputs", DEFAULT_OUTPUT_SUBDIR);
}

/**
 * Resolve the agent's `save_to_path` arg into an absolute filesystem path,
 * or `null` when no save is requested.
 *
 *  - `false` / `undefined` → null (no save)
 *  - `true`                → `<outputs_dir>/screenshot_<tabId>_<unixms>.<ext>`
 *  - string                → relative resolves under outputs_dir; absolute
 *                            allowed; any `..` segment is rejected.
 */
export function resolveSavePath(
  value: boolean | string | undefined,
  format: "png" | "jpeg",
  tabId: number,
): string | null {
  if (value === false || value === undefined) return null;
  if (value === true) {
    const ext = format === "jpeg" ? "jpg" : "png";
    return resolve(getOutputsDir(), `screenshot_${tabId}_${Date.now()}.${ext}`);
  }
  if (typeof value === "string") {
    if (value.split(/[/\\]/).some((seg) => seg === "..")) {
      throw new Error(
        `save_to_path "${value}" contains ".." which is not allowed`,
      );
    }
    return isAbsolute(value) ? value : resolve(getOutputsDir(), value);
  }
  return null;
}

export function writeImage(
  absolutePath: string,
  dataBase64: string,
): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, Buffer.from(dataBase64, "base64"));
}

/**
 * Schema for `save_to_path` — shared by `browser_snapshot` and
 * `browser_screenshot`. Preprocess-then-union order is critical: the agent SDK
 * stringifies `true`/`false` to `"true"`/`"false"`, and a plain
 * `z.union([z.string(), z.boolean()])` would grab those strings as literal
 * paths (writing files named `./true`). We coerce string-booleans FIRST and
 * only treat genuine path strings as strings.
 */
export const saveToPathSchema = z
  .preprocess(
    (v) => {
      const coerced = coerceBoolean(v);
      return typeof coerced === "boolean" ? coerced : v;
    },
    z.union([z.string().min(1), z.boolean()]),
  )
  .default(false)
  .describe(
    "Write the captured image to disk. false (default) — return inline only. " +
      "true — auto-pick <outputs_dir>/screenshot_<tabId>_<ms>.<ext>. " +
      'String — explicit path (relative resolves to outputs_dir; absolute allowed; ".." rejected). ' +
      "Save errors are non-fatal: the image still returns; failure surfaces as `saveError` in the text envelope.",
  );
