const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const connectedTabSection = document.getElementById("connected-tab-section");
const connectedTab = document.getElementById("connected-tab");
const ctFavicon = document.getElementById("ct-favicon");
const ctTitle = document.getElementById("ct-title");
const ctUrl = document.getElementById("ct-url");
const tokenValueEl = document.getElementById("token-value");
const copyBtn = document.getElementById("copy-btn");
const disconnectSection = document.getElementById("disconnect-section");
const disconnectBtn = document.getElementById("disconnect-btn");
const emptyState = document.getElementById("empty-state");

async function loadToken() {
  try {
    const result = await chrome.storage.local.get("authToken");
    if (result.authToken) {
      tokenValueEl.textContent = result.authToken;
    } else {
      const newToken = crypto.randomUUID();
      await chrome.storage.local.set({ authToken: newToken });
      tokenValueEl.textContent = newToken;
    }
  } catch (e) {
    tokenValueEl.textContent = "Error: " + e.message;
  }
}

copyBtn.addEventListener("click", async function () {
  const text = tokenValueEl.textContent;
  if (!text || text === "Loading...") return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "✔️ Copied";
    copyBtn.classList.add("copied");
    setTimeout(function () {
      copyBtn.textContent = "Copy";
      copyBtn.classList.remove("copied");
    }, 1500);
  } catch (_) {
    const range = document.createRange();
    range.selectNodeContents(tokenValueEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

function sendMsg(message) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Service worker not responding")),
        3000,
      ),
    ),
  ]);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function refreshStatus() {
  let status;
  try {
    status = await sendMsg({ type: "getConnectionStatus" });
  } catch (e) {
    statusDot.className = "status-dot inactive";
    statusText.textContent = "Error: " + e.message;
    emptyState.style.display = "block";
    emptyState.textContent =
      "Background service worker may not be running. Check chrome://extensions/ for errors.";
    return;
  }

  if (status && status.connectedTabId) {
    statusDot.className = "status-dot active";
    statusText.textContent = "Connected";
    disconnectSection.style.display = "block";
    emptyState.style.display = "none";

    const tabsResp = await sendMsg({ type: "getTabs" });
    if (tabsResp && tabsResp.success && tabsResp.tabs) {
      const tab = tabsResp.tabs.find(function (t) {
        return t.id === status.connectedTabId;
      });
      if (tab) {
        connectedTabSection.style.display = "block";
        ctTitle.textContent = tab.title || "(Untitled)";
        ctUrl.textContent = tab.url || "";
        ctFavicon.src = tab.favIconUrl || "icons/icon-16.png";
        ctFavicon.onerror = function () {
          this.src = "icons/icon-16.png";
        };
        connectedTab.onclick = function () {
          chrome.tabs.update(tab.id, { active: true });
          chrome.windows.update(tab.windowId, { focused: true });
        };
      } else {
        connectedTabSection.style.display = "none";
      }
    }
  } else {
    statusDot.className = "status-dot inactive";
    statusText.textContent = "Disconnected";
    connectedTabSection.style.display = "none";
    disconnectSection.style.display = "none";
    emptyState.style.display = "block";
  }
}

async function refreshBlocklist() {
  const resp = await sendMsg({ type: "getBlocklist" });
  const blocklist = resp?.blocklist || [];
  const blocklistEl = document.getElementById("blocklist");
  const emptyEl = document.getElementById("blocklist-empty");

  if (blocklist.length === 0) {
    emptyEl.style.display = "block";
    blocklistEl.innerHTML = "";
    return;
  }
  emptyEl.style.display = "none";

  const tabs = await chrome.tabs.query({});
  blocklistEl.innerHTML = "";
  for (const tabId of blocklist) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) continue;
    const li = document.createElement("li");
    li.className = "tab-item";
    li.innerHTML =
      '<img class="tab-favicon" src="' +
      (tab.favIconUrl || "icons/icon-16.png") +
      '" alt="" onerror="this.src=\'icons/icon-16.png\'">' +
      '<div class="tab-details">' +
      '<div class="tab-title">' +
      escapeHtml(tab.title || "(Untitled)") +
      "</div>" +
      '<div class="tab-url">' +
      escapeHtml(tab.url || "") +
      "</div>" +
      "</div>" +
      '<button class="btn btn-unblock" data-tab-id="' +
      tabId +
      '">Unblock</button>';
    blocklistEl.appendChild(li);
  }

  blocklistEl.querySelectorAll(".btn-unblock").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await sendMsg({ type: "unblockTab", tabId: parseInt(btn.dataset.tabId) });
      refreshBlocklist();
    });
  });
}

disconnectBtn.addEventListener("click", async function () {
  disconnectBtn.disabled = true;
  await sendMsg({ type: "disconnect" });
  await refreshStatus();
  disconnectBtn.disabled = false;
});

chrome.runtime.onMessage.addListener(function (message) {
  if (
    message.type === "connectionTimeout" ||
    message.type === "connectionStatusChanged"
  ) {
    refreshStatus();
    refreshBlocklist();
  }
});

loadToken();
refreshStatus();
refreshBlocklist();
