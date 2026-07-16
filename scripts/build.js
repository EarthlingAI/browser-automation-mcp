#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const watch = process.argv.includes("--watch");

// Build fingerprint — logged to stderr at bridge startup so a stale dist is
// diagnosable from host logs. Deliberately NOT placed in SERVER_INSTRUCTIONS:
// a per-build value there would bust the host's prompt cache on every
// rebuild. Falls back to a timestamp-only stamp outside a git checkout.
const buildStamp = (() => {
  const ts = new Date().toISOString().slice(0, 19) + "Z";
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd: root })
      .toString()
      .trim();
    return `${sha}@${ts}`;
  } catch {
    return ts;
  }
})();

const define = {
  __BUILD_STAMP__: JSON.stringify(buildStamp),
};

// Production bundle — the MCP server entry consumed by host agents.
const main = {
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  external: [],
  define,
  logLevel: "info",
};

// Test bundle — re-exports a small subset of internal helpers so Node's
// --test runner can exercise pure functions without standing up daemon/ext.
// Built as ESM so .mjs test files can `import` from it directly.
const testExports = {
  entryPoints: [path.join(root, "src/test-exports.ts")],
  outfile: path.join(root, "dist/test-exports.mjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: false,
  external: [],
  define,
  logLevel: "info",
};

(async () => {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  if (watch) {
    // Watch mode covers the main bundle only — test-exports.mjs is
    // regenerated only on full `npm run build`. If you're iterating on a
    // helper covered by tests, run `npm run build` between edits.
    const c = await esbuild.context(main);
    await c.watch();
    console.log("[build] watching…");
  } else {
    await esbuild.build(main);
    await esbuild.build(testExports);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
