/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as playwright from 'playwright-core';
import { debug } from '../../utilsBundle';
import { acquireDaemon } from './relay/clientAcquirer';
import { DEFAULT_RELAY_PORT } from './relay/constants';
import { mcpJsonl } from './relay/debugJsonl';

import type { ClientInfo } from '../utils/mcp/server';
import type { FullConfig } from './config';

const debugLogger = debug('pw:mcp:relay');

export async function createExtensionBrowser(_config: FullConfig, _clientInfo: ClientInfo): Promise<playwright.Browser> {
  const port = parseInt(process.env.BROWSER_AUTOMATION_MCP_RELAY_PORT || String(DEFAULT_RELAY_PORT), 10);
  const channel = _config.browser?.launchOptions?.channel;
  const stableClientId = `mcp-${process.pid}`;
  mcpJsonl('mcp.connectOverCDP.start', { clientId: stableClientId, detail: { port, channel, pid: process.pid } });
  let info;
  try {
    info = await acquireDaemon(port, channel);
  } catch (e: any) {
    mcpJsonl('mcp.connectOverCDP.fail', { clientId: stableClientId, detail: { stage: 'acquireDaemon', error: String(e?.message || e) } });
    throw e;
  }
  // Stable client ID per MCP process — daemon reuses identity across reconnections
  // so lease annotations stay consistent after browser_switch_tab disposal cycles.
  const endpoint = `ws://127.0.0.1:${port}${info.cdpPath}?clientId=${encodeURIComponent(stableClientId)}`;
  debugLogger(`Connecting to relay daemon at ${endpoint} (pid=${info.pid})`);
  let browser;
  try {
    browser = await playwright.chromium.connectOverCDP(endpoint, { isLocal: true });
  } catch (e: any) {
    mcpJsonl('mcp.connectOverCDP.fail', { clientId: stableClientId, detail: { stage: 'connectOverCDP', error: String(e?.message || e), endpoint } });
    throw e;
  }
  mcpJsonl('mcp.connectOverCDP.success', { clientId: stableClientId, detail: { endpoint, daemonPid: info.pid } });
  // Settle: wait for the page to be ready after connection. Prevents transient
  // timeouts (e.g. take_screenshot) when the page hasn't fully settled yet.
  const contexts = browser.contexts();
  if (contexts.length > 0) {
    const pages = contexts[0].pages();
    if (pages.length > 0)
      await pages[0].waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  }
  // If the relay daemon dies (grace exit after extension loss, crash, etc.) the
  // underlying ws closes and our cached Browser becomes unusable. There's no
  // in-place reconnect — every cached page reference is gone. Exit the MCP
  // server so its supervisor relaunches it; the next tool call re-acquires.
  browser.on('disconnected', () => {
    // The underlying ws is dead; every cached page reference is invalid. The
    // caller in program.ts creates a fresh BrowserBackend per MCP client
    // lifecycle, so the next reconnect happens when the MCP client reconnects
    // (or the process restarts). We log but do not exit — exiting silently
    // would leave the MCP in a broken state with no tool responses.
    debugLogger('CDP ws disconnected — subsequent tool calls will error until reconnection.');
    mcpJsonl('mcp.browser.disconnected', { clientId: stableClientId });
  });
  return browser;
}
