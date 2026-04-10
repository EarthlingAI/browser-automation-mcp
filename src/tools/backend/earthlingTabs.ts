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
		// Earthling: no ensureTab() needed — listing tabs only requires the extension
		// WebSocket, not a Playwright page. ensureTab() would trigger snapshotForAI()
		// which times out if the current page is heavy or the debugger is detached.
		const relay = getRelay();
		if (!relay?.extensionConnection)
			throw new Error('Extension not connected. Make sure the Earthling Browser Bridge extension is active.');
		const tabs = await relay.extensionConnection.send('listBrowserTabs', {});
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
		// Earthling: no ensureTab() needed — switching only requires the extension.
		// ensureTab() would trigger snapshotForAI() and fail after a prior switch.
		const relay = getRelay();
		if (!relay?.extensionConnection)
			throw new Error('Extension not connected. Make sure the Earthling Browser Bridge extension is active.');

		// Switch debugger to new tab at extension level
		await relay.extensionConnection.send('switchToTab', { tabId: params.tabId });

		// Signal server.ts to dispose this backend and clear backendPromise.
		// Next tool call will create fresh Browser → Context → Page for the new tab.
		response.setClose();
		response.addTextResult(`Switched to tab ${params.tabId}. Use browser_snapshot to see the page content.`);
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
		const relay = getRelay();
		if (!relay?.extensionConnection)
			throw new Error('Extension not connected. Make sure the Earthling Browser Bridge extension is active.');
		const result = await relay.extensionConnection.send('openTab', { url: params.url });
		response.addTextResult(`Opened tab ${result.tabId}. Use browser_switch_tab to interact with it.`);
	},
});

const closeTab = defineTool({
	capability: 'core',
	schema: {
		name: 'browser_close_tab',
		title: 'Close a browser tab',
		description: 'Close a browser tab by tab ID (from browser_list_all_tabs).',
		inputSchema: z.object({
			tabId: z.number().describe('Tab ID to close'),
		}),
		type: 'action',
	},
	handle: async (context, params, response) => {
		const relay = getRelay();
		if (!relay?.extensionConnection)
			throw new Error('Extension not connected. Make sure the Earthling Browser Bridge extension is active.');
		await relay.extensionConnection.send('closeTab', { tabId: params.tabId });
		response.addTextResult(`Closed tab ${params.tabId}.`);
	},
});

const earthlingTabs: Tool<any>[] = [listAllTabs, switchTab, openTab, closeTab];
export default earthlingTabs;
