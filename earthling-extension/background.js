/**
 * Earthling Browser Bridge — MV3 service worker.
 *
 * Connects to the daemon over WebSocket on 127.0.0.1:9223 and executes
 * commands against chrome.tabs / chrome.scripting / chrome.debugger.
 *
 * Strict invariants (mirrors the legacy fork's invariant #7):
 *   - Never activates tabs (chrome.tabs.update({active:true}) is forbidden).
 *   - Never raises the browser window.
 *   - Screenshots use chrome.debugger Page.captureScreenshot — never captureVisibleTab.
 *
 * Auth: the daemon gates the WebSocket upgrade by checking the Origin header against
 * this extension's `chrome-extension://<id>` URL. Browsers set Origin from the executing
 * context and JS cannot override it, so web pages cannot impersonate us. No user-visible
 * token is required.
 */

const DAEMON_URL = "ws://127.0.0.1:9223";

let ws = null;
let connectTimer = null;
let backoffMs = 500;

const consoleBuffers = new Map(); // tabId → string[]
const networkBuffers = new Map(); // tabId → request entries
const indicatorState = new Map(); // tabId → {state, agentLabel}
const indicatorInjected = new Set(); // tabIds where inject/indicator.js has been pushed
const actingTabs = new Map(); // tabId → in-flight action count (drives tab-group color)
const actingLingerTimers = new Map(); // tabId → timeout id
const tabGroupRegistry = new Map(); // windowId → Map<agentLabel, groupId>

const ACTION_KINDS = new Set([
  "navigate",
  "navigate_back",
  "click",
  "type",
  "select_option",
  "hover",
  "scroll",
  "upload",
  "press_key",
]);
const ACTING_LINGER_MS = 400;

try {
  chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  });
} catch (e) {
  console.error("[earthling-bg] setAccessLevel failed:", e?.message ?? e);
}

function connect() {
  try {
    ws = new WebSocket(DAEMON_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    backoffMs = 500;
    void emitInitialTabs();
  });
  ws.addEventListener("message", (ev) => void handleMessage(ev.data));
  ws.addEventListener("close", () => {
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try {
      ws?.close();
    } catch {}
  });
}

function scheduleReconnect(delay) {
  if (connectTimer) return;
  const d = delay ?? backoffMs;
  backoffMs = Math.min(backoffMs * 2, 15_000);
  connectTimer = setTimeout(() => {
    connectTimer = null;
    void connect();
  }, d);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleMessage(raw) {
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (!req || !req.command) return;
  try {
    const result = await dispatch(req);
    send({ id: req.id, ok: true, result });
  } catch (err) {
    send({
      id: req.id,
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
}

async function dispatch(req) {
  const c = req.command;
  const tabId = req.tabId;
  if (c.kind === "indicator_state") return applyIndicatorState(tabId, c.state);
  if (ACTION_KINDS.has(c.kind) && tabId != null) {
    return withActing(tabId, () => dispatchInner(req));
  }
  return dispatchInner(req);
}

async function dispatchInner(req) {
  const c = req.command;
  const tabId = req.tabId;
  switch (c.kind) {
    case "tabs_query":
      return queryTabs(c.query);
    case "tabs_create":
      return createTab(c.url, c.background !== false);
    case "tabs_remove":
      return removeTab(c.tabId);
    case "navigate":
      return navigate(tabId, c.url, c.waitUntil);
    case "navigate_back":
      return navigateBack(tabId);
    case "snapshot":
      return takeSnapshot(tabId, c);
    case "screenshot":
      return takeScreenshot(tabId, c);
    case "console_messages":
      return getConsole(tabId, c.limit ?? 50);
    case "network_requests":
      return getNetwork(tabId, c.limit ?? 50);
    case "click":
      return runHelper(tabId, "click", c);
    case "type":
      return runHelper(tabId, "type", c);
    case "select_option":
      return runHelper(tabId, "select_option", c);
    case "hover":
      return runHelper(tabId, "hover", c);
    case "scroll":
      return runHelper(tabId, "scroll", c);
    case "upload":
      return runHelper(tabId, "upload", c);
    case "press_key":
      return runHelper(tabId, "press_key", c);
    case "evaluate":
      return runEvaluate(tabId, c.expression);
    case "wait_for":
      return runHelper(tabId, "wait_for", c);
    default:
      throw new Error(`unknown command: ${c.kind}`);
  }
}

// ─── chrome.tabs operations ─────────────────────────────────────────

async function queryTabs(query) {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url ?? "",
    title: t.title ?? "",
    windowId: t.windowId,
    active: !!t.active,
  }));
}

async function createTab(url, background) {
  const tab = await chrome.tabs.create({ url, active: !background });
  return {
    id: tab.id,
    url: tab.url ?? url,
    title: tab.title ?? "",
    windowId: tab.windowId,
    active: !!tab.active,
  };
}

async function removeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function navigate(tabId, url, waitUntil) {
  await chrome.tabs.update(tabId, { url });
  if (waitUntil === "load") await waitForTabComplete(tabId);
  else await waitForTabDomReady(tabId);
  return { navigated: url };
}

async function navigateBack(tabId) {
  await chrome.tabs.goBack(tabId);
  return { ok: true };
}

function waitForTabComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId).then((t) => {
        if (t.status === "complete") return resolve(undefined);
        if (Date.now() - start > timeoutMs)
          return reject(new Error("navigation timeout"));
        setTimeout(check, 100);
      }, reject);
    };
    check();
  });
}

function waitForTabDomReady(tabId) {
  return waitForTabComplete(tabId, 8_000).catch(() => undefined);
}

// ─── snapshot / screenshot ──────────────────────────────────────────

async function takeSnapshot(tabId, opts) {
  await ensureHelpers(tabId);
  const [exec] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: () => globalThis.__earthlingA11y?.(),
  });
  return exec?.result ?? { role: "WebArea", children: [], depth: 0 };
}

async function ensureHelpers(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["inject/helpers.js"],
  });
}

async function takeScreenshot(tabId, opts) {
  // chrome.debugger Page.captureScreenshot — does NOT raise the window.
  await debuggerAttach(tabId);
  try {
    const params = {
      format: opts.format ?? "png",
      ...(opts.quality && opts.format === "jpeg"
        ? { quality: opts.quality }
        : {}),
      captureBeyondViewport: false,
    };
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId },
        "Page.captureScreenshot",
        params,
        (r) => {
          if (chrome.runtime.lastError)
            reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        },
      );
    });
    return { format: params.format, dataBase64: result.data };
  } finally {
    debuggerDetachLater(tabId);
  }
}

const attached = new Set();
const detachTimers = new Map();

function debuggerAttach(tabId) {
  if (attached.has(tabId)) {
    const t = detachTimers.get(tabId);
    if (t) {
      clearTimeout(t);
      detachTimers.delete(tabId);
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else {
        attached.add(tabId);
        resolve();
      }
    });
  });
}

function debuggerDetachLater(tabId) {
  if (detachTimers.has(tabId)) clearTimeout(detachTimers.get(tabId));
  detachTimers.set(
    tabId,
    setTimeout(() => {
      chrome.debugger.detach({ tabId }, () => {
        /* swallow */
      });
      attached.delete(tabId);
      detachTimers.delete(tabId);
    }, 5_000),
  );
}

// ─── interaction helpers ────────────────────────────────────────────

async function runHelper(tabId, kind, opts) {
  await ensureHelpers(tabId);
  await ensureIndicatorInjected(tabId);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    func: (k, o) => globalThis.__earthlingAct(k, o),
    args: [kind, opts],
  });
  return result?.result;
}

// ─── indicator (in-page + tab-group) ────────────────────────────────

async function applyIndicatorState(tabId, state) {
  if (tabId == null) return { ok: false };
  if (state.state === "released") indicatorState.delete(tabId);
  else indicatorState.set(tabId, state);
  await Promise.allSettled([
    pushIndicatorToPage(tabId, state),
    updateTabGroup(tabId, state),
  ]);
  if (state.state === "released") {
    actingTabs.delete(tabId);
    const t = actingLingerTimers.get(tabId);
    if (t) {
      clearTimeout(t);
      actingLingerTimers.delete(tabId);
    }
  }
  return { ok: true };
}

async function pushIndicatorToPage(tabId, state) {
  if (!(await canInject(tabId))) return;
  try {
    await ensureIndicatorInjected(tabId);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (s) => globalThis.__earthlingIndicator?.set?.(s),
      args: [state],
    });
  } catch (e) {
    console.error(
      `[earthling-bg] pushIndicatorToPage(${tabId}) failed:`,
      e?.message ?? e,
    );
  }
}

async function ensureIndicatorInjected(tabId) {
  if (indicatorInjected.has(tabId)) return;
  if (!(await canInject(tabId))) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["inject/indicator.js"],
    });
    indicatorInjected.add(tabId);
    const cached = indicatorState.get(tabId);
    if (cached) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (s) => globalThis.__earthlingIndicator?.set?.(s),
        args: [cached],
      });
    }
  } catch (e) {
    console.error(
      `[earthling-bg] ensureIndicatorInjected(${tabId}) failed:`,
      e?.message ?? e,
    );
  }
}

async function canInject(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    const url = t?.url || "";
    return /^(https?|file):/.test(url);
  } catch {
    return false;
  }
}

async function withActing(tabId, fn) {
  bumpActing(tabId, 1);
  try {
    return await fn();
  } finally {
    bumpActing(tabId, -1);
  }
}

function bumpActing(tabId, delta) {
  const next = (actingTabs.get(tabId) || 0) + delta;
  if (next <= 0) {
    actingTabs.delete(tabId);
    if (actingLingerTimers.has(tabId)) return;
    const t = setTimeout(() => {
      actingLingerTimers.delete(tabId);
      void recolorGroupForTab(tabId);
    }, ACTING_LINGER_MS);
    actingLingerTimers.set(tabId, t);
  } else {
    actingTabs.set(tabId, next);
    if (actingLingerTimers.has(tabId)) {
      clearTimeout(actingLingerTimers.get(tabId));
      actingLingerTimers.delete(tabId);
    }
    void recolorGroupForTab(tabId);
  }
}

async function recolorGroupForTab(tabId) {
  const state = indicatorState.get(tabId);
  if (!state || state.state !== "leased") return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = tab.groupId;
    if (groupId == null || groupId < 0) return;
    const color = actingTabs.has(tabId) ? "orange" : "pink";
    await chrome.tabGroups.update(groupId, { color });
  } catch (e) {
    console.error(
      `[earthling-bg] recolorGroupForTab(${tabId}) failed:`,
      e?.message ?? e,
    );
  }
}

async function updateTabGroup(tabId, state) {
  if (!chrome.tabGroups) return;
  if (state.state === "released") {
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {}
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    const label = state.agentLabel || "";
    const groupKey = label || "_default";
    const groupId = await ensureGroup(tab.windowId, groupKey, tabId);
    const color = actingTabs.has(tabId) ? "orange" : "pink";
    const title = label ? `Earthling — ${label}` : "Earthling";
    await chrome.tabGroups.update(groupId, { title, color });
  } catch (e) {
    console.error("[earthling] updateTabGroup failed:", e?.message ?? e);
  }
}

async function ensureGroup(windowId, label, tabId) {
  let perWindow = tabGroupRegistry.get(windowId);
  if (!perWindow) {
    perWindow = new Map();
    tabGroupRegistry.set(windowId, perWindow);
  }
  let groupId = perWindow.get(label);
  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
      return groupId;
    } catch {
      perWindow.delete(label);
    }
  }
  groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId },
  });
  perWindow.set(label, groupId);
  return groupId;
}

async function runEvaluate(tabId, expression) {
  // Use chrome.debugger Runtime.evaluate — runs in the page's JS context but as the debugger,
  // so it bypasses the page's CSP (which would otherwise reject `new Function()` on strict sites
  // like chatgpt.com). Attach is reused if already held (debuggerAttach is idempotent).
  await debuggerAttach(tabId);
  try {
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId },
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          // Wrapping in an IIFE lets the agent pass either an expression ("a+b") or a statement block
          // because Runtime.evaluate treats the whole string as an expression by default.
          userGesture: false,
        },
        (r) => {
          if (chrome.runtime.lastError)
            reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        },
      );
    });
    if (result?.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(
        ex.exception?.description || ex.text || "evaluation failed",
      );
    }
    return result?.result?.value;
  } finally {
    debuggerDetachLater(tabId);
  }
}

// ─── console & network buffering ────────────────────────────────────

function getConsole(tabId, limit) {
  const buf = consoleBuffers.get(tabId) ?? [];
  return buf.slice(-limit);
}

function getNetwork(tabId, limit) {
  const buf = networkBuffers.get(tabId) ?? [];
  return buf.slice(-limit);
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const buf = networkBuffers.get(details.tabId) ?? [];
    buf.push({
      method: details.method,
      url: details.url,
      status: details.statusCode,
      type: details.type,
      ts: details.timeStamp,
    });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    networkBuffers.set(details.tabId, buf);
  },
  { urls: ["<all_urls>"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  indicatorState.delete(tabId);
  indicatorInjected.delete(tabId);
  actingTabs.delete(tabId);
  const t = actingLingerTimers.get(tabId);
  if (t) {
    clearTimeout(t);
    actingLingerTimers.delete(tabId);
  }
  send({ type: "tab_closed", tabId });
});
chrome.tabs.onAttached.addListener((tabId) => {
  const state = indicatorState.get(tabId);
  if (state && state.state === "leased") void updateTabGroup(tabId, state);
});
chrome.tabs.onCreated.addListener((tab) => {
  send({
    type: "tab_created",
    tab: {
      id: tab.id,
      url: tab.url ?? "",
      title: tab.title ?? "",
      windowId: tab.windowId,
      active: !!tab.active,
    },
  });
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") indicatorInjected.delete(tabId);
  if (info.status === "complete") {
    const state = indicatorState.get(tabId);
    if (state && state.state === "leased")
      void pushIndicatorToPage(tabId, state);
  }
  if (info.status !== "complete" && !info.url && !info.title) return;
  send({
    type: "tab_updated",
    tab: {
      id: tab.id,
      url: tab.url ?? "",
      title: tab.title ?? "",
      windowId: tab.windowId,
      active: !!tab.active,
    },
  });
});

async function emitInitialTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    send({
      type: "tab_updated",
      tab: {
        id: t.id,
        url: t.url ?? "",
        title: t.title ?? "",
        windowId: t.windowId,
        active: !!t.active,
      },
    });
  }
}

void connect();
