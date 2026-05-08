/**
 * Earthling custom MCP tools for cross-tab browser automation.
 *
 * Pseudo-CDP commands (`Earthling.*`) are dispatched over the existing
 * Playwright CDP channel to the relay daemon, so we share the per-process
 * client identity and lease ownership. Using `browser.newBrowserCDPSession()`
 * keeps this within public Playwright API.
 */

import { z } from '../../mcpBundle';
import { defineTool } from './tool';
import { safeDetach, withTimeoutMarker } from './utils';

import type { Tool } from './tool';

/**
 * Per-method budgets for client→daemon `Earthling.*` pseudo-CDP calls.
 * Missing keys fall back to 10s. Tuned to the operation's expected cost
 * (local lookups vs. navigation); any of these timing out signals the
 * relay or extension is unresponsive.
 */
const EARTHLING_TIMEOUTS: Record<string, number> = {
	'Earthling.listTabsAnnotated': 2_000,
	'Earthling.switchToTab': 5_000,
	'Earthling.releaseTab': 2_000,
	'Earthling.closeTab': 2_000,
	'Earthling.openTab': 10_000,
	'Earthling.whoAmI': 1_000,
};

class RelayTimeoutError extends Error {
	constructor(public readonly method: string, public readonly timeoutMs: number) {
		super(`${method} timed out after ${timeoutMs}ms; relay or extension may be unresponsive. Try again or call browser_list_all_tabs to re-sync.`);
	}
}

async function relaySend(context: any, method: string, params: any = {}): Promise<any> {
	const browserContext = await context.ensureBrowserContext();
	const browser = browserContext.browser();
	if (!browser)
		throw new Error('No browser available to reach the relay.');
	const cdp = await browser.newBrowserCDPSession();
	const timeoutMs = EARTHLING_TIMEOUTS[method] ?? 10_000;
	try {
		const outcome = await withTimeoutMarker<any>(method, () => cdp.send(method as any, params), timeoutMs, () => undefined);
		if (outcome.timedOut)
			throw new RelayTimeoutError(method, timeoutMs);
		return outcome.result;
	} finally {
		await safeDetach(cdp, 500);
	}
}

const listAllTabs = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_list_all_tabs',
		title: 'List all browser tabs',
		description: 'List ALL open browser tabs (not just Playwright-managed ones). Each tab is annotated with its lease status: [leased-by-you], [busy: <clientId>], or [free]. Use before switching to another tab.',
		inputSchema: z.object({}),
		type: 'readOnly',
	},
	handle: async (context, _params, response) => {
		const tabs: any[] = await relaySend(context, 'Earthling.listTabsAnnotated', {});
		const lines = ['### All Browser Tabs'];
		for (const t of tabs) {
			let leaseLabel = '[free]';
			if (t.lease === 'you') leaseLabel = '[leased-by-you]';
			else if (t.lease === 'busy') leaseLabel = `[busy: ${t.ownerId}]`;
			const f = t.active ? ' [active]' : '';
			// Defuse relay responses where the extension returned undefined/empty title.
			const title = (t.title && String(t.title)) || '<unknown>';
			lines.push(`- tabId=${t.tabId} ${leaseLabel}${f}: [${title}](${t.url})`);
		}
		response.addTextResult(lines.join('\n'));
	},
});

const switchTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_switch_tab',
		title: 'Switch to browser tab',
		description: 'Switch the browser connection to a different tab by tab ID. Acquires an exclusive lease on the tab. If another client holds the lease, the call fails unless `force:true` is passed. When force preempts an existing holder, the response includes "Preempted lease from client <id> (force:true)."; when the target was already free, the preemption line is omitted. Call browser_snapshot after switching.',
		inputSchema: z.object({
			tabId: z.coerce.number().describe('Tab ID from browser_list_all_tabs'),
			force: z.boolean().optional().describe('Take over the tab even if another client currently holds its lease. Default false.'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		const res = await relaySend(context, 'Earthling.switchToTab', { tabId: params.tabId, force: !!params.force });
		// Per-tab Page pool: switch is pure JS routing — claim the lease at the
		// daemon (above), then ensure a Page exists for this tabId in our pool
		// (binds via Earthling.bindTab if missing). The WebSocket stays alive.
		await context.acquireTab(params.tabId, !!params.force);
		const parts = [`Switched to tab ${res?.claimed ?? params.tabId}.`];
		if (res?.released != null)
			parts.push(`Released prior tab ${res.released}.`);
		if (res?.revokedFrom)
			parts.push(`Preempted lease from client ${res.revokedFrom} (force:true).`);
		parts.push('Use browser_snapshot to see the page content.');
		response.addTextResult(parts.join(' '));
	},
});

const releaseTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_release_tab',
		title: 'Release browser tab lease',
		description: 'Release your exclusive lease on a tab so other clients can claim it. Safe to call on a tab you do not own (no-op).',
		inputSchema: z.object({
			tabId: z.coerce.number().describe('Tab ID to release'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		const res = await relaySend(context, 'Earthling.releaseTab', { tabId: params.tabId });
		if (!res?.released) {
			response.addTextResult(`Tab ${params.tabId} was not held by you.`);
			return;
		}
		response.addTextResult(`Released tab ${params.tabId}.${res.detached ? ' (CDP debugger detached.)' : ''}`);
	},
});

const openTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_open_tab',
		title: 'Open a new browser tab',
		description: 'Open a new tab, optionally navigating to a URL. Returns the new tab ID. Use browser_switch_tab to interact with it.',
		inputSchema: z.object({
			url: z.string().optional().describe('URL to navigate to (default: blank page)'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		// Suppress the `### Page` block: browser_open_tab returns just the
		// "Opened tab N" line regardless of whether the current-tab header
		// changed. Guarantees a consistent response shape across parallel
		// callers where only the first would otherwise see a changed header.
		response.setIncludePage(false);
		const result = await relaySend(context, 'Earthling.openTab', { url: params.url });
		response.addTextResult(`Opened tab ${result.tabId}. Use browser_switch_tab to interact with it.`);
	},
});

const closeTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_close_tab',
		title: 'Close a browser tab',
		description: 'Close a browser tab by tab ID. Also releases any lease held on it.',
		inputSchema: z.object({
			tabId: z.coerce.number().describe('Tab ID to close'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		// Check if we're closing our own primary tab — if so, dispose the
		// backend to avoid captureSnapshot on a dead page (30s hang).
		const whoami = await relaySend(context, 'Earthling.whoAmI', {});
		await relaySend(context, 'Earthling.closeTab', { tabId: params.tabId });
		if (whoami.primaryTab === params.tabId)
			response.setClose();
		response.addTextResult(`Closed tab ${params.tabId}.`);
	},
});

const earthlingTabs: Tool<any>[] = [listAllTabs, switchTab, openTab, closeTab, releaseTab];
export default earthlingTabs;
