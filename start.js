#!/usr/bin/env node

/**
 * Earthling Playwright MCP Wrapper
 *
 * Patches the official @playwright/mcp to use our custom
 * Earthling Browser Bridge extension instead of the official
 * Playwright MCP Bridge extension, and injects custom MCP tools
 * for agent-driven tab control.
 */

const Module = require('module');
const path = require('path');

const EARTHLING_EXTENSION_ID = 'ifoggnihepkfpokholefpgpcgiikkeke';
const OFFICIAL_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

// --- cdpRelay.js patches ---

// Marker: inject custom command handlers before the default _forwardToExtension call
const CDP_RELAY_MARKER = 'return await this._forwardToExtension(method, params, sessionId)';
const CDP_RELAY_INJECTION = `
    // Earthling custom commands — forwarded directly to extension (not as forwardCDPCommand)
    if (method === "Earthling.listBrowserTabs")
      return await this._extensionConnection.send("listBrowserTabs", params || {});
    if (method === "Earthling.switchToTab") {
      const switchResult = await this._extensionConnection.send("switchToTab", params);
      if (this._connectedTabInfo)
        this._connectedTabInfo.targetInfo = switchResult.targetInfo;
      return switchResult;
    }
    return await this._forwardToExtension(method, params, sessionId)`;

// Marker: inject tabSwitched handler before forwardCDPEvent case
// Updates relay state when the extension switches tabs (agent or hot-swap).
// The tool handler closes the browser context after switching, so no synthetic
// CDP events are needed — the next tool call reconnects via connectOverCDP.
const EXT_MSG_MARKER = `case "forwardCDPEvent":`;
const EXT_MSG_INJECTION = `case "tabSwitched":
        if (this._connectedTabInfo)
          this._connectedTabInfo.targetInfo = params.targetInfo;
        break;
      case "forwardCDPEvent":`;

// Marker: store relay instance globally and wrap _closeExtensionConnection
// so the tool handler can suppress extension disconnection during tab switch
const RELAY_CONSTRUCTOR_MARKER = `this._wss.on("connection", this._onConnection.bind(this));`;
const RELAY_CONSTRUCTOR_INJECTION = `this._wss.on("connection", this._onConnection.bind(this));
    global.__earthlingRelay = this;
    this.__skipExtensionClose = false;
    var _origCloseExt = this._closeExtensionConnection.bind(this);
    this._closeExtensionConnection = function(reason) {
      if (this.__skipExtensionClose) return;
      _origCloseExt(reason);
    }.bind(this);`;

// --- tools.js patch ---

const TOOLS_INJECTION = `
;(function() {
  var _ez = require("playwright-core/lib/mcpBundle").z;
  var _defineTool = require("./tools/tool").defineTool;

  browserTools.push(_defineTool({
    capability: "core",
    schema: {
      name: "browser_list_all_tabs",
      title: "List all browser tabs",
      description: "List ALL open browser tabs (not just Playwright-managed ones). Returns tab IDs, titles, URLs, and flags (connected, highlighted, active). Use to discover available tabs before switching.",
      inputSchema: _ez.object({}),
      type: "readOnly"
    },
    handle: async function(context, params, response) {
      await context.ensureTab();
      var relay = global.__earthlingRelay;
      if (!relay || !relay._extensionConnection)
        throw new Error("Extension not connected. Make sure the Earthling Browser Bridge extension is active.");
      var tabs = await relay._extensionConnection.send("listBrowserTabs", {});
      var lines = ["### All Browser Tabs"];
      for (var t of tabs) {
        var flags = [];
        if (t.connected) flags.push("CONNECTED");
        if (t.highlighted) flags.push("HIGHLIGHTED");
        if (t.active) flags.push("active");
        var f = flags.length ? " [" + flags.join(", ") + "]" : "";
        lines.push("- tabId=" + t.tabId + f + ": [" + t.title + "](" + t.url + ")");
      }
      response.addTextResult(lines.join("\\n"));
    }
  }));

  browserTools.push(_defineTool({
    capability: "core",
    schema: {
      name: "browser_switch_tab",
      title: "Switch to browser tab",
      description: "Switch the browser connection to a different tab by tab ID (from browser_list_all_tabs). Detaches current debugger, attaches to the new tab. Call browser_snapshot after switching to see the page content.",
      inputSchema: _ez.object({
        tabId: _ez.number().describe("Tab ID from browser_list_all_tabs")
      }),
      type: "action"
    },
    handle: async function(context, params, response) {
      await context.ensureTab();
      var relay = global.__earthlingRelay;
      if (!relay || !relay._extensionConnection)
        throw new Error("Extension not connected. Make sure the Earthling Browser Bridge extension is active.");

      // Switch the debugger to the new tab at the extension level
      await relay._extensionConnection.send("switchToTab", { tabId: params.tabId });

      // Close the stale Playwright browser context so the next tool call
      // gets a fresh Page for the new tab. Suppress extension disconnection
      // so the relay keeps the extension WebSocket alive during the reconnect.
      relay.__skipExtensionClose = true;
      try { await context.closeBrowserContext(); } catch(e) {}
      relay.__skipExtensionClose = false;

      response.addTextResult("Switched to tab " + params.tabId + ". Use browser_snapshot to see the page content.");
    }
  }));
})();
`;

// --- Module._compile hook ---

const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
	const normalized = filename.replace(/\\/g, '/');

	// Patch 1: cdpRelay.js — extension ID + env var rename + custom command handlers + global relay ref
	if (normalized.includes('cdpRelay')) {
		if (!content.includes(OFFICIAL_EXTENSION_ID))
			console.warn('[Earthling] WARNING: Extension ID not found in cdpRelay.js');
		content = content.replaceAll(OFFICIAL_EXTENSION_ID, EARTHLING_EXTENSION_ID);
		// Rename env var: PLAYWRIGHT_MCP_EXTENSION_TOKEN → BROWSER_AUTOMATION_MCP_EXTENSION_TOKEN
		content = content.replaceAll('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'BROWSER_AUTOMATION_MCP_EXTENSION_TOKEN');
		if (!content.includes(CDP_RELAY_MARKER))
			console.warn('[Earthling] WARNING: patch failed — CDP_RELAY_MARKER not found in cdpRelay.js');
		content = content.replace(CDP_RELAY_MARKER, CDP_RELAY_INJECTION);
		if (!content.includes(EXT_MSG_MARKER))
			console.warn('[Earthling] WARNING: patch failed — EXT_MSG_MARKER not found in cdpRelay.js');
		content = content.replace(EXT_MSG_MARKER, EXT_MSG_INJECTION);
		if (!content.includes(RELAY_CONSTRUCTOR_MARKER))
			console.warn('[Earthling] WARNING: patch failed — RELAY_CONSTRUCTOR_MARKER not found in cdpRelay.js');
		content = content.replace(RELAY_CONSTRUCTOR_MARKER, RELAY_CONSTRUCTOR_INJECTION);
	}

	// Patch 2: extensionContextFactory.js — cache relay for reuse after tab switch
	if (normalized.includes('extensionContextFactory')) {
		if (!content.includes('async _startRelay(abortSignal) {'))
			console.warn('[Earthling] WARNING: patch failed — _startRelay marker not found in extensionContextFactory.js');
		content = content.replace(
			'async _startRelay(abortSignal) {',
			`async _startRelay(abortSignal) {
      if (global.__earthlingRelay) return global.__earthlingRelay;`
		);
	}

	// Patch 3: tools.js — custom MCP tools
	if (normalized.endsWith('mcp/browser/tools.js')) {
		content += TOOLS_INJECTION;
	}

	return originalCompile.call(this, content, filename);
};

// In the fork, the CLI lives at packages/playwright-mcp/cli.js (no node_modules indirection)
require(path.join(__dirname, 'packages', 'playwright-mcp', 'cli.js'));
