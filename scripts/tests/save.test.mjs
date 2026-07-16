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
          takeEnv: () => undefined,
          peekEnv: () => undefined,
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
        screenshot: "annotated",
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
          takeEnv: () => undefined,
          peekEnv: () => undefined,
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
        screenshot: "annotated",
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
      takeEnv: () => undefined,
      peekEnv: () => undefined,
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
    screenshot: "annotated",
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
      takeEnv: () => undefined,
      peekEnv: () => undefined,
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
    screenshot: "annotated",
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

// ── save_tree_to_path (tree offload) ─────────────────────────────────────────

import {
  resolveTreeSavePath,
  saveTreeToPathSchema,
  mergeRefsIntoRegistry,
  TREE_EXTS,
} from "../../dist/test-exports.mjs";

test("resolveTreeSavePath: true → auto-named tree_<tab>_<ms>.txt in outputs dir", () => {
  withEnv({ BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: path.join(os.tmpdir(), "ba-tree-out") }, () => {
    const p = resolveTreeSavePath(true, 42);
    assert.match(path.basename(p), /^tree_42_\d+\.txt$/);
    assert.ok(p.startsWith(path.join(os.tmpdir(), "ba-tree-out")));
  });
});

test("resolveTreeSavePath: relative .md resolves under outputs dir; absolute passes through", () => {
  withEnv({ BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: path.join(os.tmpdir(), "ba-tree-out") }, () => {
    const rel = resolveTreeSavePath("notes/tree.md", 1);
    assert.ok(rel.startsWith(path.join(os.tmpdir(), "ba-tree-out")));
    const absIn = path.join(os.tmpdir(), "elsewhere", "t.txt");
    assert.equal(resolveTreeSavePath(absIn, 1), absIn);
  });
});

test("resolveTreeSavePath: '..' segment and bad extension are rejected", () => {
  assert.throws(() => resolveTreeSavePath("../t.txt", 1), /\.\./);
  assert.throws(() => resolveTreeSavePath("t.html", 1), /unsupported extension/);
  assert.throws(() => resolveTreeSavePath("t", 1), /unsupported extension/);
});

test("saveTreeToPathSchema: coerces stringified booleans, gates extension at schema time", () => {
  assert.equal(saveTreeToPathSchema.parse("true"), true);
  assert.equal(saveTreeToPathSchema.parse("false"), false);
  assert.equal(saveTreeToPathSchema.parse(undefined), false);
  assert.equal(saveTreeToPathSchema.parse("out.txt"), "out.txt");
  assert.equal(saveTreeToPathSchema.parse("out.md"), "out.md");
  assert.throws(() => saveTreeToPathSchema.parse("out.html"));
  for (const ext of TREE_EXTS) assert.ok([".txt", ".md"].includes(ext));
});

test("runUnifiedCapture: save_tree_to_path writes the UNCAPPED outline; refs merge into refRegistry only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ba-tree-"));
  await withEnvAsync({ BROWSER_AUTOMATION_MCP_OUTPUTS_DIR: dir }, async () => {
    // 30 buttons; inline limit 5 caps the outline, but the offload must carry all 30.
    const tree = {
      nodeId: "root",
      role: "WebArea",
      name: "T",
      depth: 0,
      cssViewport: { w: 1024, h: 768 },
      children: Array.from({ length: 30 }, (_, i) => ({
        nodeId: String(i + 1),
        role: "button",
        name: `Btn ${i}`,
        depth: 1,
        rect: { x: 10, y: 10 + i * 20, w: 100, h: 18 },
        inViewport: true,
        children: [],
      })),
    };
    const ctx = {
      daemon: {
        sessionId: "t",
        takeEnv: () => undefined,
        peekEnv: () => undefined,
        async exec() {
          return { tree, screenshot: undefined, cssViewport: { w: 1024, h: 768 } };
        },
      },
      session: new BridgeSession(),
    };
    ctx.session.lastLeasedTab = 3;
    const out = await runUnifiedCapture(ctx, 3, {
      detail: "standard",
      limit: 5,
      viewportOnly: false,
      screenshot: "off",
      quality: 70,
      save_to_path: false,
      save_tree_to_path: true,
      withTree: true,
    });
    // Inline outline is capped…
    assert.ok(out.payload.meta.truncated, "inline outline must be capped at limit 5");
    assert.ok(!out.payload.tree.includes('"Btn 29"'), "capped outline must not include the tail");
    // …the offloaded file is not.
    assert.ok(out.payload.treeSavedTo, "treeSavedTo missing");
    const fileText = fs.readFileSync(out.payload.treeSavedTo, "utf8");
    assert.match(fileText, /Btn 29/, "offloaded outline must be uncapped");
    // Ref merge: file-only refs resolve via refRegistry but are NOT "current".
    assert.ok(ctx.session.refRegistry.has("30"), "file-sourced ref must be in refRegistry");
    assert.ok(!ctx.session.lastSnapshotRefs.has("30"), "file-sourced ref must NOT be in lastSnapshotRefs");
    // The inline snapshot's own refs are in both.
    assert.ok(ctx.session.lastSnapshotRefs.has("1"));
  });
});

test("runUnifiedCapture: tree-offload write failure is non-fatal (treeSaveError)", async () => {
  const tree = {
    nodeId: "root",
    role: "WebArea",
    name: "T",
    depth: 0,
    cssViewport: { w: 1024, h: 768 },
    children: [
      { nodeId: "1", role: "button", name: "B", depth: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, inViewport: true, children: [] },
    ],
  };
  const ctx = {
    daemon: {
      sessionId: "t",
      takeEnv: () => undefined,
      peekEnv: () => undefined,
      async exec() {
        return { tree, screenshot: undefined, cssViewport: { w: 1024, h: 768 } };
      },
    },
    session: new BridgeSession(),
  };
  ctx.session.lastLeasedTab = 3;
  const out = await runUnifiedCapture(ctx, 3, {
    detail: "standard",
    limit: 500,
    viewportOnly: false,
    screenshot: "off",
    quality: 70,
    save_to_path: false,
    save_tree_to_path: "../escape.txt",
    withTree: true,
  });
  assert.ok(out.payload.tree, "snapshot must still return");
  assert.match(out.payload.treeSaveError, /\.\./);
  assert.equal(out.payload.treeSavedTo, undefined);
});

test("mergeRefsIntoRegistry: no-op for a different tab (registry is per-tab)", () => {
  const session = new BridgeSession();
  session.lastSnapshotTabId = 1;
  mergeRefsIntoRegistry(session, { ref: "9", role: "button", name: "X" }, undefined, 2);
  assert.equal(session.refRegistry.size, 0);
});
