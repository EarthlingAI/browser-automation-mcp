// Auto-saved file retention — `pruneAutoSaved` and the write-path hook.
// Contract: only auto-named saves (screenshot_<tab>_<ms>.jpg, tree_<tab>_<ms>.txt,
// fetch_<ms>.txt|.bin) directly in the outputs dir are pruned — older than the age
// limit first, then the oldest beyond the count cap. Agent-named files, other
// names, and subdirectories are never touched; the file just written always
// survives; errors never throw.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pruneAutoSaved,
  writeBase64,
  writeText,
  AUTO_SAVED_NAME_RE,
  AUTO_SAVED_MAX_AGE_MS,
  AUTO_SAVED_MAX_FILES,
} from "../../dist/test-exports.mjs";

const DAY_MS = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 6);

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bam-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(dir, name, ageMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  const t = new Date(NOW - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

function withOutputsDir(dir, fn) {
  const prev = process.env.BROWSER_AUTOMATION_MCP_OUTPUTS_DIR;
  process.env.BROWSER_AUTOMATION_MCP_OUTPUTS_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BROWSER_AUTOMATION_MCP_OUTPUTS_DIR;
    else process.env.BROWSER_AUTOMATION_MCP_OUTPUTS_DIR = prev;
  }
}

test("limits are 7 days and 200 files", (t) => {
  assert.equal(AUTO_SAVED_MAX_AGE_MS, 7 * DAY_MS);
  assert.equal(AUTO_SAVED_MAX_FILES, 200);
});

test("name pattern matches exactly the auto-namer outputs", (t) => {
  for (const ok of ["screenshot_12_1730000000000.jpg", "tree_3_1730000000000.txt", "fetch_1730000000000.txt", "fetch_1730000000000.bin"]) {
    assert.ok(AUTO_SAVED_NAME_RE.test(ok), ok);
  }
  for (const bad of [
    // A .png auto-name existed only briefly in development and never shipped.
    "screenshot_12_1730000000000.png",
    "earth-home.jpg",
    "screenshot_12.jpg",
    "tree_3_1730000000000.md",
    "fetch_1730000000000.json",
    "xscreenshot_1_2.jpg",
    "screenshot_1_2.jpg.bak",
  ]) {
    assert.ok(!AUTO_SAVED_NAME_RE.test(bad), bad);
  }
});

test("age rule deletes auto-saved files older than 7 days, keeps younger ones", (t) => {
  const dir = tmpDir(t);
  const old = touch(dir, "screenshot_1_100.jpg", 8 * DAY_MS);
  const oldTree = touch(dir, "tree_1_101.txt", 7 * DAY_MS + 1000);
  const young = touch(dir, "fetch_102.bin", 6 * DAY_MS);
  const keep = touch(dir, "screenshot_1_103.jpg", 0);
  const removed = pruneAutoSaved(dir, keep, NOW);
  assert.deepEqual(removed.sort(), [old, oldTree].sort());
  assert.ok(fs.existsSync(young));
  assert.ok(fs.existsSync(keep));
});

test("count cap keeps the newest 200 including the just-saved file", (t) => {
  const dir = tmpDir(t);
  const paths = [];
  for (let i = 0; i < 205; i++) paths.push(touch(dir, `screenshot_1_${1000 + i}.jpg`, (205 - i) * 1000));
  const keep = paths[paths.length - 1];
  const removed = pruneAutoSaved(dir, keep, NOW);
  assert.equal(removed.length, 5);
  assert.deepEqual(removed.sort(), paths.slice(0, 5).sort());
  assert.equal(fs.readdirSync(dir).length, 200);
});

test("count cap ties on mtime break by name, newest name kept", (t) => {
  const dir = tmpDir(t);
  const paths = [];
  for (let i = 0; i < 201; i++) paths.push(touch(dir, `fetch_${String(1000 + i)}.txt`, 5000));
  const keep = touch(dir, "fetch_9999.txt", 0);
  const removed = pruneAutoSaved(dir, keep, NOW);
  assert.deepEqual(removed.sort(), paths.slice(0, 2).sort());
});

test("the just-saved file survives even when it looks expired", (t) => {
  const dir = tmpDir(t);
  const keep = touch(dir, "screenshot_1_1.jpg", 30 * DAY_MS);
  assert.deepEqual(pruneAutoSaved(dir, keep, NOW), []);
  assert.ok(fs.existsSync(keep));
});

test("agent-named files, foreign names and subdirectories are never touched", (t) => {
  const dir = tmpDir(t);
  const named = touch(dir, "earth-home-section.jpg", 60 * DAY_MS);
  const png = touch(dir, "screenshot_1_5.png", 60 * DAY_MS);
  const sub = path.join(dir, "screenshot_1_6.jpg");
  fs.mkdirSync(sub);
  const nested = path.join(dir, "review");
  fs.mkdirSync(nested);
  const nestedOld = touch(nested, "screenshot_1_7.jpg", 60 * DAY_MS);
  const keep = touch(dir, "screenshot_1_8.jpg", 0);
  assert.deepEqual(pruneAutoSaved(dir, keep, NOW), []);
  for (const p of [named, png, sub, nestedOld, keep]) assert.ok(fs.existsSync(p), p);
});

test("an unreadable directory is fail-soft", (t) => {
  const missing = path.join(tmpDir(t), "nope");
  assert.deepEqual(pruneAutoSaved(missing, path.join(missing, "screenshot_1_1.jpg"), NOW), []);
});

test("writeText / writeBase64 prune after an auto-named write into the outputs dir", (t) => {
  const dir = tmpDir(t);
  const old = touch(dir, "tree_1_1.txt", 8 * DAY_MS);
  const oldBin = touch(dir, "fetch_2.bin", 8 * DAY_MS);
  withOutputsDir(dir, () => {
    writeText(path.join(dir, "tree_1_3.txt"), "outline");
  });
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(oldBin));
  const older = touch(dir, "screenshot_2_4.jpg", 8 * DAY_MS);
  withOutputsDir(dir, () => {
    writeBase64(path.join(dir, "fetch_5.bin"), Buffer.from("hi").toString("base64"));
  });
  assert.ok(!fs.existsSync(older));
  assert.ok(fs.existsSync(path.join(dir, "fetch_5.bin")));
});

test("an agent-named write or a write elsewhere does not prune", (t) => {
  const dir = tmpDir(t);
  const old = touch(dir, "screenshot_1_1.jpg", 8 * DAY_MS);
  withOutputsDir(dir, () => {
    writeText(path.join(dir, "notes.txt"), "x");
    const other = tmpDir(t);
    writeText(path.join(other, "tree_1_2.txt"), "x");
  });
  assert.ok(fs.existsSync(old));
});

test("a symlink named like an auto-save is never deleted", (t) => {
  const dir = tmpDir(t);
  const target = touch(dir, "deliverable.jpg", 60 * DAY_MS);
  const link = path.join(dir, "screenshot_1_1.jpg");
  try {
    fs.symlinkSync(target, link, "file");
  } catch {
    t.skip("symlink creation not permitted here");
    return;
  }
  const keep = touch(dir, "screenshot_1_2.jpg", 0);
  assert.deepEqual(pruneAutoSaved(dir, keep, NOW), []);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(target));
});

test("a delete failure is logged, never thrown, and the rest still prune", (t) => {
  const dir = tmpDir(t);
  const stuck = touch(dir, "screenshot_1_1.jpg", 9 * DAY_MS);
  const gone = touch(dir, "screenshot_1_2.jpg", 8 * DAY_MS);
  const keep = touch(dir, "screenshot_1_3.jpg", 0);
  const remove = (p) => {
    if (p === stuck) throw Object.assign(new Error("locked"), { code: "EPERM" });
    fs.unlinkSync(p);
  };
  let removed;
  assert.doesNotThrow(() => { removed = pruneAutoSaved(dir, keep, NOW, remove); });
  assert.deepEqual(removed, [gone]);
  assert.ok(fs.existsSync(stuck));
});

test("a file already deleted by a concurrent prune is skipped quietly", (t) => {
  const dir = tmpDir(t);
  touch(dir, "fetch_1.bin", 8 * DAY_MS);
  const keep = touch(dir, "fetch_2.bin", 0);
  const errors = [];
  t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
  const remove = () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  assert.deepEqual(pruneAutoSaved(dir, keep, NOW, remove), []);
  assert.deepEqual(errors, []);
});
