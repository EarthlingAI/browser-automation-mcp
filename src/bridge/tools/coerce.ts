/**
 * Coerce helpers for tool schemas.
 *
 * Some MCP host runtimes stringify typed params on the wire — `tabId=1594871391`
 * arrives as `"1594871391"`, `force=true` as `"true"`, `methodIn=["POST"]` as
 * `'["POST"]'`. Plain `z.number()` / `z.boolean()` / `z.array()` reject these.
 * Every numeric / boolean / array schema param flows through these helpers so
 * the contract is robust to that variance.
 */

/** Accepts an array, a JSON-encoded array string, or a single value (wraps it). */
export const coerceToArray = (v: unknown): unknown => {
  if (v === undefined || v === null) return v;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* fall through — treat as single value */
      }
    }
    return [v];
  }
  return v;
};

/** Coerce a stringified literal-union (e.g. clickCount "1"|"2"|"3") to a number. */
export const coerceLiteralNumber = (v: unknown): unknown => {
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return v;
};

/**
 * Coerce a value to boolean — used via `z.preprocess(coerceBoolean, z.boolean())`.
 *
 * `z.coerce.boolean()` is unusable here because it wraps native `Boolean(v)`,
 * which returns true for any non-empty string — including "false". The SDK
 * stringification gotcha is the only thing we need to handle, so this maps
 * "true"/"false"/"1"/"0" (case-insensitive) explicitly and passes everything
 * else through for zod to validate (or reject).
 */
export const coerceBoolean = (v: unknown): unknown => {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    // Empty / unknown strings fall through unchanged so the wrapping zod
    // schema's `.default(...)` still applies (treating "" as false would
    // silently flip `background`/`viewportOnly` against the agent's intent —
    // and `background:""` would activate a new tab, violating invariant #1).
  }
  return v;
};
