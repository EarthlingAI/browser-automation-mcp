// browser_drop — bridge-side wiring (CP7). The file-drop synthesis (build a
// DataTransfer carrying the files, then dragenter→dragover→drop) lives in
// helpers.js (page-side); this pins the bridge contract: read the file payloads
// off disk (reusing the upload reader) and forward a `drop` ExtCommand carrying
// {ref, files:[{name, mimeType, dataBase64}]} to the leased tab. A missing file
// errors before any daemon hop.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeSession,
  registerInteractTools,
} from "../../dist/test-exports.mjs";

const TAB = 808;

function setup(responses = []) {
  const calls = [];
  const queue = [...responses];
  const session = new BridgeSession();
  session.lastSnapshotTabId = TAB;
  session.lastLeasedTab = TAB;
  session.isStale = false;
  const meta = { role: "region", tabId: TAB, snapshotAt: Date.now() };
  session.lastSnapshotRefs.set("5", meta);
  session.refRegistry.set("5", meta);
  const daemon = {
    sessionId: "test-drop",
    takeEnv: () => undefined,
    peekEnv: () => undefined,
    async exec(tabId, command) {
      calls.push({ tabId, command });
      if (queue.length === 0)
        throw new Error(`unexpected daemon.exec call: ${command.kind}`);
      return queue.shift();
    },
  };
  const callbacks = new Map();
  const server = {
    registerTool(name, _cfg, cb) {
      callbacks.set(name, cb);
    },
  };
  registerInteractTools(server, { daemon, session });
  return { calls, callbacks, session };
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("drop reads files off disk and forwards a drop ExtCommand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bamcp-drop-"));
  const file = join(dir, "hello.txt");
  writeFileSync(file, "drop me");
  try {
    const { calls, callbacks } = setup([{ dropped: ["hello.txt"], ref: "5" }]);
    const drop = callbacks.get("browser_drop");
    assert.ok(drop, "browser_drop should be registered");

    await drop({ ref: "5", files: [file], tabId: TAB });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tabId, TAB);
    assert.equal(calls[0].command.kind, "drop");
    assert.equal(calls[0].command.ref, "5");
    assert.equal(calls[0].command.files.length, 1);
    const f = calls[0].command.files[0];
    assert.equal(f.name, "hello.txt");
    assert.equal(f.mimeType, "text/plain");
    assert.equal(Buffer.from(f.dataBase64, "base64").toString(), "drop me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drop surfaces a read error for a missing file (no daemon hop)", async () => {
  const { calls, callbacks } = setup();
  const drop = callbacks.get("browser_drop");
  const res = await drop({
    ref: "5",
    files: ["/nonexistent/path/to/file.bin"],
    tabId: TAB,
  });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0, "no drop should have been sent");
});
