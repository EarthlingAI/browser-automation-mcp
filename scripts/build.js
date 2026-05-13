#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const watch = process.argv.includes("--watch");

const ctx = {
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  external: [],
  logLevel: "info",
};

(async () => {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  if (watch) {
    const c = await esbuild.context(ctx);
    await c.watch();
    console.log("[build] watching…");
  } else {
    await esbuild.build(ctx);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
