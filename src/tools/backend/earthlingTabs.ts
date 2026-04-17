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

import type { Tool } from './tool';

async function relaySend(context: any, method: string, params: any = {}): Promise<any> {
	const browserContext = await context.ensureBrowserContext();
	const browser = browserContext.browser();
	if (!browser)
		throw new Error('No browser available to reach the relay.');
	const cdp = await browser.newBrowserCDPSession();
	try {
		return await cdp.send(method as any, params);
	} finally {
		await cdp.detach().catch(() => {});
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
			const flags: string[] = [];
			if (t.connected) flags.push('CONNECTED');
			if (t.highlighted) flags.push('HIGHLIGHTED');
			if (t.active) flags.push('active');
			let leaseLabel = '[free]';
			if (t.lease === 'you') leaseLabel = '[leased-by-you]';
			else if (t.lease === 'busy') leaseLabel = `[busy: ${t.ownerId}]`;
			const f = flags.length ? ' [' + flags.join(', ') + ']' : '';
			lines.push(`- tabId=${t.tabId} ${leaseLabel}${f}: [${t.title}](${t.url})`);
		}
		response.addTextResult(lines.join('\n'));
	},
});

const switchTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_switch_tab',
		title: 'Switch to browser tab',
		description: 'Switch the browser connection to a different tab by tab ID. Acquires an exclusive lease on the tab. If another client holds the lease, the call fails unless `force:true` is passed. Call browser_snapshot after switching.',
		inputSchema: z.object({
			tabId: z.number().describe('Tab ID from browser_list_all_tabs'),
			force: z.boolean().optional().describe('Take over the tab even if another client currently holds its lease. Default false.'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		await relaySend(context, 'Earthling.switchToTab', { tabId: params.tabId, force: !!params.force });
		// setClose() tells the MCP server to dispose this backend (closing
		// the connectOverCDP WebSocket). The next tool call creates a fresh
		// backend that reconnects and leases the extension's now-connected tab.
		response.setClose();
		response.addTextResult(`Switched to tab ${params.tabId}. Use browser_snapshot to see the page content.`);
	},
});

const releaseTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_release_tab',
		title: 'Release browser tab lease',
		description: 'Release your exclusive lease on a tab so other clients can claim it. Safe to call on a tab you do not own (no-op).',
		inputSchema: z.object({
			tabId: z.number().describe('Tab ID to release'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		const res = await relaySend(context, 'Earthling.releaseTab', { tabId: params.tabId });
		response.addTextResult(res?.released ? `Released tab ${params.tabId}.` : `Tab ${params.tabId} was not held by you.`);
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
			tabId: z.number().describe('Tab ID to close'),
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
