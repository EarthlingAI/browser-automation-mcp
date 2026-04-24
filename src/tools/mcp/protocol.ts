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

// Whenever the commands/events change, the version must be updated. The latest
// extension version should be compatible with the old MCP clients.
export const VERSION = 2;

export type ExtensionCommand = {
	'attachToTab': { params: { tabId: number }; result: { targetInfo: any; sessionId?: string } };
	'forwardCDPCommand': { params: { tabId: number; method: string; sessionId?: string; params?: any } };
	// Earthling: cross-tab control
	'listBrowserTabs': { params: {} };
	'switchToTab': { params: { tabId: number } };
	'openTab': { params: { url?: string } };
	'closeTab': { params: { tabId: number } };
	'detachFromTab': { params: { tabId: number } };
	'getDebugLog': { params: {} };
	// Earthling: dev-only orphan-sweep support. Returns about:blank tabs with
	// `lastAccessed` + `historyLength` so the daemon can decide which are safe
	// to close (stale, un-navigated, lease-free). Read-only; closure is done
	// via the existing `closeTab` handler to preserve invariant #9.
	'queryOrphanBlanks': {
		params: {};
		result: { tabs: Array<{ tabId: number; lastAccessed: number; historyLength: number }> };
	};
};

export type ExtensionEvents = {
	'forwardCDPEvent': { params: { method: string; sessionId?: string; tabId?: number; params?: any } };
	// Earthling: extension lifecycle
	'extensionReady': { params: { tabs: any[] } };
	'userSelectedTab': { params: { tabId: number; title: string; url: string } };
	'tabSwitched': { params: { tabId: number; targetInfo: any } };
	'tabReady': { params: { tabId: number } };
	'tabDetached': { params: { tabId: number; reason: string } };
};
