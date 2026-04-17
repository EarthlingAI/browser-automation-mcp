/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Earthling: structured JSONL debug logging.
 *
 * Each layer (daemon, extension, mcp) gets a `debugJsonl()` function that
 * appends one JSON object per line to its dedicated file under
 * `.runtime/debug/`. Log lines share a schema:
 *
 *   { ts, layer, event, clientId?, tabId?, virtualSessionId?,
 *     realSessionId?, method?, dir?, seq?, detail? }
 *
 * Cross-layer correlation is done by filtering on clientId / tabId /
 * virtualSessionId. Writes are fire-and-forget via `fs.appendFile` to avoid
 * blocking the hot path. Failures are silently swallowed.
 */

import fs from 'fs';
import { DAEMON_JSONL, EXTENSION_JSONL, MCP_JSONL, DEBUG_DIR } from './paths';

export type DebugLayer = 'daemon' | 'extension' | 'mcp' | 'playwright';

export interface DebugLine {
  ts: number;
  layer: DebugLayer;
  event: string;
  clientId?: string;
  tabId?: number;
  virtualSessionId?: string;
  realSessionId?: string;
  method?: string;
  dir?: 'in' | 'out';
  seq?: number;
  detail?: any;
}

const LAYER_PATHS: Record<DebugLayer, string> = {
  daemon: DAEMON_JSONL,
  extension: EXTENSION_JSONL,
  mcp: MCP_JSONL,
  playwright: '',  // not currently wired
};

const seqs: Record<DebugLayer, number> = {
  daemon: 0,
  extension: 0,
  mcp: 0,
  playwright: 0,
};

let dirEnsured = false;
function ensureDir(): void {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {}
}

export function writeDebugLine(layer: DebugLayer, event: string, fields: Omit<DebugLine, 'ts' | 'layer' | 'event' | 'seq'> = {}): void {
  const path = LAYER_PATHS[layer];
  if (!path) return;
  ensureDir();
  seqs[layer] += 1;
  const line: DebugLine = {
    ts: Date.now(),
    layer,
    event,
    seq: seqs[layer],
    ...fields,
  };
  // Fire-and-forget append; never block or throw.
  fs.appendFile(path, JSON.stringify(line) + '\n', () => {});
}

export function daemonJsonl(event: string, fields: Omit<DebugLine, 'ts' | 'layer' | 'event' | 'seq'> = {}): void {
  writeDebugLine('daemon', event, fields);
}

export function mcpJsonl(event: string, fields: Omit<DebugLine, 'ts' | 'layer' | 'event' | 'seq'> = {}): void {
  writeDebugLine('mcp', event, fields);
}

/**
 * Append an extension-originated log entry to extension.jsonl. Called by the
 * daemon's `/debug/extension` HTTP endpoint when the extension POSTs its ring
 * buffer batch.
 */
export function appendExtensionJsonl(line: any): void {
  ensureDir();
  try {
    const augmented = { ts: Date.now(), ...line, layer: 'extension' };
    fs.appendFile(EXTENSION_JSONL, JSON.stringify(augmented) + '\n', () => {});
  } catch {}
}
