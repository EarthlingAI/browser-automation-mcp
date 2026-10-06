/**
 * Single source of truth for `save_to_path` resolution and file write.
 *
 * Used by `browser_snapshot`. As of Round 7 this module is ALSO the canonical
 * "infer image format" point — the agent-facing
 * `format` param is gone, and the chosen format is a function of:
 *
 *   - `save_to_path:false`/`undefined` → JPEG (inline default).
 *   - `save_to_path:true`              → JPEG (auto-named `*.jpg`).
 *   - `save_to_path:"foo.png"`         → PNG  (extension drives format).
 *   - `save_to_path:"foo.jpg"`         → JPEG.
 *
 * The schema below validates the extension at schema-time so a bad path fails
 * before any capture work happens.
 */

import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { coerceBoolean } from "./coerce";

const DEFAULT_OUTPUT_SUBDIR = "browser";

export type SupportedFormat = "png" | "jpeg";

/**
 * File-extension → format map. Keep keys lowercase; `extname()` is
 * lowercased before lookup.
 */
export const FORMAT_BY_EXT: Record<string, SupportedFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
};

/** Default format when no extension is in play (inline-only or auto-name). */
export const DEFAULT_FORMAT: SupportedFormat = "jpeg";
/** Extension chosen for the `save_to_path:true` auto-named file. */
export const AUTO_NAME_EXT = ".jpg";

export interface SaveResolution {
  /** Absolute path to write to, or `null` when no save was requested. */
  path: string | null;
  /** Image format chosen for this call. Always resolved. */
  format: SupportedFormat;
}

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
 * Resolve the agent's `save_to_path` arg into `{path, format}`. Format is
 * always resolved (used by the capture pipeline even when no save happens).
 *
 *  - `false` / `undefined` → `{path: null,   format: jpeg}`
 *  - `true`                → `{path: <outputs_dir>/screenshot_<tab>_<ms>.jpg, format: jpeg}`
 *  - `string`              → `{path: resolved, format: from-extension}`
 *
 * `..` in any segment of a string path is rejected. Unknown image extensions
 * are rejected with an actionable error listing the supported ones. Format
 * cannot be overridden separately — the file extension IS the format.
 */
export function resolveSavePath(
  value: boolean | string | undefined,
  tabId: number,
): SaveResolution {
  if (value === false || value === undefined) {
    return { path: null, format: DEFAULT_FORMAT };
  }
  if (value === true) {
    return {
      path: resolve(
        getOutputsDir(),
        `screenshot_${tabId}_${Date.now()}${AUTO_NAME_EXT}`,
      ),
      format: FORMAT_BY_EXT[AUTO_NAME_EXT]!,
    };
  }
  // String path. Reject `..` segments first so traversal errors win over
  // extension errors (the former is a security concern, the latter merely
  // structural).
  if (value.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new Error(
      `save_to_path "${value}" contains ".." which is not allowed`,
    );
  }
  const ext = extname(value).toLowerCase();
  const format = FORMAT_BY_EXT[ext];
  if (!format) {
    throw new Error(
      `save_to_path "${value}" has unsupported extension "${ext || "(none)"}" — use one of: ${Object.keys(FORMAT_BY_EXT).join(", ")}`,
    );
  }
  const absolute = isAbsolute(value) ? value : resolve(getOutputsDir(), value);
  return { path: absolute, format };
}

// ── Auto-saved file retention ────────────────────────────────────────────────
// Auto-named saves (`browser_snapshot` save_to_path:true / save_tree_to_path:true,
// `browser_fetch` save_to_path:true) are task residue that can hold whatever a
// logged-in page showed, so each such write prunes them by age, then by count.
// Scope is by NAME: a file whose name does not match the auto-namer formats is
// never pruned, nor is anything outside the outputs dir's top level.

export const AUTO_SAVED_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const AUTO_SAVED_MAX_FILES = 200;
/** Exactly the names the auto-namers above produce — nothing else is ever pruned. */
export const AUTO_SAVED_NAME_RE =
  /^(?:screenshot_[0-9]+_[0-9]+\.jpg|tree_[0-9]+_[0-9]+\.txt|fetch_[0-9]+\.(?:txt|bin))$/;

/**
 * Delete auto-saved files in `dir` older than the age limit, then the oldest
 * beyond the newest `AUTO_SAVED_MAX_FILES` (mtime, name as tie-break). Never
 * deletes `keep`. Fail-soft: errors are logged and never thrown. `remove` is the
 * deletion seam (tests substitute a failing one).
 */
export function pruneAutoSaved(
  dir: string,
  keep: string,
  now = Date.now(),
  remove: (path: string) => void = unlinkSync,
): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    console.error(`[browser-automation-mcp] auto-save prune: cannot list ${dir}: ${String(err)}`);
    return removed;
  }
  const keepPath = resolve(keep);
  const files: { path: string; name: string; mtime: number }[] = [];
  for (const name of names) {
    if (!AUTO_SAVED_NAME_RE.test(name)) continue;
    const path = resolve(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isFile()) files.push({ path, name, mtime: st.mtimeMs });
    } catch {
      // Vanished or unreadable — nothing to prune.
    }
  }
  files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const kept: typeof files = [];
  const doomed: typeof files = [];
  for (const f of files) {
    if (f.path === keepPath) kept.push(f);
    else if (now - f.mtime > AUTO_SAVED_MAX_AGE_MS) doomed.push(f);
    else kept.push(f);
  }
  let slots = AUTO_SAVED_MAX_FILES - (kept.some((f) => f.path === keepPath) ? 1 : 0);
  for (const f of kept) {
    if (f.path === keepPath) continue;
    if (slots > 0) slots--;
    else doomed.push(f);
  }
  for (const f of doomed) {
    try {
      remove(f.path);
      removed.push(f.path);
    } catch (err) {
      // Another process sharing this dir pruned it first.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.error(`[browser-automation-mcp] auto-save prune: cannot delete ${f.path}: ${String(err)}`);
    }
  }
  return removed;
}

/** Prune after a write when that write was itself an auto-named save in the outputs dir. */
function pruneIfAutoSaved(absolutePath: string): void {
  try {
    const outputs = resolve(getOutputsDir());
    if (resolve(dirname(absolutePath)) === outputs && AUTO_SAVED_NAME_RE.test(basename(absolutePath))) {
      pruneAutoSaved(outputs, absolutePath);
    }
  } catch (err) {
    console.error(`[browser-automation-mcp] auto-save prune failed: ${String(err)}`);
  }
}

/** Write raw base64-decoded bytes to disk (arbitrary binary — image, fetch body). */
export function writeBase64(absolutePath: string, dataBase64: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, Buffer.from(dataBase64, "base64"));
  pruneIfAutoSaved(absolutePath);
}

/** Alias kept for the capture pipeline's image offload — same bytes-to-disk write. */
export const writeImage = writeBase64;

/**
 * Resolve a generic `save_to_path` (any extension — used by browser_fetch's
 * body offload). Unlike resolveSavePath / resolveTreeSavePath there is NO
 * extension whitelist (a fetch body may be JSON, HTML, a PDF, anything).
 *
 *  - `true`   → `<outputs_dir>/fetch_<ms><autoExt>` (autoExt defaults `.bin`;
 *               the caller passes `.txt` when the body is text so an auto-named
 *               file opens in a text viewer rather than as opaque binary).
 *  - `string` → resolved as given; `..` segments rejected; relative → outputs_dir.
 */
export function resolveDownloadSavePath(
  value: true | string,
  autoExt = ".bin",
): string {
  if (value === true) {
    return resolve(getOutputsDir(), `fetch_${Date.now()}${autoExt}`);
  }
  if (value.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new Error(
      `save_to_path "${value}" contains ".." which is not allowed`,
    );
  }
  return isAbsolute(value) ? value : resolve(getOutputsDir(), value);
}

// ── Tree offload (`save_tree_to_path`) — text-file variants of the image-save
// contracts above. Same shape: boolean|string, auto-name on `true`, `..`
// rejection, extension gate, relative-resolves-to-outputs-dir.

/** Extensions accepted for a tree offload target. */
export const TREE_EXTS = [".txt", ".md"];
/** Extension chosen for the `save_tree_to_path:true` auto-named file. */
export const TREE_AUTO_NAME_EXT = ".txt";

/**
 * Resolve the agent's `save_tree_to_path` arg into an absolute path. Only
 * called when the arg is truthy (`false`/`undefined` means "no offload" and is
 * short-circuited by the caller).
 *
 *  - `true`   → `<outputs_dir>/tree_<tab>_<ms>.txt`
 *  - `string` → resolved; `..` segments rejected; extension must be .txt/.md
 */
export function resolveTreeSavePath(
  value: true | string,
  tabId: number,
): string {
  if (value === true) {
    return resolve(
      getOutputsDir(),
      `tree_${tabId}_${Date.now()}${TREE_AUTO_NAME_EXT}`,
    );
  }
  if (value.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new Error(
      `save_tree_to_path "${value}" contains ".." which is not allowed`,
    );
  }
  const ext = extname(value).toLowerCase();
  if (!TREE_EXTS.includes(ext)) {
    throw new Error(
      `save_tree_to_path "${value}" has unsupported extension "${ext || "(none)"}" — use one of: ${TREE_EXTS.join(", ")}`,
    );
  }
  return isAbsolute(value) ? value : resolve(getOutputsDir(), value);
}

export function writeText(absolutePath: string, text: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, text, "utf8");
  pruneIfAutoSaved(absolutePath);
}

/**
 * Schema for `save_to_path` — used by `browser_snapshot`. Two-stage validation:
 *
 *   1. Preprocess-then-union order matters: the agent SDK stringifies
 *      `true`/`false` to `"true"`/`"false"`, and a plain
 *      `z.union([z.string(), z.boolean()])` would grab those strings as
 *      literal paths (writing files named `./true`). Coerce booleans first.
 *   2. `.refine(...)` validates the extension at schema-time so an unsupported
 *      extension surfaces as an InputValidationError BEFORE any capture work.
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
  .refine(
    (v) => {
      if (typeof v !== "string") return true;
      const ext = extname(v).toLowerCase();
      return ext in FORMAT_BY_EXT;
    },
    {
      message: `save_to_path string must end in one of: ${Object.keys(FORMAT_BY_EXT).join(", ")}`,
    },
  )
  .describe(
    "Write the captured image to disk. false (default) — return inline only (JPEG). " +
      "true — auto-pick <outputs_dir>/screenshot_<tabId>_<ms>.jpg (auto-named saves of every kind share one cap: pruned after 7 days or beyond the newest 200; any other name is kept). " +
      'String — explicit path; extension picks the format (".png" → PNG, ".jpg"/".jpeg" → JPEG). ' +
      "Relative resolves to outputs_dir; absolute allowed; \"..\" segments rejected. " +
      "Save errors are non-fatal: the image still returns; failure surfaces as `saveError` in the text envelope.",
  );

/**
 * Schema for browser_fetch's `save_to_path` — offload the response body to a
 * file. Boolean-coerce before the union (so stringified "true"/"false" don't
 * become literal paths); NO extension gate (a fetch body may be any type).
 */
export const downloadSaveToPathSchema = z
  .preprocess(
    (v) => {
      const coerced = coerceBoolean(v);
      return typeof coerced === "boolean" ? coerced : v;
    },
    z.union([z.string().min(1), z.boolean()]),
  )
  .default(false)
  .describe(
    "Write the response body to a file and return its path as `fetchedTo` — the escape " +
      "hatch for bodies too big to inline. false (default) — inline only (cut to max_inline_bytes). " +
      "true — auto-pick <outputs_dir>/fetch_<ms>.{txt|bin} (.txt for text bodies, .bin for binary; auto-named saves of every kind share one cap: pruned after 7 days or beyond the newest 200; any other name is kept). " +
      'String — explicit path (any extension; relative resolves to outputs_dir; ".." rejected). ' +
      "The saved body is full up to a 25 MB hard ceiling (a larger body is capped, flagged `truncated`). " +
      "Write errors are non-fatal (`fetchError`); the inline body still returns.",
  );

/**
 * Schema for `save_tree_to_path` — used by `browser_snapshot`. Same two-stage
 * validation shape as `saveToPathSchema` (boolean-coerce before the union so
 * stringified `"true"`/`"false"` don't become literal paths; extension gated
 * at schema time).
 */
export const saveTreeToPathSchema = z
  .preprocess(
    (v) => {
      const coerced = coerceBoolean(v);
      return typeof coerced === "boolean" ? coerced : v;
    },
    z.union([z.string().min(1), z.boolean()]),
  )
  .default(false)
  .refine(
    (v) => {
      if (typeof v !== "string") return true;
      return TREE_EXTS.includes(extname(v).toLowerCase());
    },
    {
      message: `save_tree_to_path string must end in one of: ${TREE_EXTS.join(", ")}`,
    },
  )
  .describe(
    "Write the FULL UNCAPPED outline of this snapshot to a text file — no 'limit', no viewport " +
      "scoping (honours 'scope' if passed) — and return its path as `treeSavedTo`. The escape hatch " +
      "for pages too big to inline: read the file, then act on any [ref=N] it contains (file-sourced " +
      "refs resolve like any other). false (default) — no file. true — auto-pick " +
      "<outputs_dir>/tree_<tabId>_<ms>.txt (auto-named saves of every kind share one cap: pruned after 7 days or beyond the newest 200; any other name is kept). String — explicit .txt/.md path (relative resolves to " +
      "outputs_dir; \"..\" rejected). Per-call only, never carried into auto-snapshots. " +
      "Write errors are non-fatal (`treeSaveError`).",
  );
