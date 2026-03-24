const params = new URLSearchParams(window.location.search);
const mcpRelayUrl = params.get("mcpRelayUrl");
const clientParam = params.get("client");
const protocolVersion = params.get("protocolVersion");
const token = params.get("token");
const newTab = params.get("newTab") === "true";

let clientInfo = null;
try {
	if (clientParam) clientInfo = JSON.parse(clientParam);
} catch (_) {
	clientInfo = null;
}

const bannerEl = document.getElementById("banner");
const clientInfoEl = document.getElementById("client-info");
const tabSection = document.getElementById("tab-section");
const tabListEl = document.getElementById("tab-list");
const rejectBtn = document.getElementById("reject-btn");

function showBanner(type, html) {
	bannerEl.className = "banner " + type;
	bannerEl.innerHTML = html;
}

async function getOrCreateAuthToken() {
	const result = await chrome.storage.local.get("authToken");
	if (result.authToken) return result.authToken;
	const newToken = crypto.randomUUID();
	await chrome.storage.local.set({ authToken: newToken });
	return newToken;
}

function isLoopback(url) {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname;
		return host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "localhost";
	} catch (_) {
		return false;
	}
}

function sendMsg(message) {
	return chrome.runtime.sendMessage(message);
}

function renderTabs(tabs, currentTabId) {
	tabListEl.innerHTML = "";
	for (const tab of tabs) {
		if (tab.url && tab.url.includes("connect.html")) continue;

		const li = document.createElement("li");
		li.className = "tab-item";

		const favicon = document.createElement("img");
		favicon.className = "tab-favicon";
		favicon.src = tab.favIconUrl || "icons/icon-16.png";
		favicon.alt = "";
		favicon.onerror = function() { this.src = "icons/icon-16.png"; };

		const details = document.createElement("div");
		details.className = "tab-details";

		const title = document.createElement("div");
		title.className = "tab-title";
		title.textContent = tab.title || "(Untitled)";

		const url = document.createElement("div");
		url.className = "tab-url";
		url.textContent = tab.url || "";

		details.appendChild(title);
		details.appendChild(url);

		const btn = document.createElement("button");
		btn.className = "btn btn-connect";
		btn.textContent = "Connect";
		btn.addEventListener("click", function() {
			connectToTab(tab.id, tab.windowId);
		});

		li.appendChild(favicon);
		li.appendChild(details);
		li.appendChild(btn);
		tabListEl.appendChild(li);
	}
	tabSection.style.display = "block";
}

async function connectToTab(tabId, windowId) {
	showBanner("connecting", '<span class="spinner"></span>Connecting to tab...');
	disableAllConnectButtons();

	const resp = await sendMsg({
		type: "connectToTab",
		tabId: tabId,
		windowId: windowId,
		mcpRelayUrl: mcpRelayUrl
	});

	if (resp && resp.success) {
		showBanner("connected", "Connected successfully. You can close this tab.");
		setTimeout(closeThisTab, 800);
	} else {
		showBanner("error", "Failed to connect: " + (resp && resp.error ? resp.error : "Unknown error"));
		enableAllConnectButtons();
	}
}

function disableAllConnectButtons() {
	for (const btn of tabListEl.querySelectorAll(".btn-connect")) btn.disabled = true;
}

function enableAllConnectButtons() {
	for (const btn of tabListEl.querySelectorAll(".btn-connect")) btn.disabled = false;
}

function closeThisTab() {
	chrome.tabs.getCurrent(function(tab) {
		if (tab) chrome.tabs.remove(tab.id);
	});
}

rejectBtn.addEventListener("click", async function() {
	await sendMsg({ type: "disconnect" });
	showBanner("error", "Connection rejected.");
	setTimeout(closeThisTab, 500);
});

chrome.runtime.onMessage.addListener(function(message) {
	if (message.type === "connectionTimeout") {
		showBanner("error", "Connection timed out. The MCP relay may have closed.");
	}
});

async function main() {
	if (protocolVersion && protocolVersion !== "1") {
		showBanner("error",
			"Unsupported protocol version: " + protocolVersion + ". " +
			"This extension supports protocol version 1. " +
			'Please update the extension or check the <a href="https://earthlingai.com" target="_blank">documentation</a>.');
		return;
	}

	if (!mcpRelayUrl) {
		showBanner("error", "Missing mcpRelayUrl parameter.");
		return;
	}

	if (!isLoopback(mcpRelayUrl)) {
		showBanner("error", "Relay URL must be a loopback address (127.0.0.1 or [::1]). Got: " + mcpRelayUrl);
		return;
	}

	if (clientInfo) {
		clientInfoEl.style.display = "block";
		clientInfoEl.innerHTML = "MCP Client: <strong>" +
			escapeHtml(clientInfo.name || "Unknown") + "</strong>" +
			(clientInfo.version ? " v" + escapeHtml(clientInfo.version) : "");
	}

	showBanner("connecting", '<span class="spinner"></span>Connecting to MCP relay...');

	const relayResp = await sendMsg({ type: "connectToMCPRelay", mcpRelayUrl: mcpRelayUrl });
	if (!relayResp || !relayResp.success) {
		showBanner("error", "Failed to connect to MCP relay: " + (relayResp && relayResp.error ? relayResp.error : "Unknown error"));
		return;
	}

	const storedToken = await getOrCreateAuthToken();
	const tokenMatch = token && token === storedToken;

	const status = await sendMsg({ type: "getConnectionStatus" });

	if (status && status.preSelectedTabId) {
		showBanner("connecting", '<span class="spinner"></span>Auto-connecting to pre-selected tab...');
		const tabsResp = await sendMsg({ type: "getTabs" });
		const preTab = tabsResp && tabsResp.tabs
			? tabsResp.tabs.find(function(t) { return t.id === status.preSelectedTabId; })
			: null;
		if (preTab) {
			await connectToTab(preTab.id, preTab.windowId);
			return;
		}
	}

	if (tokenMatch && newTab) {
		showBanner("connecting", '<span class="spinner"></span>Auto-connecting to current tab...');
		const tabsResp = await sendMsg({ type: "getTabs" });
		if (tabsResp && tabsResp.currentTabId) {
			const currentTab = tabsResp.tabs
				? tabsResp.tabs.find(function(t) { return t.id === tabsResp.currentTabId; })
				: null;
			if (currentTab) {
				await connectToTab(currentTab.id, currentTab.windowId);
				return;
			}
		}
	}

	showBanner("connecting", "Select a tab to connect the MCP client to:");
	rejectBtn.style.display = "inline-block";

	const tabsResp = await sendMsg({ type: "getTabs" });
	if (tabsResp && tabsResp.success && tabsResp.tabs) {
		renderTabs(tabsResp.tabs, tabsResp.currentTabId);
	} else {
		showBanner("error", "Failed to fetch tabs.");
	}
}

function escapeHtml(str) {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}

main();
