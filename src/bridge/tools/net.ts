import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, ToolContext } from "../registry";
import { CookieRecord, FetchResult } from "../../protocol";
import {
  downloadSaveToPathSchema,
  resolveDownloadSavePath,
  writeBase64,
  writeText,
} from "./save";

/**
 * Privileged data primitives — lease-free (no tab, no debugger). browser_fetch
 * issues a first-party authenticated HTTP request from the extension's own SW
 * context; browser_cookies reads the cookie jar (incl. httpOnly) by origin.
 * Together with browser_network_requests (discover a site's real endpoints) and
 * browser_evaluate (page-context JS) they form a "drive the site's own API"
 * toolkit.
 */
/**
 * Drop a trailing lone high surrogate (U+D800–U+DBFF) left dangling when a
 * string is sliced mid-surrogate-pair, so the inline preview is always valid
 * UTF-16 (a lone surrogate would serialise as U+FFFD downstream anyway).
 */
function trimLoneHighSurrogate(s: string): string {
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

export function registerNetTools(server: McpServer, ctx: ToolContext): void {
  // Coerce a JSON-encoded object string back to an object (some MCP hosts
  // stringify nested params on the wire), passing real objects through.
  const coerceRecord = (v: unknown): unknown => {
    if (typeof v === "string" && v.trim().startsWith("{")) {
      try {
        return JSON.parse(v);
      } catch {
        /* leave as-is; zod rejects */
      }
    }
    return v;
  };

  registerTool(server, ctx, {
    name: "browser_fetch",
    title: "Fetch a URL with the user's real cookies (CORS-free)",
    description:
      "Issue an HTTP request from the extension's privileged context — as FIRST-PARTY for the target origin. " +
      "Unlike fetch() inside browser_evaluate (page-context, CORS-blocked, SameSite-limited), this attaches the " +
      "user's REAL cookies (credentials:\"include\" by default, incl. SameSite=Lax/Strict) and reads the response " +
      "CORS-exempt — so you can call a logged-in site's own backend API directly. Pair with browser_network_requests " +
      "to discover the endpoints. Returns {status, statusText, ok, finalUrl, headers, body|bodyBase64, byteLength, truncated?, previewTruncated?, fetchedTo?}. " +
      "Set-Cookie is NEVER in headers (the Fetch spec forbids exposing it — read cookies with browser_cookies). " +
      "Uses the default (non-incognito) cookie store; the request never appears in the page's own network log. " +
      "Large bodies: without save_to_path the inline body is cut to max_inline_bytes (truncated:true). With save_to_path " +
      "the body is written to disk (fetchedTo) up to a 25 MB hard ceiling — a body past that is itself capped (truncated:true), " +
      "and the inline copy becomes a preview cut to max_inline_bytes (previewTruncated:true). Binary responses return bodyBase64.",
    annotations: {
      // A fetch can mutate server state (POST/PUT/DELETE) — not read-only, and
      // an arbitrary URL is open-world. Not idempotent (a POST repeats side effects).
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schema: {
      url: z.string().url().describe("Absolute URL to request."),
      method: z
        .string()
        .default("GET")
        .describe("HTTP method. Default GET."),
      headers: z
        .preprocess(coerceRecord, z.record(z.string()).optional())
        .describe("Extra request headers as a {name: value} object."),
      body: z
        .string()
        .optional()
        .describe(
          "Request body (e.g. a JSON string for a POST). Set a matching content-type header.",
        ),
      credentials: z
        .enum(["include", "same-origin", "omit"])
        .default("include")
        .describe(
          'Cookie policy. "include" (default) — attach the user\'s cookies (the point of this tool). ' +
            '"omit" — anonymous request.',
        ),
      timeout: z
        .coerce.number()
        .int()
        .min(1)
        .max(300_000)
        .default(30_000)
        .describe(
          "Milliseconds before the request is aborted. Default 30000, max 300000.",
        ),
      max_inline_bytes: z
        .coerce.number()
        .int()
        .min(0)
        .default(25_000)
        .describe(
          "Cap on the inline body returned in the response. Larger bodies are cut (truncated:true); use save_to_path for the full body.",
        ),
      save_to_path: downloadSaveToPathSchema,
    },
    handler: async ({
      url,
      method,
      headers,
      body,
      credentials,
      timeout,
      max_inline_bytes,
      save_to_path,
    }) => {
      const willSave = save_to_path !== false;
      const result = (await ctx.daemon.send({
        type: "fetch",
        req: {
          url,
          method,
          headers,
          body,
          credentials,
          timeoutMs: timeout,
          maxInlineBytes: max_inline_bytes,
          save: willSave,
        },
      })) as FetchResult;

      const out: Record<string, unknown> = { ...result };
      if (willSave) {
        try {
          const isText = result.body !== undefined;
          const path = resolveDownloadSavePath(
            save_to_path as true | string,
            isText ? ".txt" : ".bin",
          );
          if (result.bodyBase64 !== undefined) {
            writeBase64(path, result.bodyBase64);
          } else {
            writeText(path, result.body ?? "");
          }
          out.fetchedTo = path;
          // The full body is now on disk. The inline copy is an APPROXIMATE
          // preview: cap it to max_inline_bytes on a valid boundary so the
          // inline string never carries a torn UTF-8 sequence or a broken
          // base64 quantum. (result.truncated already flags a body the SW
          // capped at its hard ceiling — that flag propagates via the spread.)
          if (result.body !== undefined && result.body.length > max_inline_bytes) {
            out.body = trimLoneHighSurrogate(
              result.body.slice(0, max_inline_bytes),
            );
            out.previewTruncated = true;
          } else if (
            result.bodyBase64 !== undefined &&
            result.bodyBase64.length > max_inline_bytes
          ) {
            // Slice on a 4-char base64 boundary so the preview stays decodable.
            out.bodyBase64 = result.bodyBase64.slice(
              0,
              Math.floor(max_inline_bytes / 4) * 4,
            );
            out.previewTruncated = true;
          }
        } catch (e: any) {
          // Non-fatal: the body still returns inline (uncapped here, since the
          // save that would have justified the full body failed).
          out.fetchError = e?.message ?? String(e);
        }
      }
      return out;
    },
  });

  registerTool(server, ctx, {
    name: "browser_cookies",
    title: "Read cookies (incl. httpOnly) for a site",
    description:
      "Read cookies from the browser's default (non-incognito) cookie store by origin/domain — INCLUDING httpOnly " +
      "cookies that document.cookie (via browser_evaluate) cannot see. Use to inspect a site's auth/session state, " +
      "or to grab an auth cookie to replay through browser_fetch. Pass `url` (returns cookies that would be sent to " +
      "that URL) or `domain` (all cookies for the domain); optionally `name` to filter. Returns session + persistent " +
      "cookies with {name, value, domain, path, secure, httpOnly, sameSite, session, expirationDate?}. " +
      "Read-only. CHIPS partitioned cookies are not returned (the default unpartitioned jar only).",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: {
      url: z
        .string()
        .optional()
        .describe(
          "Return cookies that would be sent to this URL (host + path scoped). One of url/domain is required.",
        ),
      domain: z
        .string()
        .optional()
        .describe(
          "Return all cookies for this domain (and its subdomains). One of url/domain is required.",
        ),
      name: z
        .string()
        .optional()
        .describe("Filter to cookies with this exact name."),
    },
    handler: async ({ url, domain, name }) => {
      if (!url && !domain) {
        throw new Error(
          "browser_cookies requires at least one of `url` or `domain`",
        );
      }
      return (await ctx.daemon.send({
        type: "cookies",
        filter: { url, domain, name },
      })) as CookieRecord[];
    },
  });
}
