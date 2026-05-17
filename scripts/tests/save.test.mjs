// `resolveSavePath` — single source of truth for save_to_path resolution.
// Tests cover: the three boolean/undefined branches, auto-name generation,
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

test("resolveSavePath: false and undefined return null", () => {
  assert.equal(resolveSavePath(false, "jpeg", 42), null);
  assert.equal(resolveSavePath(undefined, "jpeg", 42), null);
});

test("resolveSavePath: true + jpeg → auto-named .jpg under outputs_dir", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    () => {
      const out = resolveSavePath(true, "jpeg", 42);
      assert.ok(path.isAbsolute(out), `expected absolute path, got ${out}`);
      assert.match(out, /screenshot_42_\d+\.jpg$/);
      assert.equal(path.dirname(out), getOutputsDir());
    },
  );
});

test("resolveSavePath: true + png → auto-named .png", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    () => {
      const out = resolveSavePath(true, "png", 99);
      assert.match(out, /screenshot_99_\d+\.png$/);
    },
  );
});

test("resolveSavePath: relative string resolves under outputs_dir", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: undefined,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    () => {
      const out = resolveSavePath("foo.png", "png", 1);
      assert.ok(path.isAbsolute(out));
      assert.equal(out, path.resolve(getOutputsDir(), "foo.png"));
    },
  );
});

test("resolveSavePath: absolute string passes through unchanged", () => {
  // Build an absolute target that's not the current working directory so the
  // test can prove the resolver isn't appending outputs_dir.
  const abs = path.resolve("/tmp/explicit-output.png");
  const out = resolveSavePath(abs, "png", 1);
  assert.equal(out, abs);
});

test("resolveSavePath: '..' segment is rejected with actionable error", () => {
  assert.throws(
    () => resolveSavePath("../../etc/passwd.png", "png", 1),
    /\.\./,
  );
  // Backslash-separated paths on Windows are also caught.
  assert.throws(
    () => resolveSavePath("..\\evil.png", "png", 1),
    /\.\./,
  );
});

test("getOutputsDir: BROWSER_AUTOMATION_MCP_OUTPUTS_DIR takes priority", () => {
  withEnv(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: "/custom/outputs",
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: "/different/runtime",
    },
    () => {
      assert.equal(getOutputsDir(), "/custom/outputs");
      const out = resolveSavePath("foo.jpg", "jpeg", 1);
      assert.equal(out, path.resolve("/custom/outputs", "foo.jpg"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "earthling-save-"));
  await withEnvAsync(
    {
      BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: tmpDir,
      BROWSER_AUTOMATION_MCP_RUNTIME_DIR: undefined,
    },
    async () => {
      // Tiny 1x1 PNG (8 bytes of base64 → valid PNG header) so we can write
      // and re-read without standing up a real Chrome.
      const tinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const ctx = {
        daemon: {
          sessionId: "save-integration",
          async exec(_tabId, _command) {
            return {
              tree: { role: "WebArea", name: "T", depth: 0, children: [] },
              screenshot: {
                format: "png",
                dataBase64: tinyPng,
                resizedTo: undefined,
              },
              dpr: 1,
            };
          },
        },
        session: new BridgeSession(),
      };
      ctx.session.lastLeasedTab = 7;
      const out = await runUnifiedCapture(ctx, 7, {
        detail: "standard",
        limit: 500,
        viewportOnly: true,
        screenshot: true,
        format: "png",
        quality: 70,
        save_to_path: true,
        withTree: true,
      });
      // savedTo lands in the text payload as an absolute path under tmpDir.
      assert.ok(out.payload.savedTo, "expected savedTo in payload");
      assert.equal(path.dirname(out.payload.savedTo), tmpDir);
      assert.match(out.payload.savedTo, /screenshot_7_\d+\.png$/);
      // The file actually exists on disk with the expected bytes.
      assert.ok(fs.existsSync(out.payload.savedTo));
      const written = fs.readFileSync(out.payload.savedTo);
      assert.ok(written.length > 0, "written file must be non-empty");
    },
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("runUnifiedCapture: save_to_path with traversal segment surfaces saveError, image still returns", async () => {
  // The throw from resolveSavePath is caught and reported via `saveError`,
  // not propagated as a fatal error. Image content block still emits.
  const ctx = {
    daemon: {
      sessionId: "save-error",
      async exec() {
        return {
          tree: { role: "WebArea", name: "T", depth: 0, children: [] },
          screenshot: { format: "jpeg", dataBase64: "x", resizedTo: undefined },
          dpr: 1,
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
    format: "jpeg",
    quality: 70,
    save_to_path: "../../escape.jpg",
    withTree: true,
  });
  assert.ok(out.image, "image block must still emit on save error");
  assert.ok(out.payload.saveError, "expected saveError field");
  assert.match(out.payload.saveError, /\.\./);
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
