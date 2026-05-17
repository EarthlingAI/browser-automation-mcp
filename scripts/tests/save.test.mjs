// `resolveSavePath` — single source of truth for save_to_path resolution.
// Tests cover: the three boolean/undefined branches, auto-name generation,
// extension-driven format inference (Round 7), unknown-extension rejection,
// relative+absolute path passthrough, traversal rejection, and env-var
// overrides for the outputs directory.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSavePath,
  getOutputsDir,
  runUnifiedCapture,
  BridgeSession,
} from "../../dist/test-exports.mjs";

// Each test isolates env-var state so they can run in any order.
function withEnv(overrides, fn) {
  const snapshot = {};
  for (const k of Object.keys(overrides)) snapshot[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

test("resolveSavePath: false → {path:null, format:'jpeg'}", () => {
  const r = resolveSavePath(false, 42);
  assert.equal(r.path, null);
  assert.equal(r.format, "jpeg");
});

test("resolveSavePath: undefined → {path:null, format:'jpeg'}", () => {
  const r = resolveSavePath(undefined, 42);
  assert.equal(r.path, null);
  assert.equal(r.format, "jpeg");
});

test("resolveSavePath: true → auto-named .jpg, format:'jpeg'", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    () => {
      const r = resolveSavePath(true, 42);
      assert.ok(path.isAbsolute(r.path), `expected absolute path, got ${r.path}`);
      assert.match(r.path, /screenshot_42_\d+\.jpg$/);
      assert.equal(path.dirname(r.path), getOutputsDir());
      assert.equal(r.format, "jpeg");
    },
  );
});

test("resolveSavePath: string '.png' → format:'png'", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    () => {
      const r = resolveSavePath("foo.png", 1);
      assert.ok(path.isAbsolute(r.path));
      assert.equal(r.path, path.resolve(getOutputsDir(), "foo.png"));
      assert.equal(r.format, "png");
    },
  );
});

test("resolveSavePath: string '.jpg' and '.jpeg' both → format:'jpeg'", () => {
  withEnv(
    { BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined, BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined },
    () => {
      assert.equal(resolveSavePath("a.jpg", 1).format, "jpeg");
      assert.equal(resolveSavePath("a.jpeg", 1).format, "jpeg");
      assert.equal(resolveSavePath("A.JPG", 1).format, "jpeg"); // case-insensitive
    },
  );
});

test("resolveSavePath: unknown extension throws actionable error", () => {
  assert.throws(
    () => resolveSavePath("foo.bin", 1),
    /unsupported extension/i,
  );
  assert.throws(
    () => resolveSavePath("foo.webp", 1),
    /unsupported extension/i,
  );
  // No extension at all.
  assert.throws(
    () => resolveSavePath("no_extension", 1),
    /unsupported extension/i,
  );
});

test("resolveSavePath: absolute string passes through unchanged", () => {
  const abs = path.resolve("/tmp/explicit-output.png");
  const r = resolveSavePath(abs, 1);
  assert.equal(r.path, abs);
  assert.equal(r.format, "png");
});

test("resolveSavePath: '..' segment is rejected with actionable error", () => {
  assert.throws(() => resolveSavePath("../../etc/passwd.png", 1), /\.\./);
  // Backslash-separated paths on Windows are also caught.
  assert.throws(() => resolveSavePath("..\\evil.png", 1), /\.\./);
});

test("getOutputsDir: BROWSER_AUTOMATION_MCP_OUTPUTS_DIR takes priority", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: "/custom/outputs",
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: "/different/runtime",
    },
    () => {
      assert.equal(getOutputsDir(), "/custom/outputs");
      const r = resolveSavePath("foo.jpg", 1);
      assert.equal(r.path, path.resolve("/custom/outputs", "foo.jpg"));
    },
  );
});

test("getOutputsDir: RUNTIME_DIR fallback lands under <runtime>/outputs", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: "/some/runtime",
    },
    () => {
      assert.equal(getOutputsDir(), path.join("/some/runtime", "outputs"));
    },
  );
});

test("getOutputsDir: bare cwd-relative fallback when no env vars set", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    () => {
      const out = getOutputsDir();
      assert.ok(path.isAbsolute(out));
      assert.equal(out, path.join(process.cwd(), "outputs", "browser"));
    },
  );
});

// Happy-path integration: the unified-capture orchestrator actually writes
// the bitmap to disk and surfaces `savedTo` in the payload. Pure-function
// resolveSavePath tests above prove the path math; this test proves the
// write path is wired correctly end-to-end.

test("runUnifiedCapture: save_to_path:true writes the file and reports savedTo", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-save-"));
  await withEnvAsync(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: tmpDir,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    async () => {
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const ctx = {
        daemon: {
          sessionId: "save-integration",
          async exec(_tabId, _command) {
            return {
              tree: { role: "WebArea", name: "T", depth: 0, children: [] },
              screenshot: {
                format: "jpeg",
                dataBase64: tinyPng,
                resizedTo: undefined,
              },
              cssViewport: { w: 1920, h: 1080 },
            };
          },
        },
        session: new BridgeSession(),
      };
      ctx.session.lastLeasedTab = 7;
      // save_to_path:true → auto-name with .jpg → format jpeg.
      const out = await runUnifiedCapture(ctx, 7, {
        detail: "standard",
        limit: 500,
        viewportOnly: true,
        screenshot: true,
        quality: 70,
        save_to_path: true,
        withTree: true,
      });
      assert.ok(out.payload.savedTo, "expected savedTo in payload");
      assert.equal(path.dirname(out.payload.savedTo), tmpDir);
      assert.match(out.payload.savedTo, /screenshot_7_\d+\.jpg$/);
      assert.ok(fs.existsSync(out.payload.savedTo));
      const written = fs.readFileSync(out.payload.savedTo);
      assert.ok(written.length > 0, "written file must be non-empty");
    },
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("runUnifiedCapture: explicit '.png' path → image format follows extension", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-save-png-"));
  await withEnvAsync(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: tmpDir,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    async () => {
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const seenFormats = [];
      const ctx = {
        daemon: {
          sessionId: "save-png",
          async exec(_tabId, command) {
            seenFormats.push(command.format);
            return {
              tree: { role: "WebArea", name: "T", depth: 0, children: [] },
              screenshot: {
                format: "png",
                dataBase64: tinyPng,
                resizedTo: undefined,
              },
              cssViewport: { w: 1920, h: 1080 },
            };
          },
        },
        session: new BridgeSession(),
      };
      ctx.session.lastLeasedTab = 11;
      const out = await runUnifiedCapture(ctx, 11, {
        detail: "standard",
        limit: 500,
        viewportOnly: true,
        screenshot: true,
        quality: 70,
        save_to_path: "explicit.png",
        withTree: true,
      });
      // The snapshot_capture hop receives format:'png' derived from the
      // .png save path — no separate format arg needed.
      assert.equal(seenFormats[0], "png");
      assert.match(out.payload.savedTo, /explicit\.png$/);
      assert.equal(out.image.mimeType, "image/png");
    },
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("runUnifiedCapture: save_to_path with traversal segment surfaces saveError, image still returns", async () => {
  const ctx = {
    daemon: {
      sessionId: "save-error",
      async exec() {
        return {
          tree: { role: "WebArea", name: "T", depth: 0, children: [] },
          screenshot: { format: "jpeg", dataBase64: "x", resizedTo: undefined },
          cssViewport: { w: 1920, h: 1080 },
        };
      },
    },
    session: new BridgeSession(),
  };
  ctx.session.lastLeasedTab = 1;
  const out = await runUnifiedCapture(ctx, 1, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: true,
    quality: 70,
    save_to_path: "../../escape.jpg",
    withTree: true,
  });
  assert.ok(out.image, "image block must still emit on save error");
  assert.ok(out.payload.saveError, "expected saveError field");
  assert.match(out.payload.saveError, /\.\./);
  assert.equal(out.payload.savedTo, undefined);
});

test("runUnifiedCapture: unsupported save extension surfaces saveError, image still returns", async () => {
  const ctx = {
    daemon: {
      sessionId: "save-bad-ext",
      async exec() {
        return {
          tree: { role: "WebArea", name: "T", depth: 0, children: [] },
          screenshot: { format: "jpeg", dataBase64: "x", resizedTo: undefined },
          cssViewport: { w: 1920, h: 1080 },
        };
      },
    },
    session: new BridgeSession(),
  };
  ctx.session.lastLeasedTab = 1;
  const out = await runUnifiedCapture(ctx, 1, {
    detail: "standard",
    limit: 500,
    viewportOnly: true,
    screenshot: true,
    quality: 70,
    save_to_path: "foo.bin",
    withTree: true,
  });
  assert.ok(out.image, "image block must still emit on bad extension");
  assert.ok(out.payload.saveError, "expected saveError field");
  assert.match(out.payload.saveError, /unsupported extension/i);
  assert.equal(out.payload.savedTo, undefined);
});

async function withEnvAsync(overrides, fn) {
  const snapshot = {};
  for (const k of Object.keys(overrides)) snapshot[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}
