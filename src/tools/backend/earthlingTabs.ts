/**
 * Earthling custom MCP tools for cross-tab browser automation.
 *
 * These tools extend the standard Playwright MCP with the ability to discover
 * and switch between ALL open browser tabs (not just Playwright-managed ones),
 * enabling the agent to work within the user's authenticated browser session.
 */

import { z } from '../../mcpBundle';
import { defineTool } from './tool';
import { getRelay } from '../mcp/cdpRelay';

import type { Tool } from './tool';

const listAllTabs = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_list_all_tabs',
		title: 'List all browser tabs',
		description: 'List ALL open browser tabs (not just Playwright-managed ones). Returns tab IDs, titles, URLs, and flags (connected, highlighted, active). Use to discover available tabs before switching.',
		inputSchema: z.object({}),
		type: 'readOnly',
	},
	handle: async (context, _params, response) => {
		await context.ensureTab();
		const relay = getRelay();
		if (!relay || !(relay as any)._extensionConnection)
			throw new Error('Extension not connected. Make sure the Earthling Browser Bridge extension is active.');
		const tabs = await (relay as any)._extensionConnection.send('listBrowserTabs', {});
		const lines = ['### All Browser Tabs'];
		for (const t of tabs) {
			const flags: string[] = [];
			if (t.connected) flags.push('CONNECTED');
			if (t.highlighted) flags.push('HIGHLIGHTED');
			if (t.active) flags.push('active');
			const f = flags.length ? ' [' + flags.join(', ') + ']' : '';
			lines.push(`- tabId=${t.tabId}${f}: [${t.title}](${t.url})`);
		}
		response.addTextResult(lines.join('\n'));
	},
});

const switchTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_switch_tab',
		title: 'Switch to browser tab',
		description: 'Switch the browser connection to a different tab by tab ID (from browser_list_all_tabs). Detaches current debugger, attaches to the new tab. Call browser_snapshot after switching to see the page content.',
		inputSchema: z.object({
			tabId: z.number().describe('Tab ID from browser_list_all_tabs'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		await context.ensureTab();
		const relay = getRelay();
		if (!relay || !(relay as any)._extensionConnection)
			throw new Error('Extension not connected. Make sure the Earthling Browser Bridge extension is active.');

		// Switch the debugger to the new tab at the extension level
		await (relay as any)._extensionConnection.send('switchToTab', { tabId: params.tabId });

		// Close the stale Playwright browser context so the next tool call
		// gets a fresh Page for the new tab. Suppress extension disconnection
		// so the relay keeps the extension WebSocket alive during the reconnect.
		relay._skipExtensionClose = true;
		try { await context.closeBrowserContext(); } catch (_e) {}
		relay._skipExtensionClose = false;

		response.addTextResult(`Switched to tab ${params.tabId}. Use browser_snapshot to see the page content.`);
	},
});

const earthlingTabs: Tool<any>[] = [listAllTabs, switchTab];
export default earthlingTabs;
