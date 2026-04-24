// Debug ring buffer — queryable via Earthling.getDebugLog pseudo-CDP command.
const DEBUG_LOG_MAX = 200;
const _debugRingBuffer = [];

function debugLog(...args) {
	const entry = { ts: Date.now(), msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') };
	_debugRingBuffer.push(entry);
	if (_debugRingBuffer.length > DEBUG_LOG_MAX)
		_debugRingBuffer.shift();
	// Mirror free-form logs into the JSONL pipeline as `log` events.
	_queueJsonl({ event: 'log', detail: { msg: entry.msg } });
	console.log("[Earthling]", ...args);
}

// Structured JSONL logging — POSTed in batches to daemon /debug/extension.
const _jsonlBatch = [];
let _jsonlSeq = 0;
let _jsonlFlushTimer = null;
const JSONL_BATCH_MAX = 50;
const JSONL_FLUSH_MS = 500;

function debugJsonl(event, fields = {}) {
	_queueJsonl({ event, ...fields });
}

function _queueJsonl(fields) {
	_jsonlSeq += 1;
	const line = { ts: Date.now(), layer: 'extension', seq: _jsonlSeq, ...fields };
	_jsonlBatch.push(line);
	if (_jsonlBatch.length >= JSONL_BATCH_MAX) {
		_flushJsonl();
	} else if (!_jsonlFlushTimer) {
		_jsonlFlushTimer = setTimeout(_flushJsonl, JSONL_FLUSH_MS);
	}
}

async function _flushJsonl() {
	if (_jsonlFlushTimer) { clearTimeout(_jsonlFlushTimer); _jsonlFlushTimer = null; }
	if (!_jsonlBatch.length) return;
	const batch = _jsonlBatch.splice(0, _jsonlBatch.length);
	try {
		const cfg = await chrome.storage.local.get("relayConfig");
		const rc = cfg.relayConfig;
		if (!rc) return;
		const url = `http://${rc.host}:${rc.port}/debug/extension`;
		await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(batch),
			keepalive: true,
		});
	} catch {
		// Fire-and-forget; drop on failure. The in-memory ring buffer remains
		// queryable via Earthling.getDebugLog as a fallback.
	}
}

// Flush on SW suspend so we don't lose the tail of a session.
if (chrome.runtime.onSuspend) {
	chrome.runtime.onSuspend.addListener(() => { void _flushJsonl(); });
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
		// Per-tab child CDP sessionIds captured from Target.attachedToTarget events
		// (flat mode). The page's root session is tracked separately on the tab
		// record; this set holds iframe/worker sub-sessions for routing.
		this._tabChildSessions = new Map(); // tabId -> Set<sessionId>
		// Per-tab root page sessionId captured during attachToTab.
		this._tabRootSession = new Map(); // tabId -> sessionId
		// Pending attachedToTarget waiters keyed by tabId.
		// Each entry: { resolve(sessionId), timer }
		this._attachWaiters = new Map();
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
		this._tabChildSessions.clear();
		this._tabRootSession.clear();
		for (const waiter of this._attachWaiters.values()) {
			if (waiter.timer) clearTimeout(waiter.timer);
			if (!waiter.resolved) waiter.resolve(null);
		}
		this._attachWaiters.clear();
		this.onclose?.();
	}

	_onDebuggerEvent(source, method, params) {
		if (!this._debuggees.has(source.tabId))
			return;
		// Capture real CDP sessionIds emitted via Target.attachedToTarget in flat
		// mode. These include the tab's root page session and all iframe/worker
		// sub-sessions. The root page session is what resolves attachToTab; child
		// sessions are tracked so daemon commands targeting them can be routed.
		if (method === "Target.attachedToTarget" && params?.sessionId) {
			const childSid = params.sessionId;
			const targetType = params.targetInfo?.type;
			let set = this._tabChildSessions.get(source.tabId);
			if (!set) { set = new Set(); this._tabChildSessions.set(source.tabId, set); }
			set.add(childSid);
			debugJsonl('debugger.event.sessionCaptured', {
				tabId: source.tabId,
				realSessionId: childSid,
				detail: { targetType, parentSessionId: source.sessionId || null, waitersPending: this._attachWaiters.has(source.tabId) }
			});
			// Resolve the attachToTab waiter on the first page target seen for
			// this tab. Iframe/worker targets are tracked but don't resolve.
			const waiter = this._attachWaiters.get(source.tabId);
			if (waiter && targetType === 'page' && !waiter.resolved) {
				waiter.resolved = true;
				this._tabRootSession.set(source.tabId, childSid);
				if (waiter.timer) clearTimeout(waiter.timer);
				this._attachWaiters.delete(source.tabId);
				waiter.resolve(childSid);
			}
		}
		if (method === "Target.detachedFromTarget" && params?.sessionId) {
			const set = this._tabChildSessions.get(source.tabId);
			if (set) set.delete(params.sessionId);
		}
		this._sendMessage({
			method: "forwardCDPEvent",
			params: { sessionId: source.sessionId, tabId: source.tabId, method, params }
		});
	}

	_onDebuggerDetach(source, reason) {
		if (!this._debuggees.has(source.tabId))
			return;
		this._debuggees.delete(source.tabId);
		this._tabChildSessions.delete(source.tabId);
		this._tabRootSession.delete(source.tabId);
		// Resolve any pending attachToTab waiter for this tab with null so the
		// caller sees "no sessionId captured" rather than hanging.
		const waiter = this._attachWaiters.get(source.tabId);
		if (waiter && !waiter.resolved) {
			waiter.resolved = true;
			if (waiter.timer) clearTimeout(waiter.timer);
			this._attachWaiters.delete(source.tabId);
			waiter.resolve(null);
		}
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
			let freshAttach = false;
			if (!this._debuggees.has(tabId)) {
				try {
					await chrome.debugger.attach(debuggee, "1.3");
					freshAttach = true;
				} catch (e) {
					if (!e.message?.includes("Already attached"))
						throw e;
					debugLog("Debugger attach skipped (already attached):", e.message);
				}
				this._debuggees.set(tabId, debuggee);
			}
			debugJsonl('debuggee.attach', { tabId, detail: { freshAttach } });

			// Capture the real CDP sessionId for the tab's page target. In flat
			// mode, Target.setAutoAttach on the tab-level debuggee causes Chrome
			// to emit Target.attachedToTarget for the page target (and any
			// iframes/workers), each carrying a real sessionId that can be used
			// with chrome.debugger.sendCommand({ tabId, sessionId }, ...).
			//
			// Order matters: register the waiter BEFORE issuing setAutoAttach so
			// we don't race the event listener.
			let realSessionId = this._tabRootSession.get(tabId) || null;
			if (!realSessionId) {
				const waitPromise = new Promise((resolve) => {
					const existing = this._attachWaiters.get(tabId);
					if (existing) {
						// Piggy-back on the in-flight waiter.
						const prev = existing.resolve;
						existing.resolve = (sid) => { prev(sid); resolve(sid); };
						return;
					}
					const waiter = { resolve, resolved: false, timer: null };
					waiter.timer = setTimeout(() => {
						if (waiter.resolved) return;
						waiter.resolved = true;
						this._attachWaiters.delete(tabId);
						debugJsonl('debugger.event.sessionCaptureTimeout', { tabId });
						resolve(null);
					}, 2000);
					this._attachWaiters.set(tabId, waiter);
				});

				try {
					await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", {
						autoAttach: true,
						waitForDebuggerOnStart: false,
						flatten: true,
					});
					debugJsonl('autoAttach.set', { tabId, detail: { ok: true } });
				} catch (e) {
					debugJsonl('autoAttach.set', { tabId, detail: { ok: false, error: String(e?.message || e) } });
					debugLog("Target.setAutoAttach failed:", e);
				}

				// Playwright's documented workaround for Chromium's auto-attach
				// timing bug — force a dummy command on the same session to make
				// the pending attachedToTarget events flush.
				try {
					await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
				} catch (_) {
					/* ignore */
				}

				realSessionId = await waitPromise;
			}
			const result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
			debugJsonl('attachToTab.return', {
				tabId,
				realSessionId: realSessionId || undefined,
				detail: { captured: !!realSessionId }
			});
			return { targetInfo: result?.targetInfo, sessionId: realSessionId || undefined };
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
				active: tab.active
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
				this._tabChildSessions.delete(tabId);
				this._tabRootSession.delete(tabId);
				await chrome.debugger.detach(debuggee).catch(() => {});
			}
			return { detached: !!debuggee };
		}

		if (message.method === "openTab") {
			const tab = await chrome.tabs.create({ url: message.params.url || "about:blank", active: false });
			return { tabId: tab.id, title: tab.title, url: tab.url };
		}

		if (message.method === "closeTab") {
			const closingTabId = message.params.tabId;
			// Remove from debuggees BEFORE chrome.tabs.remove() to prevent
			// _onDebuggerDetach from firing tabDetached for an expected close.
			this._debuggees.delete(closingTabId);
			this._tabChildSessions.delete(closingTabId);
			this._tabRootSession.delete(closingTabId);
			await chrome.tabs.remove(closingTabId);
			return {};
		}

		if (message.method === "getDebugLog") {
			return [..._debugRingBuffer];
		}

		if (message.method === "queryOrphanBlanks") {
			// Dev-only sweep support. Returns tabs currently at about:blank with
			// their `lastAccessed` and a best-effort `historyLength` (defaults to
			// 1 when unknown — the daemon's `historyLength <= 1` filter treats
			// that as "un-navigated and safe to close"). We never close tabs
			// ourselves — invariant #9: extension stays passive.
			const tabs = await chrome.tabs.query({ url: "about:blank" });
			const out = tabs.map(t => ({
				tabId: t.id,
				lastAccessed: typeof t.lastAccessed === "number" ? t.lastAccessed : 0,
				// chrome.tabs.Tab doesn't expose session/back-forward history length
				// from an SW context; safe default is 1 (one entry = just about:blank).
				historyLength: 1,
			}));
			return { tabs: out };
		}

		if (message.method === "forwardCDPCommand") {
			const { tabId, sessionId, method, params } = message.params;
			const debuggee = tabId ? this._debuggees.get(tabId) : null;
			if (!debuggee)
				throw new Error(tabId ? `No debugger attached to tab ${tabId}` : "No tabId provided in forwardCDPCommand");
			// Chrome 125+ flat-mode 4-arg form: pass sessionId as part of the
			// DebuggerSession object so commands route to the specified child
			// session (page, iframe, worker). If sessionId is undefined, the
			// command targets the tab's top-level session.
			const debuggerSession = sessionId ? { ...debuggee, sessionId } : debuggee;
			debugJsonl('debugger.command.send', {
				tabId,
				realSessionId: sessionId,
				method,
				dir: 'out',
			});
			try {
				const result = await chrome.debugger.sendCommand(debuggerSession, method, params);
				debugJsonl('debugger.command.recv', { tabId, realSessionId: sessionId, method, dir: 'in' });
				return result;
			} catch (e) {
				debugJsonl('debugger.command.recv', { tabId, realSessionId: sessionId, method, dir: 'in', detail: { error: String(e?.message || e) } });
				throw e;
			}
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
		this._pendingTabSelection = new Map();
		this._autoConnectActive = false;
		// Debounce state: tracks when the connection was lost to avoid
		// unnecessary auto-reconnect during dispose→reconnect cycles (~2-5s).
		this._connectionLostAt = null;

		chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
		chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
		chrome.runtime.onMessage.addListener(this._onMessage.bind(this));

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

	_onMessage(message, sender, sendResponse) {
		switch (message.type) {
			case "getTabs":
				this._getTabs().then(
					(tabs) => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
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

	async _onContextMenuClicked(info, tab) {
		if (!tab?.id) return;
		if (info.menuItemId === "earthling-block-tab") {
			await this._blockTab(tab.id);
		} else if (info.menuItemId === "earthling-unblock-tab") {
			await this._unblockTab(tab.id);
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
		// Guard: prevent dual-connect race between auto-connect and alarm retries
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

	async _connectTab(selectorTabId, tabId) {
		try {
			debugLog(`Connecting tab ${tabId}`);
			try {
				this._activeConnection?.close("Another connection is requested");
			} catch (error) {
				debugLog("Error closing active connection:", error);
			}
			this._activeConnection = this._pendingTabSelection.get(selectorTabId)?.connection;
			if (!this._activeConnection)
				throw new Error("No active MCP relay connection");
			this._pendingTabSelection.delete(selectorTabId);
			this._activeConnection.setTabId(tabId);
			this._activeConnection.onclose = () => {
				debugLog("MCP connection closed");
				this._activeConnection = undefined;
				// Don't auto-reconnect immediately — let keepAlive handle it
				// after the debounce. Dispose→reconnect cycles will re-establish
				// the connection within ~2-5s via the MCP server.
				if (!this._connectionLostAt)
					this._connectionLostAt = Date.now();
			};
			// Reset debounce timestamp — we're connected now.
			this._connectionLostAt = null;
			// Signal relay that tab is attached and ready for Playwright commands
			this._activeConnection._sendMessage({
				method: "tabReady",
				params: { tabId }
			});
			debugLog("Connected to MCP bridge, tabReady sent");
		} catch (error) {
			debugLog(`Failed to connect tab ${tabId}:`, error.message);
			throw error;
		}
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
		// Multi-tab: don't close the WebSocket when a tab is removed.
		// The connection may still have other tabs attached. The closeTab
		// handler already cleans up _debuggees on the connection.
	}

	_onTabActivated(activeInfo) {
		// Update context menu visibility for the active tab
		this._updateContextMenu(activeInfo.tabId);
		debugJsonl('tab.userActivated', { tabId: activeInfo.tabId });
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
			await this._connectTab(selectorId, targetTab.id);

			debugLog("Auto-connected to relay at", wsUrl, "tab:", targetTab.id, targetTab.title);
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

// Kick off auto-connect immediately on SW startup (previously triggered by
// the connect.html tab). Fire-and-forget — _attemptAutoConnect self-retries
// via _scheduleAutoConnectRetry if the daemon isn't reachable yet.
bridge._startAutoConnect().catch(() => {});

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
