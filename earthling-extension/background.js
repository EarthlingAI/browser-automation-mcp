function debugLog(...args) {
	console.log("[Earthling]", ...args);
}

// Module-level bridge reference for RelayConnection access
let bridge;

class RelayConnection {
	constructor(ws) {
		this._debuggee = {};
		this._ws = ws;
		this._closed = false;
		this.onclose = null;
		this._tabPromise = new Promise((resolve) => this._tabPromiseResolve = resolve);
		this._ws.onmessage = this._onMessage.bind(this);
		this._ws.onclose = () => this._onClose();
		this._eventListener = this._onDebuggerEvent.bind(this);
		this._detachListener = this._onDebuggerDetach.bind(this);
		chrome.debugger.onEvent.addListener(this._eventListener);
		chrome.debugger.onDetach.addListener(this._detachListener);
	}

	setTabId(tabId) {
		this._debuggee = { tabId };
		this._tabPromiseResolve();
	}

	close(message) {
		this._ws.close(1000, message);
		this._onClose();
	}

	_onClose() {
		if (this._closed)
			return;
		this._closed = true;
		chrome.debugger.onEvent.removeListener(this._eventListener);
		chrome.debugger.onDetach.removeListener(this._detachListener);
		chrome.debugger.detach(this._debuggee).catch(() => {});
		this.onclose?.();
	}

	_onDebuggerEvent(source, method, params) {
		if (source.tabId !== this._debuggee.tabId)
			return;
		debugLog("Forwarding CDP event:", method, params);
		this._sendMessage({
			method: "forwardCDPEvent",
			params: { sessionId: source.sessionId, method, params }
		});
	}

	_onDebuggerDetach(source, reason) {
		if (source.tabId !== this._debuggee.tabId)
			return;
		this.close(`Debugger detached: ${reason}`);
		this._debuggee = {};
	}

	_onMessage(event) {
		this._onMessageAsync(event).catch((e) => debugLog("Error handling message:", e));
	}

	async _onMessageAsync(event) {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch (error) {
			debugLog("Error parsing message:", error);
			this._sendError(-32700, `Error parsing message: ${error.message}`);
			return;
		}
		debugLog("Received message:", message);
		const response = { id: message.id };
		try {
			response.result = await this._handleCommand(message);
		} catch (error) {
			debugLog("Error handling command:", error);
			response.error = error.message;
		}
		debugLog("Sending response:", response);
		this._sendMessage(response);
	}

	async _handleCommand(message) {
		if (message.method === "attachToTab") {
			await this._tabPromise;
			debugLog("Attaching debugger to tab:", this._debuggee);
			try {
				await chrome.debugger.attach(this._debuggee, "1.3");
			} catch (e) {
				// Already attached (e.g. after a tab switch) — continue
				debugLog("Debugger attach skipped (already attached):", e.message);
			}
			const result = await chrome.debugger.sendCommand(this._debuggee, "Target.getTargetInfo");
			return { targetInfo: result?.targetInfo };
		}

		if (message.method === "listBrowserTabs") {
			const tabs = await chrome.tabs.query({});
			const blocklist = await getBlocklist();
			const filtered = tabs.filter(tab =>
				tab.url && !["chrome:", "edge:", "devtools:"].some(s => tab.url.startsWith(s))
				&& !blocklist.includes(tab.id)
			);
			return filtered.map(tab => ({
				tabId: tab.id,
				title: tab.title || "",
				url: tab.url || "",
				windowId: tab.windowId,
				active: tab.active,
				highlighted: tab.id === bridge._preSelectedTabId,
				connected: tab.id === bridge._connectedTabId
			}));
		}

		if (message.method === "switchToTab") {
			const newTabId = message.params.tabId;
			// Detach from current tab
			await chrome.debugger.detach(this._debuggee).catch(() => {});
			// Attach to new tab
			this._debuggee = { tabId: newTabId };
			await chrome.debugger.attach(this._debuggee, "1.3");
			const result = await chrome.debugger.sendCommand(this._debuggee, "Target.getTargetInfo");
			// Update bridge state
			await bridge._setConnectedTabId(newTabId);
			// Notify relay that tab switched
			this._sendMessage({
				method: "tabSwitched",
				params: { tabId: newTabId, targetInfo: result?.targetInfo }
			});
			return { targetInfo: result?.targetInfo };
		}

		if (!this._debuggee.tabId)
			throw new Error("No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.");
		if (message.method === "forwardCDPCommand") {
			const { sessionId, method, params } = message.params;
			debugLog("CDP command:", method, params);
			const debuggerSession = { ...this._debuggee, sessionId };
			return await chrome.debugger.sendCommand(debuggerSession, method, params);
		}
	}

	_sendError(code, message) {
		this._sendMessage({ error: { code, message } });
	}

	_sendMessage(message) {
		if (this._ws.readyState === WebSocket.OPEN)
			this._ws.send(JSON.stringify(message));
	}
}

// Blocklist helpers (module-level for shared access)
async function getBlocklist() {
	const result = await chrome.storage.local.get("blocklist");
	return result.blocklist || [];
}

class EarthlingBrowserBridge {
	constructor() {
		this._activeConnection = undefined;
		this._connectedTabId = null;
		this._preSelectedTabId = null;
		this._pendingTabSelection = new Map();

		// Restore persisted state (survives service worker restarts in MV3)
		// Store the promise so interception handlers can await it after wake
		this._stateReady = this._restoreState();

		chrome.tabs.onCreated.addListener(this._onTabCreated.bind(this));
		chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
		chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
		chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
		chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
		chrome.action.onClicked.addListener(this._onActionClicked.bind(this));

		// Context menu setup — create on every service worker start (not just onInstalled)
		this._createContextMenus();
		chrome.contextMenus.onClicked.addListener(this._onContextMenuClicked.bind(this));
	}

	_onTabCreated(tab) {
		const url = tab.pendingUrl || tab.url;
		if (!url) return;
		const connectUrl = chrome.runtime.getURL("connect.html");
		if (!url.startsWith(connectUrl)) return;

		this._handleConnectPageCreated(tab, url);
	}

	async _handleConnectPageCreated(tab, url) {
		await this._stateReady;

		let parsedUrl;
		try {
			parsedUrl = new URL(url);
		} catch (_) {
			return; // Malformed URL — let the page handle it
		}
		const mcpRelayUrl = parsedUrl.searchParams.get("mcpRelayUrl");
		if (!mcpRelayUrl) return; // Let the page load and show its error

		// Validate loopback
		try {
			const relayHost = new URL(mcpRelayUrl).hostname;
			if (!["127.0.0.1", "[::1]", "::1", "localhost"].includes(relayHost))
				return; // Let the page handle the error
		} catch (_) {
			return;
		}

		// AUTO-CONNECT PATH: pre-selected tab exists — bypass connect page entirely
		if (this._preSelectedTabId) {
			try {
				const preTab = await chrome.tabs.get(this._preSelectedTabId);

				// Establish WebSocket to relay
				await this._connectToRelay(tab.id, mcpRelayUrl);

				// Connect to the pre-selected tab
				await this._connectTab(tab.id, preTab.id, preTab.windowId, mcpRelayUrl);

				// Close the connect page tab before it renders
				await chrome.tabs.remove(tab.id);
				debugLog("Auto-connected to pre-selected tab, connect page bypassed");
				return;
			} catch (error) {
				// Pre-selected tab gone or connection failed — fall through to manual
				debugLog("Auto-connect failed, falling through to manual:", error.message);
			}
		}

		// MANUAL SELECTION PATH: close any existing connect page tabs (dedup)
		const connectUrl2 = chrome.runtime.getURL("connect.html");
		const existingTabs = await chrome.tabs.query({});
		for (const t of existingTabs) {
			if (t.id !== tab.id && t.url?.startsWith(connectUrl2))
				chrome.tabs.remove(t.id).catch(() => {});
		}
	}

	async _restoreState() {
		try {
			const result = await chrome.storage.local.get("bridgeState");
			const state = result.bridgeState;
			if (!state) return;

			// Restore pre-selected tab (verify it still exists)
			if (state.preSelectedTabId) {
				try {
					await chrome.tabs.get(state.preSelectedTabId);
					this._preSelectedTabId = state.preSelectedTabId;
					debugLog("Restored pre-selected tab:", this._preSelectedTabId);
				} catch (_) {
					// Tab no longer exists
				}
			}

			// Note: _connectedTabId is NOT restored because the WebSocket/debugger
			// connections don't survive service worker restart. Clear stale state.
			if (state.connectedTabId) {
				await chrome.storage.local.set({
					bridgeState: { ...state, connectedTabId: null }
				});
			}
		} catch (error) {
			debugLog("Failed to restore state:", error);
		}
	}

	async _persistState() {
		try {
			await chrome.storage.local.set({
				bridgeState: {
					preSelectedTabId: this._preSelectedTabId,
					connectedTabId: this._connectedTabId
				}
			});
		} catch (error) {
			debugLog("Failed to persist state:", error);
		}
	}

	_onMessage(message, sender, sendResponse) {
		switch (message.type) {
			case "connectToMCPRelay":
				this._connectToRelay(sender.tab.id, message.mcpRelayUrl).then(
					() => sendResponse({ success: true }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
			case "getTabs":
				this._getTabs().then(
					(tabs) => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
			case "connectToTab": {
				const tabId = message.tabId || sender.tab?.id;
				const windowId = message.windowId || sender.tab?.windowId;
				this._connectTab(sender.tab.id, tabId, windowId, message.mcpRelayUrl).then(
					() => sendResponse({ success: true }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
			}
			case "getConnectionStatus":
				sendResponse({
					connectedTabId: this._connectedTabId,
					preSelectedTabId: this._preSelectedTabId
				});
				return false;
			case "disconnect":
				this._disconnect().then(
					() => sendResponse({ success: true }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
			case "getBlocklist":
				getBlocklist().then(
					(blocklist) => sendResponse({ success: true, blocklist }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
			case "blockTab":
				this._blockTab(message.tabId).then(
					() => sendResponse({ success: true }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
			case "unblockTab":
				this._unblockTab(message.tabId).then(
					() => sendResponse({ success: true }),
					(error) => sendResponse({ success: false, error: error.message })
				);
				return true;
		}
		return false;
	}

	async _onActionClicked(tab) {
		if (!tab?.id || tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://"))
			return;

		const blocklist = await getBlocklist();
		if (blocklist.includes(tab.id))
			return;

		// Case 1: Connected to THIS tab → disconnect
		if (this._connectedTabId === tab.id) {
			await this._disconnect();
			debugLog("Disconnected tab via icon click:", tab.id);
			return;
		}

		// Case 2: Connected to ANOTHER tab → hot-swap
		if (this._connectedTabId && this._activeConnection) {
			await this._hotSwapTab(tab.id);
			return;
		}

		// Case 3: Pre-selected THIS tab → deselect
		if (this._preSelectedTabId === tab.id) {
			this._preSelectedTabId = null;
			await this._updateBadge(tab.id, { text: "" });
			await this._persistState();
			debugLog("Deselected tab:", tab.id);
			return;
		}

		// Case 4: Nothing connected → pre-select
		if (this._preSelectedTabId)
			await this._updateBadge(this._preSelectedTabId, { text: "" });

		this._preSelectedTabId = tab.id;
		await this._updateBadge(tab.id, {
			text: "\u25CF", color: "#2196F3",
			title: "Tab pre-selected for Earthling agent"
		});
		await this._persistState();
		debugLog("Pre-selected tab:", tab.id);
	}

	async _hotSwapTab(newTabId) {
		if (!this._activeConnection)
			return;
		try {
			const conn = this._activeConnection;

			// Detach old
			await chrome.debugger.detach(conn._debuggee).catch(() => {});

			// Attach new
			conn._debuggee = { tabId: newTabId };
			await chrome.debugger.attach(conn._debuggee, "1.3");
			const result = await chrome.debugger.sendCommand(conn._debuggee, "Target.getTargetInfo");

			// Update bridge state
			await this._setConnectedTabId(newTabId);

			// Notify relay about the switch
			conn._sendMessage({
				method: "tabSwitched",
				params: { tabId: newTabId, targetInfo: result?.targetInfo }
			});
			debugLog("Hot-swapped to tab:", newTabId);
		} catch (error) {
			debugLog("Hot-swap failed:", error);
			await this._disconnect();
		}
	}

	async _onContextMenuClicked(info, tab) {
		if (!tab?.id) return;
		if (info.menuItemId === "earthling-block-tab") {
			await this._blockTab(tab.id);
			await this._updateBadge(tab.id, { text: "\u2715", color: "#F44336", title: "Blocked from Earthling agent" });
			if (this._connectedTabId === tab.id)
				await this._disconnect();
			if (this._preSelectedTabId === tab.id) {
				this._preSelectedTabId = null;
				await this._persistState();
			}
		} else if (info.menuItemId === "earthling-unblock-tab") {
			await this._unblockTab(tab.id);
			await this._updateBadge(tab.id, { text: "" });
		}
	}

	_createContextMenus() {
		chrome.contextMenus.removeAll(() => {
			chrome.contextMenus.create({
				id: "earthling-block-tab",
				title: "Block this tab from Earthling agent",
				contexts: ["action"]
			});
			chrome.contextMenus.create({
				id: "earthling-unblock-tab",
				title: "Unblock this tab",
				contexts: ["action"],
				visible: false
			});
		});
	}

	async _updateContextMenu(tabId) {
		try {
			const blocklist = await getBlocklist();
			const isBlocked = blocklist.includes(tabId);
			chrome.contextMenus.update("earthling-block-tab", { visible: !isBlocked });
			chrome.contextMenus.update("earthling-unblock-tab", { visible: isBlocked });
		} catch (error) {
			// Menu items may not exist yet if service worker just started
		}
	}

	async _blockTab(tabId) {
		const blocklist = await getBlocklist();
		if (!blocklist.includes(tabId)) {
			blocklist.push(tabId);
			await chrome.storage.local.set({ blocklist });
		}
	}

	async _unblockTab(tabId) {
		let blocklist = await getBlocklist();
		blocklist = blocklist.filter(id => id !== tabId);
		await chrome.storage.local.set({ blocklist });
	}

	async _connectToRelay(selectorTabId, mcpRelayUrl) {
		try {
			debugLog(`Connecting to relay at ${mcpRelayUrl}`);
			const socket = new WebSocket(mcpRelayUrl);
			await new Promise((resolve, reject) => {
				socket.onopen = () => resolve();
				socket.onerror = () => reject(new Error("WebSocket error"));
				setTimeout(() => reject(new Error("Connection timeout")), 5000);
			});
			const connection = new RelayConnection(socket);
			connection.onclose = () => {
				debugLog("Pending connection closed");
				this._pendingTabSelection.delete(selectorTabId);
			};
			this._pendingTabSelection.set(selectorTabId, { connection });
			debugLog("Connected to MCP relay");
		} catch (error) {
			const message = `Failed to connect to MCP relay: ${error.message}`;
			debugLog(message);
			throw new Error(message);
		}
	}

	async _connectTab(selectorTabId, tabId, windowId, mcpRelayUrl) {
		try {
			debugLog(`Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);
			try {
				this._activeConnection?.close("Another connection is requested");
			} catch (error) {
				debugLog("Error closing active connection:", error);
			}
			await this._setConnectedTabId(null);
			this._activeConnection = this._pendingTabSelection.get(selectorTabId)?.connection;
			if (!this._activeConnection)
				throw new Error("No active MCP relay connection");
			this._pendingTabSelection.delete(selectorTabId);
			this._activeConnection.setTabId(tabId);
			this._activeConnection.onclose = () => {
				debugLog("MCP connection closed");
				this._activeConnection = undefined;
				void this._setConnectedTabId(null);
			};
			if (this._preSelectedTabId === tabId)
				this._preSelectedTabId = null;
			await Promise.all([
				this._setConnectedTabId(tabId),  // also persists state
				chrome.tabs.update(tabId, { active: true }),
				chrome.windows.update(windowId, { focused: true })
			]);
			debugLog("Connected to MCP bridge");
		} catch (error) {
			await this._setConnectedTabId(null);
			debugLog(`Failed to connect tab ${tabId}:`, error.message);
			throw error;
		}
	}

	async _setConnectedTabId(tabId) {
		const oldTabId = this._connectedTabId;
		this._connectedTabId = tabId;
		if (oldTabId && oldTabId !== tabId)
			await this._updateBadge(oldTabId, { text: "" });
		if (tabId)
			await this._updateBadge(tabId, { text: "\u2713", color: "#4CAF50", title: "Connected to MCP client" });
		await this._persistState();
		this._broadcastStatusChange();
	}

	_broadcastStatusChange() {
		chrome.runtime.sendMessage({ type: "connectionStatusChanged" }).catch(() => {});
	}

	async _updateBadge(tabId, { text, color, title }) {
		try {
			await chrome.action.setBadgeText({ tabId, text });
			await chrome.action.setTitle({ tabId, title: title || "" });
			if (color)
				await chrome.action.setBadgeBackgroundColor({ tabId, color });
		} catch (error) {}
	}

	async _onTabRemoved(tabId) {
		// Clean up stale blocked tab IDs (always, regardless of connection state)
		getBlocklist().then(blocklist => {
			if (blocklist.includes(tabId))
				this._unblockTab(tabId);
		});

		const pendingConnection = this._pendingTabSelection.get(tabId)?.connection;
		if (pendingConnection) {
			this._pendingTabSelection.delete(tabId);
			pendingConnection.close("Browser tab closed");
			return;
		}
		if (this._preSelectedTabId === tabId) {
			this._preSelectedTabId = null;
			this._persistState();
		}
		if (this._connectedTabId !== tabId)
			return;
		this._activeConnection?.close("Browser tab closed");
		this._activeConnection = undefined;
		this._connectedTabId = null;
	}

	_onTabActivated(activeInfo) {
		// Update context menu visibility for the active tab
		this._updateContextMenu(activeInfo.tabId);

		for (const [tabId, pending] of this._pendingTabSelection) {
			if (tabId === activeInfo.tabId) {
				if (pending.timerId) {
					clearTimeout(pending.timerId);
					pending.timerId = undefined;
				}
				continue;
			}
			if (!pending.timerId) {
				pending.timerId = setTimeout(() => {
					const existed = this._pendingTabSelection.delete(tabId);
					if (existed) {
						pending.connection.close("Tab has been inactive for 5 seconds");
						chrome.tabs.sendMessage(tabId, { type: "connectionTimeout" });
					}
				}, 5000);
				return;
			}
		}
	}

	_onTabUpdated(tabId, changeInfo, tab) {
		if (this._connectedTabId === tabId)
			void this._setConnectedTabId(tabId);
		if (this._preSelectedTabId === tabId && changeInfo.status === "complete")
			void this._updateBadge(tabId, {
				text: "\u25CF", color: "#2196F3",
				title: "Tab pre-selected for Earthling agent"
			});
	}

	async _getTabs() {
		const [tabs, blocklist] = await Promise.all([
			chrome.tabs.query({}),
			getBlocklist()
		]);
		return tabs.filter(tab =>
			tab.url && !["chrome:", "edge:", "devtools:"].some(scheme => tab.url.startsWith(scheme))
			&& !blocklist.includes(tab.id)
		);
	}

	async _disconnect() {
		this._activeConnection?.close("User disconnected");
		this._activeConnection = undefined;
		await this._setConnectedTabId(null);
	}
}

bridge = new EarthlingBrowserBridge();
