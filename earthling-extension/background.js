// Debug ring buffer — queryable via Earthling.getDebugLog pseudo-CDP command.
const DEBUG_LOG_MAX = 200;
const _debugRingBuffer = [];

function debugLog(...args) {
	const entry = { ts: Date.now(), msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
	_debugRingBuffer.push(entry);
	if (_debugRingBuffer.length > DEBUG_LOG_MAX)
		_debugRingBuffer.shift();
	console.log("[Earthling]", ...args);
}

// Module-level bridge reference for RelayConnection access
let bridge;

class RelayConnection {
	constructor(ws, tabId) {
		this._ws = ws;
		this._closed = false;
		this.onclose = null;
		// Multi-tab: track all debugger-attached tabs. Chrome supports
		// simultaneous chrome.debugger.attach() to multiple tabs.
		// Entries are ONLY added after chrome.debugger.attach() succeeds.
		this._debuggees = new Map(); // tabId -> { tabId }
		// _initialTabId records which tab the relay expects us to debug
		// first — resolved by _tabPromise, consumed by attachToTab.
		this._initialTabId = tabId || null;
		if (tabId) {
			this._tabPromise = Promise.resolve();
			this._tabPromiseResolve = () => {};
		} else {
			this._tabPromise = new Promise((resolve) => this._tabPromiseResolve = resolve);
		}
		this._ws.onmessage = this._onMessage.bind(this);
		this._ws.onclose = () => this._onClose();
		this._eventListener = this._onDebuggerEvent.bind(this);
		this._detachListener = this._onDebuggerDetach.bind(this);
		chrome.debugger.onEvent.addListener(this._eventListener);
		chrome.debugger.onDetach.addListener(this._detachListener);
	}

	setTabId(tabId) {
		this._initialTabId = tabId;
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
		for (const debuggee of this._debuggees.values())
			chrome.debugger.detach(debuggee).catch(() => {});
		this._debuggees.clear();
		this.onclose?.();
	}

	_onDebuggerEvent(source, method, params) {
		if (!this._debuggees.has(source.tabId))
			return;
		this._sendMessage({
			method: "forwardCDPEvent",
			params: { sessionId: source.sessionId, tabId: source.tabId, method, params }
		});
	}

	_onDebuggerDetach(source, reason) {
		if (!this._debuggees.has(source.tabId))
			return;
		this._debuggees.delete(source.tabId);
		// Notify the daemon that this specific tab lost its debugger.
		// Don't close the WebSocket — other tabs may still be attached.
		this._sendMessage({
			method: "tabDetached",
			params: { tabId: source.tabId, reason }
		});
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
			const tabId = message.params.tabId;
			const debuggee = { tabId };
			debugLog("Attaching debugger to tab:", tabId);
			if (!this._debuggees.has(tabId)) {
				try {
					await chrome.debugger.attach(debuggee, "1.3");
				} catch (e) {
					if (!e.message?.includes("Already attached"))
						throw e;
					debugLog("Debugger attach skipped (already attached):", e.message);
				}
				this._debuggees.set(tabId, debuggee);
			}
			const result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
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
			const debuggee = { tabId: newTabId };
			// Multi-tab: attach to the new tab without detaching old ones.
			// Each tab keeps its debugger attachment independently.
			if (!this._debuggees.has(newTabId)) {
				try {
					await chrome.debugger.attach(debuggee, "1.3");
				} catch (e) {
					if (!e.message?.includes("Already attached"))
						throw e;
					debugLog("Debugger attach skipped (already attached):", e.message);
				}
				this._debuggees.set(newTabId, debuggee);
			}
			const result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
			await bridge._setConnectedTabId(newTabId);
			this._sendMessage({
				method: "tabSwitched",
				params: { tabId: newTabId, targetInfo: result?.targetInfo }
			});
			return { targetInfo: result?.targetInfo };
		}

		if (message.method === "detachFromTab") {
			const tabId = message.params.tabId;
			const debuggee = this._debuggees.get(tabId);
			if (debuggee) {
				this._debuggees.delete(tabId);
				await chrome.debugger.detach(debuggee).catch(() => {});
			}
			return { detached: !!debuggee };
		}

		if (message.method === "openTab") {
			const tab = await chrome.tabs.create({ url: message.params.url || "about:blank" });
			return { tabId: tab.id, title: tab.title, url: tab.url };
		}

		if (message.method === "closeTab") {
			const closingTabId = message.params.tabId;
			// Remove from debuggees BEFORE chrome.tabs.remove() to prevent
			// _onDebuggerDetach from firing tabDetached for an expected close.
			this._debuggees.delete(closingTabId);
			// Clear bridge state to prevent _onTabRemoved from closing the ws.
			if (bridge._connectedTabId === closingTabId)
				await bridge._setConnectedTabId(null);
			await chrome.tabs.remove(closingTabId);
			return {};
		}

		if (message.method === "getDebugLog") {
			return [..._debugRingBuffer];
		}

		if (message.method === "forwardCDPCommand") {
			const { tabId, sessionId, method, params } = message.params;
			const debuggee = tabId ? this._debuggees.get(tabId) : null;
			if (!debuggee)
				throw new Error(tabId ? `No debugger attached to tab ${tabId}` : "No tabId provided in forwardCDPCommand");
			const debuggerSession = { ...debuggee, sessionId };
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
		this._autoConnectActive = false;
		// Debounce state: tracks when the connection was lost to avoid
		// unnecessary auto-reconnect during dispose→reconnect cycles (~2-5s).
		this._connectionLostAt = null;
		this._badgeClearTimer = null;

		// Restore persisted state (survives service worker restarts in MV3)
		// Store the promise so interception handlers can await it after wake
		this._stateReady = this._restoreState();
		// Auto-connect is triggered by connect.html?autoConnect=true from the relay.
		// Background auto-connect (polling) is deferred — only starts after first successful connection
		// to avoid conflicting with the connect.html flow.

		chrome.tabs.onCreated.addListener(this._onTabCreated.bind(this));
		chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
		chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
		chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
		chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
		chrome.action.onClicked.addListener(this._onActionClicked.bind(this));

		chrome.alarms.onAlarm.addListener((alarm) => {
			if (alarm.name === "autoConnectRetry" || alarm.name === "keepAlive") {
				if (!this._activeConnection) {
					if (!this._connectionLostAt)
						this._connectionLostAt = Date.now();
					// Only auto-reconnect after 10s of no connection.
					// Dispose→reconnect cycles complete in ~2-5s.
					if (Date.now() - this._connectionLostAt > 10_000) {
						debugLog("keepAlive: connection lost >10s, starting auto-connect");
						this._startAutoConnect();
					}
				} else {
					this._connectionLostAt = null;
				}
			}
		});

		// Persistent SW-wake alarm so we reconnect even if the ws silently dies
		// while the SW is asleep. Min allowed period is 0.5 min = 30s.
		chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 });

		chrome.storage.onChanged.addListener((changes, area) => {
			if (area === "local" && changes.relayConfig)
				this._startAutoConnect();
		});

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

		const autoConnect = parsedUrl.searchParams.get("autoConnect") === "true";

		// When autoConnect=true and no tab is pre-selected, auto-select the best tab.
		// Retry with delay because Chrome session restore can take several seconds
		// after a fresh launch — tabs may not exist yet.
		if (autoConnect && !this._preSelectedTabId) {
			let bestTab = null;
			for (let attempt = 0; attempt < 5 && !bestTab; attempt++) {
				if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
				const allTabs = await chrome.tabs.query({});
				bestTab = allTabs.find(t =>
					t.id !== tab.id && t.url &&
					!t.url.startsWith("chrome://") && !t.url.startsWith("edge://") &&
					!t.url.startsWith("chrome-extension://") && t.url !== "about:blank"
				) || allTabs.find(t =>
					t.id !== tab.id && t.url &&
					!t.url.startsWith("chrome://") && !t.url.startsWith("edge://") &&
					!t.url.startsWith("chrome-extension://")
				);
				if (!bestTab && attempt === 0)
					debugLog("No suitable tabs yet, waiting for Chrome session restore...");
			}
			// If still no tabs after retrying (e.g. fresh Chrome, "Restore pages?" dialog
			// blocking), create a new blank tab so the agent has something to work with.
			if (!bestTab) {
				debugLog("No suitable tabs found — creating a new tab for auto-connect");
				bestTab = await chrome.tabs.create({ url: "about:blank", active: false });
			}
			if (bestTab) {
				this._preSelectedTabId = bestTab.id;
				debugLog("Auto-selected tab for connect:", bestTab.id, bestTab.title || bestTab.url);
			}
			// Fall through to the pre-selected tab auto-connect below
		}

		// AUTO-CONNECT PATH: pick a tab automatically — bypass connect page entirely
		if (autoConnect || this._preSelectedTabId) {
			try {
				let targetTab;
				if (this._preSelectedTabId) {
					targetTab = await chrome.tabs.get(this._preSelectedTabId);
				} else {
					// Pick the first non-chrome, non-extension active tab
					const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
					targetTab = allTabs.find(t =>
						t.id !== tab.id && t.url &&
						!t.url.startsWith("chrome://") && !t.url.startsWith("edge://") &&
						!t.url.startsWith("chrome-extension://")
					);
					// Fallback: any non-chrome tab
					if (!targetTab) {
						const allNonChrome = await chrome.tabs.query({});
						targetTab = allNonChrome.find(t =>
							t.id !== tab.id && t.url &&
							!t.url.startsWith("chrome://") && !t.url.startsWith("edge://") &&
							!t.url.startsWith("chrome-extension://")
						);
					}
				}
				if (!targetTab) throw new Error("No suitable tab found for auto-connect");

				// Pass targetTabId to _connectToRelay so the RelayConnection is
				// created with the tab ID already set — avoids race with attachToTab
				await this._connectToRelay(tab.id, mcpRelayUrl, targetTab.id);

				// Connect to the target tab (sets up lifecycle handlers, badges, etc.)
				// activateTab=true: user-initiated connection, bring tab to focus.
				await this._connectTab(tab.id, targetTab.id, targetTab.windowId, mcpRelayUrl, true);

				// Close the connect page tab before it renders
				await chrome.tabs.remove(tab.id);
				debugLog("Auto-connected to tab:", targetTab.id, targetTab.title || targetTab.url);
				return;
			} catch (error) {
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

		// Case 2: Connected to ANOTHER tab → send hint to agent
		if (this._connectedTabId && this._activeConnection) {
			this._activeConnection._sendMessage({
				method: "userSelectedTab",
				params: { tabId: tab.id, title: tab.title || "", url: tab.url || "" }
			});
			await this._updateBadge(tab.id, { text: "\u25CF", color: "#2196F3", title: "Hinted to Earthling agent" });
			setTimeout(() => this._updateBadge(tab.id, { text: "" }).catch(() => {}), 3000);
			debugLog("Sent tab hint to agent:", tab.id);
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
			const debuggee = { tabId: newTabId };

			// Multi-tab: attach to new tab without detaching old ones
			if (!conn._debuggees.has(newTabId)) {
				try {
					await chrome.debugger.attach(debuggee, "1.3");
				} catch (e) {
					if (!e.message?.includes("Already attached"))
						throw e;
				}
				conn._debuggees.set(newTabId, debuggee);
			}
			const result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");

			await this._setConnectedTabId(newTabId);
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

	async _connectToRelay(selectorTabId, mcpRelayUrl, targetTabId) {
		// Guard: prevent dual-connect race between _handleConnectPageCreated and connect.js
		if (this._pendingTabSelection.has(selectorTabId)) {
			debugLog("Pending connection already exists for selector", selectorTabId, "— reusing");
			return;
		}
		if (this._activeConnection) {
			debugLog("Already connected to relay — skipping");
			return;
		}
		try {
			debugLog(`Connecting to relay at ${mcpRelayUrl}`, targetTabId ? `(target tab: ${targetTabId})` : "");
			const socket = new WebSocket(mcpRelayUrl);
			await new Promise((resolve, reject) => {
				socket.onopen = () => resolve();
				socket.onerror = () => reject(new Error("WebSocket error"));
				setTimeout(() => reject(new Error("Connection timeout")), 5000);
			});
			const connection = new RelayConnection(socket, targetTabId);
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

	async _connectTab(selectorTabId, tabId, windowId, mcpRelayUrl, activateTab = false) {
		try {
			debugLog(`Connecting tab ${tabId} (activate=${activateTab})`);
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
				// Don't auto-reconnect immediately — let keepAlive handle it
				// after the debounce. Dispose→reconnect cycles will re-establish
				// the connection within ~2-5s via the MCP server.
				if (!this._connectionLostAt)
					this._connectionLostAt = Date.now();
			};
			if (this._preSelectedTabId === tabId)
				this._preSelectedTabId = null;
			const promises = [this._setConnectedTabId(tabId)];
			if (activateTab) {
				promises.push(chrome.tabs.update(tabId, { active: true }));
				promises.push(chrome.windows.update(windowId, { focused: true }));
			}
			await Promise.all(promises);
			// Reset debounce timestamp — we're connected now.
			this._connectionLostAt = null;
			// Signal relay that tab is attached and ready for Playwright commands
			this._activeConnection._sendMessage({
				method: "tabReady",
				params: { tabId }
			});
			debugLog("Connected to MCP bridge, tabReady sent");
		} catch (error) {
			await this._setConnectedTabId(null);
			debugLog(`Failed to connect tab ${tabId}:`, error.message);
			throw error;
		}
	}

	async _setConnectedTabId(tabId) {
		const oldTabId = this._connectedTabId;
		this._connectedTabId = tabId;
		if (tabId === null) {
			// Defer badge clear — dispose→reconnect will re-set within ~2s.
			if (this._badgeClearTimer)
				clearTimeout(this._badgeClearTimer);
			this._badgeClearTimer = setTimeout(async () => {
				if (this._connectedTabId === null && oldTabId) {
					// Still null after 2s — genuinely disconnected.
					await this._updateBadge(oldTabId, { text: "" });
				}
				this._badgeClearTimer = null;
			}, 2000);
		} else {
			// Reconnected — cancel pending badge clear.
			if (this._badgeClearTimer) {
				clearTimeout(this._badgeClearTimer);
				this._badgeClearTimer = null;
			}
			if (oldTabId && oldTabId !== tabId)
				await this._updateBadge(oldTabId, { text: "" });
			await this._updateBadge(tabId, { text: "\u2713", color: "#4CAF50", title: "Connected to MCP client" });
		}
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
		if (this._connectedTabId === tabId)
			await this._setConnectedTabId(null);
		// Multi-tab: don't close the WebSocket when a tab is removed.
		// The connection may still have other tabs attached. The closeTab
		// handler already cleans up _debuggees and bridge state.
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
			}
		}
	}

	_onTabUpdated(tabId, changeInfo, tab) {
		if (this._connectedTabId === tabId && changeInfo.url)
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

	async _startAutoConnect() {
		let config = await this._getRelayConfig();
		if (!config) {
			// Set default config on first run or after update
			// Canonical default: tools/browser-automation-mcp/src/tools/mcp/relay/constants.ts (DEFAULT_RELAY_PORT). Keep in sync.
			config = { host: "127.0.0.1", port: 9223 };
			await chrome.storage.local.set({ relayConfig: config });
			debugLog("Default relay config set:", config);
		}
		this._autoConnectActive = true;
		this._attemptAutoConnect(config);
	}

	async _getRelayConfig() {
		const result = await chrome.storage.local.get("relayConfig");
		return result.relayConfig;
	}

	async _attemptAutoConnect(config) {
		if (this._activeConnection || !this._autoConnectActive) return;

		const baseUrl = `http://${config.host}:${config.port}`;
		try {
			// Find a suitable tab first — don't connect to relay without one
			const allTabs = await chrome.tabs.query({});
			const targetTab = allTabs.find(t =>
				t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("edge://") &&
				!t.url.startsWith("chrome-extension://") && t.url !== "about:blank"
			) || allTabs.find(t =>
				t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("edge://") &&
				!t.url.startsWith("chrome-extension://")
			);
			if (!targetTab) throw new Error("No suitable tab for auto-connect");

			// Discover relay endpoint
			const resp = await fetch(`${baseUrl}/discover`);
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const { extensionPath } = await resp.json();
			const wsUrl = `ws://${config.host}:${config.port}${extensionPath}`;

			// Connect WebSocket WITH tab ID pre-set (avoids race)
			const selectorId = -1; // synthetic selector ID for auto-connect
			await this._connectToRelay(selectorId, wsUrl, targetTab.id);

			// Use _connectTab which sets up lifecycle, sends tabReady
			await this._connectTab(selectorId, targetTab.id, targetTab.windowId, wsUrl);

			debugLog("Auto-connected to relay at", wsUrl, "tab:", targetTab.id, targetTab.title, "(no tab activation)");
			chrome.alarms.clear("autoConnectRetry");
		} catch (e) {
			debugLog("Auto-connect failed:", e.message, "— will retry");
			this._scheduleAutoConnectRetry();
		}
	}

	_scheduleAutoConnectRetry() {
		if (!this._autoConnectActive) return;
		// Fast retry via setTimeout (3s) while service worker is awake
		// Plus chrome.alarms as safety net if service worker goes to sleep
		this._retryTimer = setTimeout(async () => {
			const config = await this._getRelayConfig();
			if (config) this._attemptAutoConnect(config);
		}, 3000);
		chrome.alarms.create("autoConnectRetry", { delayInMinutes: 0.5 });
	}
}

bridge = new EarthlingBrowserBridge();

chrome.runtime.onInstalled.addListener(async (details) => {
	if (details.reason === "install") {
		const existing = await chrome.storage.local.get("relayConfig");
		if (!existing.relayConfig) {
			await chrome.storage.local.set({
				relayConfig: { host: "127.0.0.1", port: 9223 }
			});
			debugLog("Default relay config set");
		}
	}
});
