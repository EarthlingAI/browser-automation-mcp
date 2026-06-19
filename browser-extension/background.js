/**
 * Browser Automation Bridge — MV3 service worker.
 *
 * Connects to the daemon over WebSocket on 127.0.0.1:9223 and executes
 * commands against chrome.tabs / chrome.scripting / chrome.debugger.
 *
 * Strict invariants (mirrors the legacy fork's invariant #7):
 *   - Never activates tabs or raises the window EXCEPT the explicit bringToFront
 *     escape hatch (chrome.tabs.update({active:true}) + chrome.windows.update is
 *     confined to bringToFront; forbidden everywhere else).
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
// Cross-origin OOPIF descent (Phase 4b). tabId → Map<logicalN, chromeFrameId>.
// Rebuilt on every includeCrossOriginFrames snapshot; the logical N (1-based) is
// the `fN:` ref namespace, decoupled from Chrome's large opaque frameId. SW
// state (not persisted) — cleared on tab close. Lets a later action on an
// `fN:localId` ref route executeScript to the right cross-origin frame.
const frameRegistry = new Map();
// Stable logical-N allocation. tabId → Map<chromeFrameId, logicalN>. Unlike
// frameRegistry (rebuilt every descent), this PERSISTS for the tab's life so a
// given OOPIF keeps the SAME `fN` across snapshots — otherwise a frame added or
// reordered between two descents (ad refresh, SPA churn, the auto-snapshot
// replay) would re-map `f1:` to a different frame and route a carried-forward
// ref into the wrong realm (invariant #10). Numbers only ever grow; entries are
// never individually removed (so N stays unique per frame), only cleared on tab
// close. See allocFrameNumber.
const frameNumbers = new Map();
const indicatorState = new Map(); // tabId → {state, agentLabel}
const indicatorInjected = new Set(); // tabIds where inject/indicator.js has been pushed
const tabGroupRegistry = new Map(); // windowId → Map<agentLabel, groupId>

// `ACTION_KINDS` gates `runWithSettle` wrapping in `dispatch` so DOM-mutating
// actions return only after the page shows a state delta (or after the settle
// timeout). Tab-group colour does NOT vary by in-flight state any more — see
// `GROUP_COLOR` below.
const ACTION_KINDS = new Set([
  "navigate",
  "navigate_back",
  "click",
  "click_xy",
  "draw",
  "type",
  "select_option",
  "hover",
  "scroll",
  "upload",
  "press_key",
  "drag",
  "drop",
]);

try {
  chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  });
} catch (e) {
  console.error("[browser-bg] setAccessLevel failed:", e?.message ?? e);
}

// MV3 service workers are killed after ~30s idle. While an agent might issue
// the next tool call at any moment, we keep the SW alive by firing a
// chrome.alarms heartbeat every 24s — its handler does just enough work to
// keep the worker in the "active" pool. Cost is negligible (one no-op alarm
// fire every 24s). Without this, the first call after idle returns
// "extension not connected" even though everything is healthy.
try {
  chrome.alarms.create("browser-keepalive", { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "browser-keepalive") return;
    // Touch a chrome.* API and the WS so both stay warm. Errors are silent —
    // a bad alarm should never break the worker.
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch {}
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    } catch {}
  });
} catch (e) {
  console.error("[browser-bg] keepalive setup failed:", e?.message ?? e);
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
    return runWithSettle(req, () => dispatchInner(req));
  }
  return dispatchInner(req);
}

// ─── settle observer ────────────────────────────────────────────────
//
// After an action lands in the page, install a brief observer and resolve the
// command response only once the page has shown a signal of having processed
// the action — OR after a short timeout, whichever fires first. This is what
// stops the "click returned but nothing visibly happened → agent re-fires it
// → double-submit" failure mode (see Issue #1 in the 2026-05-14 report).
const SETTLE_KINDS = new Set([
  "click",
  "click_xy",
  "draw",
  "type",
  "select_option",
  "hover",
  "scroll",
  "upload",
  "press_key",
  "drag",
  "drop",
]);

async function runWithSettle(req, exec) {
  const c = req.command;
  const tabId = req.tabId;
  const settle = c.settle;
  // navigate / navigate_back / tabs_create run their own bespoke settle
  // (tabs.onUpdated complete). We only install the generic observer for
  // in-page action kinds.
  if (!settle || settle.mode === "none" || !SETTLE_KINDS.has(c.kind)) {
    const out = await exec();
    return out;
  }
  // Start the watcher BEFORE the action so we don't miss the first event for
  // very-fast pages. Both promises race against the timeout.
  const watcher = watchSettle(tabId, settle).catch(() => null);
  const t0 = Date.now();
  const out = await exec();
  const settled = await watcher;
  const elapsed = Date.now() - t0;
  const settledVia = settled ?? { via: "timeout", elapsedMs: elapsed };
  if (out && typeof out === "object") {
    return { ...out, settled: settledVia };
  }
  return { result: out, settled: settledVia };
}

async function watchSettle(tabId, opts) {
  const timeout = opts.timeout ?? 1500;
  if (opts.mode === "dom") {
    return watchDomSettle(tabId, timeout);
  }
  if (opts.mode === "network") {
    return watchNetworkSettle(tabId, timeout);
  }
  if (opts.mode === "selector" && opts.selector) {
    return watchSelectorSettle(tabId, opts.selector, timeout);
  }
  return null;
}

async function watchDomSettle(tabId, timeout) {
  const t0 = Date.now();
  // Inject a tiny one-shot observer in the page; resolve when it fires once.
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (ms) =>
        new Promise((resolve) => {
          const start = performance.now();
          const finalize = (via) =>
            resolve({ via, elapsedMs: Math.round(performance.now() - start) });
          let done = false;
          const obs = new MutationObserver(() => {
            if (done) return;
            done = true;
            obs.disconnect();
            finalize("dom");
          });
          obs.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
          setTimeout(() => {
            if (done) return;
            done = true;
            try {
              obs.disconnect();
            } catch {}
            finalize("timeout");
          }, ms);
        }),
      args: [timeout],
    });
    return res?.result ?? { via: "timeout", elapsedMs: Date.now() - t0 };
  } catch {
    return { via: "timeout", elapsedMs: Date.now() - t0 };
  }
}

function watchNetworkSettle(tabId, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finalize = (via) => {
      if (done) return;
      done = true;
      try {
        chrome.webRequest.onBeforeRequest.removeListener(onReq);
      } catch {}
      clearTimeout(timer);
      resolve({ via, elapsedMs: Date.now() - t0 });
    };
    // Cast to `any` so TS's chrome.webRequest typings don't insist on a
    // BlockingResponse return — we never opt into blocking mode (no
    // "blocking" in extraInfoSpec), so a void listener is safe at runtime.
    // The cast at the declaration site covers all three references below
    // (removeListener + two addListener overloads).
    const onReq = /** @type {any} */ ((details) => {
      if (details.tabId === tabId) finalize("network");
    });
    try {
      chrome.webRequest.onBeforeRequest.addListener(onReq, {
        urls: ["<all_urls>"],
        tabId,
      });
    } catch {
      // tabId-scoped filter not supported in this Chrome; fall back to all and
      // filter in callback.
      chrome.webRequest.onBeforeRequest.addListener(onReq, {
        urls: ["<all_urls>"],
      });
    }
    const timer = setTimeout(() => finalize("timeout"), timeout);
  });
}

// Service-worker-side sustained-network-idle watcher for `browser_wait_for`'s
// networkIdle mode. The page-side helper (`actWaitFor`) has no network visibility
// — only the SW sees `chrome.webRequest` — so this is the ONLY correct home for
// it. Resolves once the tab has had no in-flight requests AND no new request
// activity for `IDLE_MS`, or times out. Always a result object (never throws),
// matching the selector/condition branches' shape. The three listeners are
// call-scoped and removed in cleanup so concurrent/back-to-back waits never leak.
function runWaitForNetworkIdle(tabId, c) {
  const IDLE_MS = 500; // "no network activity for 500ms" — the documented bar.
  const timeout = c.timeout ?? 10_000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Counts only requests that START after the listeners attach — a request
    // already in flight at call time isn't seen (webRequest has no "pending
    // snapshot"), so a page mid-fetch when the wait begins can read idle a touch
    // early. Acceptable: the common use is waiting on requests an action just
    // triggered, which are all caught. Pair with a selector/condition when a
    // specific in-flight response must land.
    let inFlight = 0;
    let lastActivityAt = Date.now();
    let done = false;

    // Cast to `any` so TS's chrome.webRequest typings don't insist on a
    // BlockingResponse return — we never opt into blocking mode.
    const onStart = /** @type {any} */ ((details) => {
      if (details.tabId !== tabId) return;
      inFlight++;
      lastActivityAt = Date.now();
    });
    const onEnd = /** @type {any} */ ((details) => {
      if (details.tabId !== tabId) return;
      if (inFlight > 0) inFlight--;
      lastActivityAt = Date.now();
    });

    const addFilter = (event, cb) => {
      try {
        event.addListener(cb, { urls: ["<all_urls>"], tabId });
      } catch {
        // tabId-scoped filter not supported in this Chrome; fall back to all
        // and filter in the callback (the `details.tabId !== tabId` guard above).
        event.addListener(cb, { urls: ["<all_urls>"] });
      }
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      try {
        chrome.webRequest.onBeforeRequest.removeListener(onStart);
      } catch {}
      try {
        chrome.webRequest.onCompleted.removeListener(onEnd);
      } catch {}
      try {
        chrome.webRequest.onErrorOccurred.removeListener(onEnd);
      } catch {}
      resolve(result);
    };

    addFilter(chrome.webRequest.onBeforeRequest, onStart);
    addFilter(chrome.webRequest.onCompleted, onEnd);
    addFilter(chrome.webRequest.onErrorOccurred, onEnd);

    const poll = setInterval(() => {
      const now = Date.now();
      if (inFlight === 0 && now - lastActivityAt >= IDLE_MS) {
        finish({ idle: true, elapsedMs: now - t0 });
      } else if (now - t0 >= timeout) {
        finish({
          idle: false,
          elapsedMs: now - t0,
          reason: "network did not idle within timeout",
        });
      }
    }, 100);
  });
}

async function watchSelectorSettle(tabId, selector, timeout) {
  const t0 = Date.now();
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (sel, ms) =>
        new Promise((resolve) => {
          const start = performance.now();
          const finalize = (via) =>
            resolve({
              via,
              elapsedMs: Math.round(performance.now() - start),
              selector: sel,
            });
          if (document.querySelector(sel)) return finalize("selector");
          const obs = new MutationObserver(() => {
            if (document.querySelector(sel)) {
              obs.disconnect();
              finalize("selector");
            }
          });
          obs.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
          });
          setTimeout(() => {
            try {
              obs.disconnect();
            } catch {}
            finalize("timeout");
          }, ms);
        }),
      args: [selector, timeout],
    });
    return res?.result ?? { via: "timeout", elapsedMs: Date.now() - t0 };
  } catch {
    return { via: "timeout", elapsedMs: Date.now() - t0 };
  }
}

async function dispatchInner(req) {
  const c = req.command;
  const tabId = req.tabId;
  switch (c.kind) {
    case "tabs_query":
      return queryTabs(c.query);
    case "get_focused_tab":
      return getFocusedTab();
    case "tabs_create":
      return createTab(c.url, c.background !== false, c.settle);
    case "tabs_remove":
      return removeTab(c.tabId);
    case "navigate":
      return navigate(tabId, c.url, c.waitUntil, c.settle);
    case "navigate_back":
      return navigateBack(tabId, c.settle);
    case "snapshot_capture":
      return doSnapshotCapture(tabId, c);
    case "annotate_image":
      return doAnnotateImage(c);
    case "console_messages":
      return getConsole(tabId, c.limit ?? 50, c.cursor);
    case "network_requests":
      return getNetwork(tabId, {
        limit: c.limit ?? 50,
        cursor: c.cursor,
        urlPattern: c.urlPattern,
        type: c.type,
        methodIn: c.methodIn,
        statusGte: c.statusGte,
        statusLt: c.statusLt,
      });
    case "click":
      return runHelper(tabId, "click", c);
    case "click_xy":
      return dispatchTrustedClick(tabId, c.x, c.y, c);
    case "draw":
      return dispatchTrustedStroke(tabId, c.points, c);
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
    case "drag":
      return runHelper(tabId, "drag", c);
    case "drop":
      return runHelper(tabId, "drop", c);
    case "press_key":
      return c.trusted
        ? dispatchTrustedKey(tabId, c.key, c.modifiers)
        : runHelper(tabId, "press_key", c);
    case "evaluate":
      return runEvaluate(tabId, c.expression, c.timeout);
    case "clipboard":
      return runClipboard(tabId, c);
    case "resolve_ref":
      return runResolveRef(tabId, c.ref);
    case "set_focus_emulation":
      return setFocusEmulation(tabId, c.enabled);
    case "resize":
      return setResize(tabId, c.width, c.height);
    case "handle_dialog":
      return setDialogHandler(tabId, c);
    case "bring_to_front":
      return bringToFront(tabId);
    case "wait_for":
      // Route condition-mode through chrome.debugger Runtime.evaluate so the
      // predicate runs as the debugger (bypassing strict-CSP sites like Suno/
      // ChatGPT that block `new Function()` in injected scripts). Selector and
      // pure-timeout modes stay in helpers.js — they don't use eval.
      if (c.condition) return runWaitForCondition(tabId, c);
      // networkIdle has no page-side signal (helpers.js can't see network) —
      // route to the SW-side sustained-idle watcher. Selector/pure-timeout
      // modes stay in helpers.js.
      if (c.networkIdle) return runWaitForNetworkIdle(tabId, c);
      return runHelper(tabId, "wait_for", c);
    default:
      throw new Error(`unknown command: ${c.kind}`);
  }
}

// ─── chrome.tabs operations ─────────────────────────────────────────

async function queryTabs(query) {
  const tabs = await chrome.tabs.query({});
  const mapped = tabs.map((t) => ({
    id: t.id,
    url: t.url ?? "",
    title: t.title ?? "",
    windowId: t.windowId,
    active: !!t.active,
  }));
  if (!query) return mapped;
  // Case-insensitive substring match against title OR url. Mirrors the
  // bridge-side `browser_list_tabs` query schema description so the agent's
  // mental model holds.
  const q = String(query).toLowerCase();
  return mapped.filter(
    (t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q),
  );
}

async function getFocusedTab() {
  try {
    const [t] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!t) return null;
    return { id: t.id, title: t.title ?? "", url: t.url ?? "" };
  } catch {
    return null;
  }
}

async function createTab(url, background, settle) {
  const previousActiveTab = await getFocusedTab();
  const tab = await chrome.tabs.create({ url, active: !background });
  // Wait for status:complete before returning so the agent sees the actual
  // loaded URL/title — not the empty placeholder from before the load fires.
  const settled = await waitForTabComplete(tab.id, 15_000).catch(() => null);
  const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
  const requested = url || "";
  const landed = fresh.url ?? "";
  // navigated:true if the loaded URL bears any relationship to the requested
  // URL (same origin+path prefix or full equality). For SPA roots that catch
  // a path into a hash route, we still consider that navigated.
  const navigated = urlsLookLikeMatch(requested, landed);
  return {
    id: fresh.id,
    url: landed,
    title: fresh.title ?? "",
    windowId: fresh.windowId,
    active: !!fresh.active,
    navigated,
    settledAt: Date.now(),
    settled: settled ?? { via: "timeout", elapsedMs: 15_000 },
    previousActiveTab,
  };
}

function urlsLookLikeMatch(requested, landed) {
  if (!landed) return false;
  if (!requested) return true;
  if (requested === landed) return true;
  try {
    const a = new URL(requested);
    const b = new URL(landed);
    if (a.origin !== b.origin) return false;
    // Path-prefix match handles trailing-slash normalisation, hash-only diffs
    // and most SPA routers' catch-all behaviours.
    return b.pathname.startsWith(a.pathname) || a.pathname.startsWith(b.pathname);
  } catch {
    return false;
  }
}

async function removeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function navigate(tabId, url, waitUntil, _settle) {
  // url omitted → reload the current tab. tabs.reload preserves the entry in
  // session history (vs. a fresh navigate, which would clobber it).
  const t0 = Date.now();
  if (!url) {
    await chrome.tabs.reload(tabId);
  } else {
    await chrome.tabs.update(tabId, { url });
  }
  if (waitUntil === "load") await waitForTabComplete(tabId);
  else await waitForTabDomReady(tabId);
  const fresh = await chrome.tabs.get(tabId).catch(() => null);
  return {
    navigated: url ?? "reload",
    url: fresh?.url ?? "",
    title: fresh?.title ?? "",
    // Uniform settle shape across all action tools (README/CLAUDE.md claim
    // this universally) — the "via" here is the load-complete event, not the
    // generic in-page settle observer used by click/type/etc.
    settled: { via: waitUntil === "load" ? "load" : "domcontentloaded", elapsedMs: Date.now() - t0 },
  };
}

async function navigateBack(tabId, _settle) {
  const t0 = Date.now();
  await chrome.tabs.goBack(tabId);
  await waitForTabDomReady(tabId);
  const fresh = await chrome.tabs.get(tabId).catch(() => null);
  return {
    ok: true,
    url: fresh?.url ?? "",
    title: fresh?.title ?? "",
    settled: { via: "domcontentloaded", elapsedMs: Date.now() - t0 },
  };
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

/**
 * Unified atomic capture: walks the a11y tree and/or captures the screenshot
 * in a single hop. Avoids the layout-shift race that two sequential round
 * trips would have on hydration-heavy SPAs (Suno/ChatGPT). chrome.debugger
 * attach is amortised — at most one attach/detach cycle per call.
 */
async function doSnapshotCapture(tabId, opts) {
  // cssViewport (window.innerWidth/Height in CSS pixels) is only meaningful
  // when there's a tree-derived rect list to scale against the captured
  // bitmap. We surface it exclusively via the tree-root (`__mcpA11y` sets
  // `root.cssViewport`) — the only caller that ever needs it is
  // `annotate_image`, which never runs without a fresh tree on the same call.
  // For a tree-less capture (`withTree:false`), cssViewport is omitted; piping
  // a tree-less shot into annotate would be a misuse the bridge already disallows.

  // Round 7: hide the extension's HUD (pill + agent-activity panel + viewport
  // glow) during the capture hop. CSS rules in inject/indicator.js use
  // :host-context([data-browser-capturing="1"]) so the bridge can flip this
  // wholesale. ALWAYS clear in finally — a leaked attribute would keep the
  // pill invisible for the user.
  if (opts.withScreenshot) await setCaptureAttribute(tabId, true);
  try {
    const result = {};
    if (opts.withTree) {
      await ensureHelpers(tabId);
      const [exec] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: () => globalThis.__mcpA11y?.(),
      });
      const tree = exec?.result ?? { role: "WebArea", children: [], depth: 0 };
      result.tree = tree;
      result.cssViewport =
        tree && typeof tree === "object" && tree.cssViewport
          ? tree.cssViewport
          : { w: 0, h: 0 };
      // Phase 4b: opt-in cross-origin OOPIF descent. The main-frame walk leaves
      // each cross-origin frame as a marked leaf; here we walk those frames in
      // their own realm (executeScript reaches them via the <all_urls> host
      // permission), namespace their refs `fN:`, lift their rects to the top
      // viewport, and splice their subtrees in. Non-fatal: a descent failure
      // must never sink the base snapshot.
      if (opts.includeCrossOriginFrames && tree && typeof tree === "object") {
        try {
          await descendCrossOriginFrames(tabId, tree);
        } catch (e) {
          console.error(
            "[browser-bg] descendCrossOriginFrames failed:",
            e?.message ?? e,
          );
        }
      }
    }
    if (opts.withScreenshot) {
      result.screenshot = await captureScreenshot(tabId, opts);
    }
    return result;
  } finally {
    if (opts.withScreenshot) await setCaptureAttribute(tabId, false);
  }
}

// ─── Phase 4b: cross-origin OOPIF descent (Branch-EXEC) ─────────────
//
// Spike-validated (CYB136E SANS): chrome.scripting.executeScript({frameIds})
// runs the injected func in a cross-origin frame's OWN realm — the <all_urls>
// host permission grants it. So we observe + drive cross-origin OOPIFs by
// reusing the SAME page-side helpers (no CDP child sessions).
//
// Algorithm: getAllFrames → for each cross-origin frame, walk it with __mcpA11y,
// then splice its subtree under the matching cross-origin LEAF the main walk
// left behind. The leaf's rect is ALREADY the iframe element's top-viewport
// border-box (the parent walk computed it), so it doubles as the child's
// top-viewport offset — no per-frame geometry round trip needed (content-box
// border assumed ~0, true for content/SCORM iframes). Nesting works because we
// loop in rounds: descending frame 278 creates the subtree whose leaf frame 280
// then matches, and so on. Each descended frame gets a 1-based logical N — the
// `fN:` ref namespace — recorded in frameRegistry for later action routing.
function originOfUrl(u) {
  try {
    return new URL(u).origin;
  } catch {
    return "null";
  }
}

function frameUrlMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // The iframe `src` and getAllFrames `url` can diverge by a trailing fragment
  // or resolved query; a prefix match either direction is a safe tie.
  return a.startsWith(b) || b.startsWith(a);
}

// Stable per-tab logical-N for a chrome frameId — same frame → same `fN` for
// the tab's life (see frameNumbers). Never reuses a number for a different
// frame, so a carried-forward `fN:` ref can't silently re-point.
function allocFrameNumber(tabId, frameId) {
  let nums = frameNumbers.get(tabId);
  if (!nums) {
    nums = new Map();
    frameNumbers.set(tabId, nums);
  }
  let n = nums.get(frameId);
  if (n === undefined) {
    n = nums.size + 1;
    nums.set(frameId, n);
  }
  return n;
}

// Find the first not-yet-descended cross-origin leaf whose frameUrl matches.
function findCrossOriginLeaf(node, url) {
  if (!node || typeof node !== "object") return null;
  if (node.crossOrigin && !node.frameDescended && frameUrlMatches(node.frameUrl, url))
    return node;
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findCrossOriginLeaf(c, url);
      if (hit) return hit;
    }
  }
  return null;
}

// Recursively namespace ids → `fN:id`, lift rects by (dx,dy) to top-viewport,
// and re-base depths so the spliced subtree is continuous under the leaf.
function rebaseSubtree(node, n, dx, dy, ddepth) {
  if (node.nodeId !== undefined) node.nodeId = `f${n}:${node.nodeId}`;
  if (node.rect) {
    node.rect.x += dx;
    node.rect.y += dy;
  }
  node.depth = (node.depth || 0) + ddepth;
  if (Array.isArray(node.children))
    for (const c of node.children) rebaseSubtree(c, n, dx, dy, ddepth);
}

async function descendCrossOriginFrames(tabId, mainTree) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    return;
  }
  if (!frames || !frames.length) return;
  const mainOrigin = originOfUrl(frames.find((f) => f.frameId === 0)?.url || "");
  // Candidate frames to descend: every non-main frame whose origin differs from
  // the top document (same-origin frames are already inline from the main walk).
  const pending = frames.filter(
    (f) => f.frameId !== 0 && originOfUrl(f.url) !== mainOrigin,
  );
  const registry = new Map();
  if (!mainTree.frames) mainTree.frames = [];
  // Rounds: a frame can only splice once its parent's subtree is present, so we
  // re-sweep until a full pass makes no progress.
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i];
      // Leaf↔frame correlation is by URL only (the page-side walk records the
      // iframe `src`, not Chrome's frameId). When two cross-origin iframes share
      // a src (e.g. two copies of the same widget) this can't tell them apart —
      // a known limitation; they're spliced in document order, which is usually
      // (not provably) right. parentFrameId-scoped correlation would need the
      // walk to emit frameIds, a larger change deferred until a real duplicate
      // shows up.
      const leaf = findCrossOriginLeaf(mainTree, f.url);
      if (!leaf) continue; // parent not descended yet (or no matching leaf)
      pending.splice(i, 1);
      i--;
      progressed = true;
      let sub;
      try {
        await ensureHelpers(tabId, f.frameId);
        const [exec] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [f.frameId] },
          func: () => globalThis.__mcpA11y?.(),
        });
        sub = exec?.result;
      } catch (e) {
        // Non-fatal: leave `sub` undefined so the not-descended fallback below
        // fires. The failure is visible to the agent as meta.frames[].descended
        // staying false for this frame.
      }
      // Fail-fast: a frame we couldn't inject into (CSP/sandbox/detached) or that
      // returned nothing is NOT descended — leave it as a `crossOrigin` leaf so
      // the serializer still prints "not descended" and the agent keeps the
      // browser_click_xy fallback. Marking it descended here would be a failure
      // masquerading as success.
      if (!sub || !Array.isArray(sub.children) || !sub.children.length) {
        continue;
      }
      const logicalN = allocFrameNumber(tabId, f.frameId);
      registry.set(logicalN, f.frameId);
      const dx = leaf.rect?.x || 0;
      const dy = leaf.rect?.y || 0;
      const ddepth = leaf.depth || 0;
      for (const child of sub.children) {
        rebaseSubtree(child, logicalN, dx, dy, ddepth);
        leaf.children.push(child);
      }
      // Success: flip the boundary marker (drop `crossOrigin`, set
      // `frameDescended`) and reconcile the meta.frames log entry to reality.
      leaf.frameDescended = true;
      delete leaf.crossOrigin;
      const logEntry = mainTree.frames.find((e) => frameUrlMatches(e.url, f.url));
      if (logEntry) logEntry.descended = true;
      else mainTree.frames.push({ url: f.url, descended: true });
    }
  }
  frameRegistry.set(tabId, registry);
}

async function setCaptureAttribute(tabId, on) {
  // Non-fatal: a chrome:// or PDF tab can't accept scripting; we still want
  // the capture to proceed.
  //
  // Stays in the default ISOLATED world — a plain documentElement attribute
  // write needs no MAIN-world access, and keeping it isolated avoids both
  // CSP exposure on strict-CSP sites AND any MutationObserver race the page
  // could otherwise observe. The indicator script lives in the same isolated
  // context; the attribute it sets is on documentElement (page-side DOM)
  // which both worlds share regardless.
  //
  // No rAF-based paint wait — agent tabs are backgrounded (focus-emulation can
  // lift the throttle, but this path never assumes it) and Chrome throttles
  // requestAnimationFrame to ~0 fps in background tabs, so a double-rAF wait
  // would hang for seconds (or forever on a fully-discarded tab). The CDP
  // `Page.captureScreenshot` call below triggers its own paint pass internally,
  // picking up the visibility:hidden style invalidation as part of that pass.
  // Empirically sufficient for hiding the HUD; no synchronisation needed bridge-side.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (v) => {
        try {
          document.documentElement.setAttribute(
            "data-browser-capturing",
            v ? "1" : "0",
          );
        } catch {}
      },
      args: [on],
    });
  } catch (e) {
    console.error("[browser-bg] setCaptureAttribute failed:", e?.message ?? e);
  }
}

// executeScript target: a specific child frame when frameId is given (Phase 4b
// cross-origin descent), else the main frame. `frameIds` and `allFrames` are
// mutually exclusive in the chrome.scripting API, so we pick one.
function scriptTarget(tabId, frameId) {
  return frameId
    ? { tabId, frameIds: [frameId] }
    : { tabId, allFrames: false };
}

// Ref grammar (mirrors src/snapshot/ref.ts, kept tiny + dependency-free here).
// "5" → main frame, local id "5"; "f2:5" → logical frame 2, local id "5".
function parseFrameRef(ref) {
  const s = String(ref);
  const m = /^f(\d+):(.+)$/.exec(s);
  if (m) return { frameN: Number(m[1]), localId: m[2] };
  return { frameN: 0, localId: s };
}

// Resolve a (possibly `fN:`-namespaced) action to a chrome frameId + rewritten
// opts whose ref fields carry the bare local id the frame's nodeMap knows. A
// ref pointing at a frame with no live registry entry (no cross-origin snapshot
// taken, or the frame navigated away) routes to the main frame and will surface
// a clean "ref not found" from the page-side helper rather than a silent no-op.
function routeFrameAction(tabId, opts) {
  if (!opts || opts.ref === undefined) return { frameId: undefined, opts };
  const { frameN, localId } = parseFrameRef(opts.ref);
  if (frameN === 0) return { frameId: undefined, opts };
  const chromeFrameId = frameRegistry.get(tabId)?.get(frameN);
  if (chromeFrameId === undefined) return { frameId: undefined, opts };
  // Rewrite ref (and targetRef, for same-frame drag) to bare local ids.
  const routed = { ...opts, ref: localId };
  if (opts.targetRef !== undefined) {
    const tgt = parseFrameRef(opts.targetRef);
    // A drag whose source and target live in different frames is impossible
    // (DataTransfer can't cross realms). Fail fast — blindly stripping the
    // target's namespace would dispatch into the SOURCE frame against an
    // unrelated local id (a silent wrong-target drop).
    if (tgt.frameN !== frameN)
      throw new Error(
        `cross-frame drag is not supported: source ref "${opts.ref}" and target ref "${opts.targetRef}" are in different frames`,
      );
    routed.targetRef = tgt.localId;
  }
  return { frameId: chromeFrameId, opts: routed };
}

async function ensureHelpers(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frameId),
    files: ["inject/helpers.js"],
  });
}

async function captureScreenshot(tabId, opts) {
  // chrome.debugger Page.captureScreenshot — does NOT raise the window.
  await debuggerAttach(tabId);
  try {
    const format = opts.format ?? "jpeg";
    const quality = opts.quality ?? 70;
    const params = {
      format,
      ...(format === "jpeg" ? { quality } : {}),
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
    let dataBase64 = result.data;
    let resized = null;
    // No-annotation path resize lives here (we won't make a second hop to
    // annotate_image). The annotated path resizes inside doAnnotateImage so
    // the badge math sees the already-scaled canvas.
    if (opts.maxWidth) {
      try {
        const out = await resizeImageBase64(
          dataBase64,
          format,
          quality,
          opts.maxWidth,
        );
        if (out) {
          dataBase64 = out.dataBase64;
          resized = { width: out.width, height: out.height };
        }
      } catch (e) {
        console.error(
          `[browser-bg] screenshot resize failed; returning native:`,
          e?.message ?? e,
        );
      }
    }
    return {
      format,
      dataBase64,
      ...(resized ? { resizedTo: resized } : {}),
    };
  } finally {
    debuggerDetachLater(tabId);
  }
}

async function resizeImageBase64(b64, format, quality, maxWidth) {
  // Service workers don't have <img>, but they do have createImageBitmap +
  // OffscreenCanvas. Both are available on MV3 service worker context.
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const bmp = await createImageBitmap(blob);
  if (bmp.width <= maxWidth) {
    bmp.close?.();
    return null; // no need to resize
  }
  const scale = maxWidth / bmp.width;
  const w = maxWidth;
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const outBlob = await canvas.convertToBlob({
    type: mime,
    ...(format === "jpeg" ? { quality: quality / 100 } : {}),
  });
  const buf = new Uint8Array(await outBlob.arrayBuffer());
  let bin2 = "";
  for (let i = 0; i < buf.length; i++) bin2 += String.fromCharCode(buf[i]);
  return { dataBase64: btoa(bin2), width: w, height: h };
}

/**
 * Stateless image-in / image-out overlay. Decodes the supplied base64, then
 * optionally resizes (FIRST — keeps badge font readable at low maxWidth) and
 * scales the CSS-pixel rect list to canvas coordinates via
 * `imgW / cssViewport.w` (and `imgH / cssViewport.h`), draws bounding boxes
 * + numeric ref badges, and re-encodes.
 *
 * Runs entirely in the privileged service-worker context (OffscreenCanvas),
 * so it never inherits the page's CSP and never injects scripts.
 */
async function doAnnotateImage(c) {
  const mime = c.format === "jpeg" ? "image/jpeg" : "image/png";
  const bin = atob(c.imageBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  let bmp = await createImageBitmap(blob);
  let resizedTo = null;

  let imgW = bmp.width;
  let imgH = bmp.height;

  // Resize FIRST, then annotate. Badge font is a constant 12px regardless of
  // maxWidth so it stays readable at high downscale ratios.
  if (c.maxWidth && bmp.width > c.maxWidth) {
    const resizeRatio = c.maxWidth / bmp.width;
    imgW = c.maxWidth;
    imgH = Math.round(bmp.height * resizeRatio);
    resizedTo = { width: imgW, height: imgH };
  }

  // Scale derives directly from final canvas dimensions vs. CSS viewport.
  // DPR drops out because it's baked into both quantities identically —
  // whichever resize path ran above, scale is correct because it's derived
  // from the actual final canvas dimensions, not from a prediction of them.
  // Defensive: identity scale when cssViewport is missing — keeps the badge
  // layer from crashing if the helpers ever return a synthetic root (no
  // document.body) or the bridge sends an empty fallback. Logs once per call
  // so the failure path leaves a breadcrumb instead of silently mis-scaling.
  const haveCss =
    c.cssViewport && c.cssViewport.w > 0 && c.cssViewport.h > 0;
  if (!haveCss) {
    console.error(
      "[browser-bg] annotate_image: cssViewport missing or zero; falling back to identity scale (badges may land near origin). Check helpers.js injection.",
    );
  }
  const cssW = haveCss ? c.cssViewport.w : imgW;
  const cssH = haveCss ? c.cssViewport.h : imgH;
  const scaleX = imgW / cssW;
  const scaleY = imgH / cssH;

  const canvas = new OffscreenCanvas(imgW, imgH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, imgW, imgH);
  bmp.close?.();

  ctx.font = c.constants.BADGE_FONT;
  ctx.textBaseline = "top";

  for (const { ref, rect, drawStroke } of c.rects) {
    // Scale CSS-pixel rect to canvas pixels and clip to canvas bounds.
    let left = Math.round(rect.x * scaleX);
    let top = Math.round(rect.y * scaleY);
    let right = Math.round((rect.x + rect.w) * scaleX);
    let bottom = Math.round((rect.y + rect.h) * scaleY);
    left = Math.max(0, Math.min(left, imgW));
    top = Math.max(0, Math.min(top, imgH));
    right = Math.max(0, Math.min(right, imgW));
    bottom = Math.max(0, Math.min(bottom, imgH));
    // Skip tiny elements (offscreen/clipped to near-zero post-clamp).
    if (right - left < c.constants.MIN_ANNOTATABLE_PX) continue;
    if (bottom - top < c.constants.MIN_ANNOTATABLE_PX) continue;
    // Bounding box. `drawStroke:false` means this rect is a parent of another
    // annotated rect — the bridge's containment pass suppresses the giant
    // outer stroke. The badge always draws (below) so the agent can still
    // target the parent. Default-true for backward compat if the bridge ever
    // sends rects without the flag.
    if (drawStroke !== false) {
      // For odd stroke widths, offset by half a pixel so the stroke aligns
      // to a single pixel row (the canonical anti-blur trick). For even
      // widths, no offset is needed. Formula handles both so a future bump
      // of BBOX_STROKE_WIDTH doesn't introduce blurry edges.
      ctx.strokeStyle = c.constants.BBOX_STROKE;
      ctx.lineWidth = c.constants.BBOX_STROKE_WIDTH;
      const halfStroke = (c.constants.BBOX_STROKE_WIDTH % 2) / 2;
      ctx.strokeRect(
        left + halfStroke,
        top + halfStroke,
        right - left,
        bottom - top,
      );
    }
    // Ref badge at the top-left, sitting just above the bbox.
    const text = String(ref);
    const tw = Math.ceil(ctx.measureText(text).width);
    const th = 12; // matches BADGE_FONT size; OffscreenCanvas doesn't expose ascent reliably
    const padding = c.constants.BADGE_PADDING;
    const badgeW = tw + padding * 2;
    const badgeH = th + padding * 2;
    let badgeX = left;
    let badgeY = top - badgeH - c.constants.BADGE_OFFSET_Y;
    if (badgeY < 0) badgeY = 0;
    ctx.fillStyle = c.constants.BADGE_FILL;
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
    ctx.fillStyle = c.constants.BADGE_TEXT_COLOR;
    ctx.fillText(text, badgeX + padding, badgeY + padding);
  }

  const outBlob = await canvas.convertToBlob({
    type: mime,
    ...(c.format === "jpeg" ? { quality: (c.quality ?? 70) / 100 } : {}),
  });
  const buf = new Uint8Array(await outBlob.arrayBuffer());
  let outBin = "";
  for (let i = 0; i < buf.length; i++) outBin += String.fromCharCode(buf[i]);
  return {
    format: c.format,
    dataBase64: btoa(outBin),
    ...(resizedTo ? { resizedTo } : {}),
  };
}

const attached = new Set();
const detachTimers = new Map();
// Idle backstop: how long the debugger stays attached after the last debugger
// action before auto-detaching. Long enough that active automation never trips
// it (so the "started debugging" infobar stays steady across a lease instead of
// flickering per action), short enough that an orphaned attachment — daemon
// death, dropped `released` edge, force-revoke leftover — self-heals. The clean
// path is detach-on-lease-release (see applyIndicatorState); this is the safety net.
const DETACH_IDLE_MS = 180_000;
// Tabs flagged for CDP focus-emulation (see setFocusEmulation / invariant #27).
// Lives in SW state, NOT debugger state, so it survives a detach (the idle
// backstop or a lease release) — debuggerAttach re-asserts emulation for these
// tabs on every fresh attach, keeping rAF live across any attach/detach churn.
const focusEmulated = new Set();
// Tabs with an active viewport override (see setResize / browser_resize).
// tabId → {width, height}. Same SW-state-not-debugger-state model as
// focusEmulated: Emulation.setDeviceMetricsOverride is session-scoped (clears on
// detach), so debuggerAttach re-asserts it on every fresh attach for tabs in
// this map. Cleared on tab-close.
const deviceMetrics = new Map();
// Tabs with an armed native-dialog auto-responder (see setDialogHandler /
// browser_handle_dialog). tabId → {disposition, promptText?, lifetime}. Same
// SW-state-not-debugger-state model as focusEmulated/deviceMetrics: the Map
// survives the attach/detach churn. Cleared on tab-close, on explicit
// `clear:true`, and (for `lifetime:"one_shot"`) after the next dialog fires.
// Invariant #35: Page.* is enabled UNCONDITIONALLY on every debugger-attached
// tab (debuggerAttach asserts Page.enable on every fresh attach), so the
// global `Page.javascriptDialogOpening` listener catches every native dialog;
// an entry in this Map decides the disposition (accept vs dismiss +
// promptText), and the listener safe-defaults to DISMISS when no entry is
// armed — no tool can block on a native confirm/prompt/alert/beforeunload.
const dialogDispositions = new Map();

function sendDebuggerCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (r) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else resolve(r);
    });
  });
}

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
        // Re-assert any session-scoped CDP overrides this tab is flagged for on
        // this fresh attach — focus-emulation (invariant #27) and/or the viewport
        // override (browser_resize). Both are debugger-session-scoped, so the
        // prior session's overrides were lost on detach; re-applying here (and
        // resolving only after they complete) means the action that triggered
        // this attach runs with rAF live AND the viewport already resized. A
        // re-assert failure must not break the attach, so we always resolve.
        //
        // Safe-default Page.enable: subscribed unconditionally on every fresh
        // attach so the global `Page.javascriptDialogOpening` listener fires
        // for ANY native dialog — armed disposition wins when set, otherwise
        // auto-DISMISS by default. Guarantees no tool can block on a native
        // confirm/prompt/alert/beforeunload even when the debugger is attached
        // for an unrelated reason (focus-emulation, viewport override,
        // screenshot, evaluate). See invariant #35.
        const reasserts = [
          sendDebuggerCommand(tabId, "Page.enable").catch(() => {}),
        ];
        if (focusEmulated.has(tabId)) reasserts.push(assertFocusEmulation(tabId, true));
        if (deviceMetrics.has(tabId)) reasserts.push(assertDeviceMetrics(tabId));
        Promise.all(reasserts).then(
          () => resolve(),
          () => resolve(),
        );
      }
    });
  });
}

/** Apply CDP focus-emulation. Assumes the debugger is already attached. */
async function assertFocusEmulation(tabId, enabled) {
  await sendDebuggerCommand(tabId, "Emulation.setFocusEmulationEnabled", {
    enabled,
  });
  // Focus-emulation flips the page to visible+focused, but an occluded tab is
  // still not composited, so rAF only resumes to a ~10fps fallback. Moving the
  // page to the "active" lifecycle state lifts rAF to full rate and wakes a
  // long-backgrounded (frozen) tab — enough for canvas SPAs (Sheets/Figma) to
  // render selection/scroll/menus faithfully. Only on enable; the disable path
  // reverts this override by detaching the debugger (debuggerDetachNow), which
  // clears it atomically — we never set "frozen" (CDP offers only
  // "active"/"frozen", neither of which is the natural state, so prompt detach
  // is the correct clean revert).
  if (enabled) {
    await sendDebuggerCommand(tabId, "Page.setWebLifecycleState", {
      state: "active",
    });
  }
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
    }, DETACH_IDLE_MS),
  );
}

/**
 * Detach the debugger immediately, cancelling any pending deferred detach.
 * Detaching is the only atomic way to clear ALL session-scoped CDP overrides
 * (focus-emulation AND the Page.setWebLifecycleState{active} lifecycle override)
 * in one step — used by the focus-emulation disable path so the tab cleanly
 * resumes Chrome's natural background throttling/freezing.
 *
 * Does NOT clear the `focusEmulated` Set — that flag is the caller's concern.
 * The disable path clears it BEFORE detaching so the re-assert-on-attach hook
 * won't revive emulation; any future caller that detaches a still-flagged tab
 * will see emulation re-asserted on the next attach (by design).
 */
function debuggerDetachNow(tabId) {
  const t = detachTimers.get(tabId);
  if (t) {
    clearTimeout(t);
    detachTimers.delete(tabId);
  }
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // swallow — detach can race tab-close/external-detach
      attached.delete(tabId);
      resolve();
    });
  });
}

/**
 * Toggle CDP focus-emulation on a tab so rAF runs in the occluded background
 * tab without raising the window. The `focusEmulated` Set persists the intent
 * across the attach/detach churn (debuggerAttach re-asserts on every fresh
 * attach). No focus theft — the OS window is never raised.
 */
async function setFocusEmulation(tabId, enabled) {
  if (tabId == null) throw new Error("set_focus_emulation requires a tabId");
  // Clear the flag BEFORE attaching on disable so a concurrent fresh attach
  // doesn't re-assert emulation we're about to turn off.
  if (!enabled) focusEmulated.delete(tabId);
  await debuggerAttach(tabId);
  try {
    await assertFocusEmulation(tabId, enabled);
    if (enabled) focusEmulated.add(tabId);
  } finally {
    // Enable: arm the idle backstop (debuggerDetachLater) instead of detaching —
    // each subsequent debugger action resets it, so the debugger stays attached
    // for the lease and the infobar holds steady. Disable: detach NOW — the
    // Page.setWebLifecycleState{active} override from a prior enable is
    // session-scoped and only lifts on detach, so a prompt detach is the clean
    // revert that lets the tab resume natural background throttling/freezing.
    if (enabled) debuggerDetachLater(tabId);
    else await debuggerDetachNow(tabId);
  }
  return { focusEmulation: enabled };
}

// ─── trusted CDP coordinate / key input (invariant #34) ─────────────
//
// Page-side synthetic events (helpers.js::__mcpAct) are the DEFAULT — they reach
// the page's JS model for the vast majority of UI without a debugger attach. A
// minority of widgets need REAL browser input: those that gate on
// `event.isTrusted` (custom switches, signature canvases, some media players), or
// interactions that need true coordinate hit-testing through overlays/iframes
// (where there's no ref to target). CDP `Input.*` is the sanctioned escalation
// for exactly those cases. Each trusted dispatch auto-asserts focus-emulation
// first so a backgrounded/occluded tab composites + hit-tests at the dispatched
// coordinates (without raising the window) — otherwise the hit-test can miss.

// CDP modifier bitfield (Input.dispatch*Event `modifiers`): Alt=1, Ctrl=2,
// Meta/Cmd=4, Shift=8. Accepts the same human modifier names browser_press_key
// already takes.
const CDP_MODIFIER_BITS = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8,
};
// Mouse button → CDP `buttons` bitfield (left=1, right=2, middle=4).
const CDP_BUTTON_BITS = { left: 1, right: 2, middle: 4 };
// Modifier name → the modifier key's own event fields, so a real keydown for the
// held modifier precedes the main key (browser shortcuts like Ctrl+A need the
// actual modifier key events, not just the bitfield).
const CDP_MODIFIER_KEYS = {
  alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  command: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  cmd: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};
// Non-printable keys → CDP key-event fields so the browser performs the key's
// DEFAULT action (Enter submits, Tab moves focus, arrows scroll/navigate). A
// single printable character is handled generically by `keyEventFields` and
// needs no entry here.
const CDP_KEY_DEFS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Esc: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Space: { code: "Space", keyCode: 32, text: " " },
};

function cdpModifierBits(names) {
  let m = 0;
  for (const n of names || []) m |= CDP_MODIFIER_BITS[String(n).toLowerCase()] || 0;
  return m;
}

// CDP `code` for a printable character (best-effort; the page rarely depends on
// it once `text` is set, but a correct code keeps KeyboardEvent.code faithful).
function printableCode(ch) {
  if (/^[a-zA-Z]$/.test(ch)) return "Key" + ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return "Digit" + ch;
  return "";
}

// Build the shared key-event fields (key/code/text/virtual-key-code) for a
// key name. Special keys come from CDP_KEY_DEFS; a single printable char is
// derived generically; an unknown multi-char name falls back to `key`-only.
/**
 * @param {string} key
 * @returns {{ key: string, text?: string, code?: string, windowsVirtualKeyCode?: number, nativeVirtualKeyCode?: number }}
 */
function keyEventFields(key) {
  const def = CDP_KEY_DEFS[key];
  if (def) {
    return {
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      ...(def.text ? { text: def.text } : {}),
    };
  }
  if ([...key].length === 1) {
    // VK code coincides with the ASCII code point for A–Z / 0–9 (correct); for
    // punctuation it's the code point, not the OEM virtual-key code — harmless
    // because `text` drives character insertion, and a page keying off `keyCode`
    // for a punctuation SHORTCUT is vanishingly rare. Add an OEM map here if that
    // ever matters.
    const kc = key.toUpperCase().codePointAt(0);
    return {
      key,
      text: key,
      code: printableCode(key),
      windowsVirtualKeyCode: kc,
      nativeVirtualKeyCode: kc,
    };
  }
  return { key };
}

// Auto-assert focus-emulation so an occluded background tab reads as focused —
// needed before a trusted coordinate/key dispatch (composite + hit-test at the
// point) AND before a clipboard op (read/write both require document focus) —
// all without raising the window. Idempotent: flag the tab in `focusEmulated` so
// the attach hook keeps re-asserting it for the lease, and the lease-release
// detach (applyIndicatorState) owns teardown. Only attaches + asserts once per tab.
async function ensureFocusEmulated(tabId) {
  if (tabId == null) throw new Error("focus-emulation requires a tabId");
  await debuggerAttach(tabId);
  if (!focusEmulated.has(tabId)) {
    await assertFocusEmulation(tabId, true);
    focusEmulated.add(tabId);
  }
  // Keep the debugger held for the lease — each call resets the idle backstop,
  // same model as runEvaluate/setFocusEmulation.
  debuggerDetachLater(tabId);
}

async function dispatchTrustedClick(tabId, x, y, opts) {
  await ensureFocusEmulated(tabId);
  const button = opts?.button || "left";
  const clickCount = opts?.clickCount || 1;
  const modifiers = cdpModifierBits(opts?.modifiers);
  const buttons = CDP_BUTTON_BITS[button] || 1;
  // Move first so hover state + the element under the point resolve correctly.
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    modifiers,
  });
  // Press/release pairs with an incrementing clickCount — Chromium derives
  // dblclick/tripleclick from clickCount on consecutive same-point events. The
  // browser emits `contextmenu` natively for a right-button pair.
  for (let i = 1; i <= clickCount; i++) {
    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons,
      clickCount: i,
      modifiers,
    });
    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: i,
      modifiers,
    });
  }
  return { clicked: { x, y }, trusted: true, button, clickCount };
}

async function dispatchTrustedKey(tabId, key, modifierNames) {
  await ensureFocusEmulated(tabId);
  const mods = (modifierNames || []).map((m) => String(m).toLowerCase());
  const modBits = cdpModifierBits(mods);
  const modKeys = mods.map((m) => CDP_MODIFIER_KEYS[m]).filter(Boolean);
  // Hold modifier keys down first so real browser shortcuts fire (Ctrl+A,
  // Shift+Tab) — the bitfield alone makes the page see event.ctrlKey but
  // doesn't always trigger the browser's own handling.
  for (const mk of modKeys) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: mk.key,
      code: mk.code,
      windowsVirtualKeyCode: mk.keyCode,
      nativeVirtualKeyCode: mk.keyCode,
      modifiers: modBits,
    });
  }
  const ev = { ...keyEventFields(key), modifiers: modBits };
  // With a NON-Shift modifier held (Ctrl/Alt/Meta) the keystroke is a COMMAND,
  // not text entry — and Chromium suppresses the browser command path for a
  // keyDown that carries `text`. Strip `text` so Ctrl+A / Ctrl+C / Meta-shortcuts
  // fire as real commands. Shift-only keeps `text` (Shift+printable is still a
  // character). Bits: Alt=1, Ctrl=2, Meta=4 (Shift=8 is intentionally excluded).
  const COMMAND_MODIFIER_BITS = 1 | 2 | 4;
  if (modBits & COMMAND_MODIFIER_BITS) delete ev.text;
  // `keyDown` (vs `rawKeyDown`) is required to emit the `input`/`textInput` that
  // a printable character produces; non-text keys (and command keystrokes, above)
  // use rawKeyDown.
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: ev.text ? "keyDown" : "rawKeyDown",
    ...ev,
  });
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...ev,
  });
  for (const mk of [...modKeys].reverse()) {
    await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: mk.key,
      code: mk.code,
      windowsVirtualKeyCode: mk.keyCode,
      nativeVirtualKeyCode: mk.keyCode,
      modifiers: 0,
    });
  }
  return { pressed: key, trusted: true };
}

async function dispatchTrustedStroke(tabId, points, opts) {
  if (!Array.isArray(points) || points.length < 2)
    throw new Error("draw requires at least 2 points");
  await ensureFocusEmulated(tabId);
  const button = opts?.button || "left";
  const buttons = CDP_BUTTON_BITS[button] || 1;
  const p0 = points[0];
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: p0.x,
    y: p0.y,
    button: "none",
    buttons: 0,
  });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: p0.x,
    y: p0.y,
    button,
    buttons,
    clickCount: 1,
  });
  for (let i = 1; i < points.length; i++) {
    await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: points[i].x,
      y: points[i].y,
      button,
      buttons,
    });
  }
  const last = points[points.length - 1];
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: last.x,
    y: last.y,
    button,
    buttons: 0,
    clickCount: 1,
  });
  return { drew: { points: points.length } };
}

/** Apply the tracked viewport override. Assumes the debugger is already attached. */
async function assertDeviceMetrics(tabId) {
  const m = deviceMetrics.get(tabId);
  if (!m) return;
  await sendDebuggerCommand(tabId, "Emulation.setDeviceMetricsOverride", {
    width: m.width,
    height: m.height,
    // 0 = use the host's natural device-scale-factor (don't override DPR — this
    // is a pure viewport resize, not a device emulation).
    deviceScaleFactor: 0,
    mobile: false,
  });
}

/**
 * Resize the leased tab's viewport via CDP Emulation.setDeviceMetricsOverride —
 * no window raise, no focus theft (debugger-scoped, same model as focus-
 * emulation). STICKY per-tab: the dimensions are stored in `deviceMetrics` and
 * re-asserted on every fresh attach (debuggerAttach), so the override survives
 * any attach/detach churn. The idle backstop (debuggerDetachLater) is reset by
 * each subsequent debugger action, so the debugger stays attached for the lease
 * and tree-only snapshots still see the resized layout. Clears on tab-close;
 * persists across focus-emulation toggles (which detach the debugger —
 * re-asserted on the next attach).
 */
async function setResize(tabId, width, height) {
  if (tabId == null) throw new Error("resize requires a tabId");
  deviceMetrics.set(tabId, { width, height });
  await debuggerAttach(tabId);
  try {
    await assertDeviceMetrics(tabId);
  } finally {
    debuggerDetachLater(tabId);
  }
  return { resized: { width, height } };
}

/**
 * Pre-arm or clear the auto-response for the leased tab's next native JS
 * dialog. On arming, stores the disposition in SW state; the global
 * `chrome.debugger.onEvent` listener (registered at module load) intercepts
 * `Page.javascriptDialogOpening` and consults this Map to pick accept vs
 * dismiss + promptText. `Page.enable` is asserted unconditionally on every
 * fresh debugger attach (debuggerAttach), so a dialog never falls through:
 * an armed disposition wins, otherwise the listener's safe-default DISMISS
 * fires so the page can't block the next agent tool call.
 *
 * Clearing just removes the entry — the listener auto-dismisses subsequent
 * dialogs by default, no Page.disable hop needed.
 */
async function setDialogHandler(tabId, params) {
  if (tabId == null) throw new Error("handle_dialog requires a tabId");
  if (params.clear) {
    dialogDispositions.delete(tabId);
    return { dialogHandler: null };
  }
  // Arm. lifetime defaults to one_shot — the common case is "I'm about to
  // click a button that triggers a confirm; auto-accept just the next one".
  const lifetime = params.lifetime ?? "one_shot";
  dialogDispositions.set(tabId, {
    disposition: params.disposition,
    promptText: params.promptText,
    lifetime,
  });
  await debuggerAttach(tabId);
  try {
    // Page.enable is now applied by debuggerAttach unconditionally (safe-default
    // covers every debugger-attached tab — invariant #35), so arming just needs
    // the attach itself.
  } finally {
    // Lifetime-aware detach. one_shot: arming the idle backstop
    // (debuggerDetachLater) is fine — the typical pattern is `arm → click →
    // dialog fires immediately`, well inside the lease, and the re-assert hook
    // revives `Page.enable` on the next action's attach if the dialog comes
    // later. STICKY: DO NOT defer-detach. Sticky-ACCEPT
    // promises "auto-accept every dialog this tab fires until I clear" —
    // including dialogs fired by the page itself (timers, network responses,
    // beforeunload), not just dialogs triggered by an agent action. If the
    // debugger detaches while sticky is armed, page-driven dialogs fall
    // through to the safe-default auto-dismiss — wrong answer for an explicit
    // sticky-accept. Keeping the debugger attached for the duration of sticky
    // preserves the user's stated disposition. Cost: the "started debugging
    // this browser" infobar stays visible the whole time — matches
    // `browser_activate_tab(level:"render")`'s posture.
    if (lifetime === "one_shot") debuggerDetachLater(tabId);
  }
  return {
    dialogHandler: {
      disposition: params.disposition,
      ...(params.promptText !== undefined ? { promptText: params.promptText } : {}),
      lifetime,
    },
  };
}

// Global Page.* event listener — fires for ALL debugger sessions on ALL tabs.
// Page.enable is now issued unconditionally on every fresh debugger attach
// (debuggerAttach), so this listener catches Page.javascriptDialogOpening for
// ANY native dialog the tab fires while the debugger is attached for any
// reason (handle_dialog arming, focus-emulation, viewport override, screenshot,
// evaluate, wait_for). Behaviour:
//   - Armed disposition wins: per the entry in `dialogDispositions`
//     (accept/dismiss + optional promptText). `lifetime:"one_shot"` removes the
//     entry after firing once.
//   - No arm → safe-default DISMISS (`accept:false`) so the page never blocks.
//     Without this, Chrome does NOT apply background-tab auto-dismiss while the
//     debugger is attached and Page.* is enabled, and the dialog would wait
//     indefinitely for a CDP answer — wedging the next agent tool call
//     (invariant #35).
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.javascriptDialogOpening") return;
  const tabId = source.tabId;
  if (tabId == null) return;
  const arm = dialogDispositions.get(tabId);
  // Safe-default: when no disposition is armed, DISMISS so the page never
  // blocks on a native dialog.
  const accept = arm ? arm.disposition === "accept" : false;
  // promptText only meaningful when accepting a `prompt` dialog. Pass it only
  // on accept so a dismiss never carries text the page might still inspect.
  const handleParams = arm && accept && arm.promptText !== undefined
    ? { accept, promptText: arm.promptText }
    : { accept };
  if (arm && arm.lifetime === "one_shot") {
    // Remove BEFORE issuing handle so a back-to-back dialog from the same tab
    // doesn't get auto-answered by a stale disposition.
    dialogDispositions.delete(tabId);
  }
  void sendDebuggerCommand(tabId, "Page.handleJavaScriptDialog", handleParams)
    .catch((e) =>
      console.error(
        "[browser-bg] Page.handleJavaScriptDialog failed:",
        e?.message ?? e,
      ),
    );
});

/**
 * The ONLY sanctioned focus-theft in the codebase (invariant #29): raises the
 * real OS window and activates the tab. Captures the prior foreground first so
 * the agent can restore it. Everything else stays background per invariants
 * #1/#2 — prefer setFocusEmulation (no raise) for rAF/canvas rendering needs.
 */
async function bringToFront(tabId) {
  if (tabId == null) throw new Error("bring_to_front requires a tabId");
  const previousActiveTab = await getFocusedTab();
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return { broughtToFront: true, windowId: tab.windowId, previousActiveTab };
}

// ─── interaction helpers ────────────────────────────────────────────

async function runHelper(tabId, kind, opts) {
  const { frameId, opts: routedOpts } = routeFrameAction(tabId, opts);
  await ensureHelpers(tabId, frameId);
  // The acting-HUD indicator deliberately stays on the TOP document even when
  // the action routes into a child frame — it belongs to the tab, not the OOPIF.
  await ensureIndicatorInjected(tabId);
  const [result] = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frameId),
    func: (k, o) => globalThis.__mcpAct(k, o),
    args: [kind, routedOpts],
  });
  return result?.result;
}

// Read-only liveness probe — resolves a single ref against the page-side ref
// map, returning element metadata while it's attached or null once gone. Not
// an ACTION_KIND (no settle, no indicator); the bridge calls it to confirm an
// out-of-snapshot ref is still live before firing an action against it.
async function runResolveRef(tabId, ref) {
  const { frameN, localId } = parseFrameRef(ref);
  let frameId;
  if (frameN) {
    frameId = frameRegistry.get(tabId)?.get(frameN);
    // A cross-origin ref whose frame has no live registry entry (no descend
    // snapshot this turn, or the frame navigated away) genuinely can't be
    // resolved. Probing the main frame with the bare local id would
    // false-positive against an unrelated element and let a stale action
    // through — so report not-found and let the bridge surface nearby refs.
    if (frameId === undefined) return null;
  }
  await ensureHelpers(tabId, frameId);
  const [result] = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frameId),
    func: (r) => globalThis.__mcpResolveRef(r),
    args: [localId],
  });
  return result?.result ?? null;
}

// ─── indicator (in-page + tab-group) ────────────────────────────────

async function applyIndicatorState(tabId, state) {
  if (tabId == null) return { ok: false };
  if (state.state === "released") {
    indicatorState.delete(tabId);
    // Clean lease release ends the debugger hold immediately so the "started
    // debugging" infobar clears at once (fire-and-forget — must not block the
    // indicator/tab-group update; debuggerDetachNow is safe when not attached).
    // A force-revoke handover emits leased→leased (never `released`), so the
    // tab's debugger correctly stays attached across the handover.
    void debuggerDetachNow(tabId);
  } else indicatorState.set(tabId, state);
  await Promise.allSettled([
    pushIndicatorToPage(tabId, state),
    updateTabGroup(tabId, state),
  ]);
  return { ok: true };
}

async function pushIndicatorToPage(tabId, state) {
  if (!(await canInject(tabId))) return;
  try {
    await ensureIndicatorInjected(tabId);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: (s) => globalThis.__mcpIndicator?.set?.(s),
      args: [state],
    });
  } catch (e) {
    console.error(
      `[browser-bg] pushIndicatorToPage(${tabId}) failed:`,
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
        func: (s) => globalThis.__mcpIndicator?.set?.(s),
        args: [cached],
      });
    }
  } catch (e) {
    console.error(
      `[browser-bg] ensureIndicatorInjected(${tabId}) failed:`,
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

// Chrome's `chrome.tabGroups` colour API accepts only a fixed preset enum
// (`grey | blue | red | yellow | green | pink | purple | cyan | orange`) —
// internal RGB mappings are baked into Chromium's Skia tab-strip rendering and
// not exposed to extensions. `"pink"` is the closest match to the in-page
// indicator's brand pink. Always-pink — no idle/acting variation; the in-page
// action ripple + agent-activity log already convey "stuff is happening"
// without needing the tab-strip chrome to flicker.
const GROUP_COLOR = "pink";

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
    // Brand prefix is host-controlled via `BROWSER_EXTENSION_TAB_GROUP_LABEL`
    // env var on the daemon. The daemon stamps it onto every IndicatorState.
    // Defaults to "Automation" for the generic MCP build; Earthling sets it to
    // "Earthling" so the user-visible group title reads "Earthling — <agent>".
    const brand = state.tabGroupBrand || "Automation";
    const title = label ? `${brand} — ${label}` : brand;
    await chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR });
  } catch (e) {
    console.error("[browser] updateTabGroup failed:", e?.message ?? e);
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

async function runWaitForCondition(tabId, c) {
  // CSP-safe replacement for helpers.js::actWaitFor condition mode. The
  // helper's `new Function(predicate)` path is rejected by `script-src`
  // directives that omit 'unsafe-eval' (Suno, ChatGPT, banks). Routing the
  // predicate through chrome.debugger Runtime.evaluate runs it in the page's
  // JS context but as the debugger, bypassing CSP entirely.
  //
  // We attach the debugger ONCE around the whole poll loop instead of letting
  // each `runEvaluate` call attach/schedule-detach. With a 5-min max timeout,
  // the per-eval attach would keep Chrome's "started debugging this browser"
  // infobar pinned to the schema-max duration after the wait completes.
  const startedAt = Date.now();
  const deadline = startedAt + (c.timeout ?? 10_000);
  const pollMs = c.pollIntervalMs ?? 250;
  // Wrap in an IIFE so the agent can pass either an expression ("a+b") or a
  // statement block — matches helpers.js semantics.
  const expression = `(function(){ return (${c.condition}); })()`;
  let lastValue;
  let lastError;
  await debuggerAttach(tabId);
  try {
    const evalOnce = async () => {
      try {
        const result = await new Promise((resolve, reject) => {
          chrome.debugger.sendCommand(
            { tabId },
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true, userGesture: false },
            (r) => {
              if (chrome.runtime.lastError)
                reject(new Error(chrome.runtime.lastError.message));
              else resolve(r);
            },
          );
        });
        if (result?.exceptionDetails) {
          const ex = result.exceptionDetails;
          throw new Error(ex.exception?.description || ex.text || "evaluation failed");
        }
        const v = result?.result?.value;
        lastValue = v;
        return v;
      } catch (e) {
        lastError = e?.message ?? String(e);
        return undefined;
      }
    };
    const v0 = await evalOnce();
    if (v0) return { met: true, value: v0, elapsedMs: 0 };
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const v = await evalOnce();
      if (v) return { met: true, value: v, elapsedMs: Date.now() - startedAt };
    }
    return {
      met: false,
      value: lastValue,
      error: lastError
        ? `predicate threw: ${lastError}`
        : "predicate did not become truthy within timeout",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    debuggerDetachLater(tabId);
  }
}

// ─── clipboard data channel (invariant #38) ─────────────────────────
//
// Canvas-based spreadsheet/document/slide apps keep their content in a <canvas>,
// not the DOM, so the a11y walk sees nothing — but the clipboard does. The agent uses a
// trusted Ctrl+C/Ctrl+V to move the selection on/off the OS clipboard; these two
// helpers carry the STRUCTURED payload across.
//
// READ runs in the extension's ISOLATED content-script world, where
// `execCommand('paste')` is gated by the manifest `clipboardRead` permission — NOT
// the page's `clipboard-read`, which Chrome leaves at `prompt` for a backgrounded
// tab and silently resolves empty for (so page-realm `navigator.clipboard.read`
// is useless here). The page is never granted clipboard-read; the privileged read
// lives only in our own content script on the leased tab.
//
// WRITE runs `navigator.clipboard.write` in the page's MAIN world via the
// debugger's Runtime.evaluate — NOT chrome.scripting.executeScript. The async
// Clipboard write API requires TRANSIENT USER ACTIVATION; without it the promise
// never settles (it hangs forever on a backgrounded tab — no rejection), and
// executeScript has no way to supply a gesture. Runtime.evaluate's
// `userGesture:true` is the only injection path that grants activation. The
// debugger is already attached by ensureFocusEmulated, so this adds no new
// surface. The payload travels as JSON literals embedded in the expression — the
// sanctioned safe serialization (JSON.stringify escapes everything, plus a
// U+2028/U+2029 guard for the two chars that are valid in JSON but are raw line
// terminators inside a JS string literal). clipboard-WRITE needs no manifest
// permission (it is granted for a focused secure context).
//
// Both first assert focus-emulation: a backgrounded tab must read as focused for
// either op to succeed (the no-window-raise rendering aid, invariant #27).

async function clipboardRead(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function pasteInto(el) {
        el.style.position = "fixed";
        el.style.left = "-9999px";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        try {
          document.execCommand("paste");
        } catch (e) {}
      }
      const ta = document.createElement("textarea");
      pasteInto(ta);
      const text = ta.value;
      ta.remove();
      const ce = document.createElement("div");
      ce.contentEditable = "true";
      pasteInto(ce);
      const html = ce.innerHTML;
      ce.remove();
      return { text, html };
    },
  });
  return result ?? { text: "", html: "" };
}

// Embed a value as a JS string/JSON literal safe for an `expression` string.
// JSON.stringify handles all escaping except U+2028/U+2029, which are legal in
// JSON but are raw line terminators inside a JS string literal (syntax error).
function jsLiteral(value) {
  return JSON.stringify(value)
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u" + "2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u" + "2029");
}

async function clipboardWrite(tabId, text, html) {
  const expression = `(async () => {
    const text = ${jsLiteral(text)};
    const html = ${jsLiteral(html ?? null)};
    const parts = { "text/plain": new Blob([text], { type: "text/plain" }) };
    if (html != null) parts["text/html"] = new Blob([html], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return true;
  })()`;
  const r = await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        timeout: 5000,
      },
      (res) => {
        if (chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      },
    );
  });
  if (r?.exceptionDetails) {
    const ex = r.exceptionDetails;
    throw new Error(
      `clipboard write failed: ${ex.exception?.description || ex.text || "unknown error"}`,
    );
  }
  return { written: r?.result?.value === true };
}

async function runClipboard(tabId, c) {
  await ensureFocusEmulated(tabId);
  if (c.op === "write") return clipboardWrite(tabId, c.text, c.html);
  return clipboardRead(tabId);
}

async function runEvaluate(tabId, expression, timeout) {
  // Use chrome.debugger Runtime.evaluate — runs in the page's JS context but as the debugger,
  // so it bypasses the page's CSP (which would otherwise reject `new Function()` on strict sites
  // like chatgpt.com). Attach is reused if already held (debuggerAttach is idempotent).
  await debuggerAttach(tabId);
  const startedAt = Date.now();
  try {
    const params = {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    };
    // CDP's own execution timeout: aborts the in-page promise on expiry rather
    // than leaving a runaway async loop running unsupervised after the call
    // returns. Only set when the agent asked for it — without it the behaviour
    // (and the daemon's ~30s watchdog) is unchanged.
    if (timeout && timeout > 0) params.timeout = timeout;
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId },
        "Runtime.evaluate",
        params,
        (r) => {
          if (chrome.runtime.lastError)
            reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        },
      );
    });
    if (result?.exceptionDetails) {
      const ex = result.exceptionDetails;
      const elapsedMs = Date.now() - startedAt;
      const desc = ex.exception?.description || ex.text || "";
      // Distinguish a CDP timeout-abort from a genuine in-page error: when a
      // timeout was set and we either reached it or CDP signalled a timeout,
      // return a clean {timed_out} result the agent can act on (raise timeout,
      // or split into bounded steps) instead of a confusing thrown error.
      // The CDP-message regex is the PRIMARY signal (fires regardless of how
      // small the timeout is). The elapsed-time backup only applies for
      // timeouts > 500ms — below that, `timeout - 250` is at/below zero, so the
      // elapsed check would be trivially true and would misreport a genuine
      // immediate error (ReferenceError/SyntaxError) as a timeout. For small
      // timeouts we rely on the regex alone.
      const timedOut =
        timeout &&
        timeout > 0 &&
        ((timeout > 500 && elapsedMs >= timeout - 250) ||
          /timed out|Promise was collected/i.test(desc));
      if (timedOut) {
        return {
          timed_out: true,
          elapsedMs,
          hint: `evaluate aborted after ${elapsedMs}ms (timeout ${timeout}ms) — raise timeout or run one bounded step per call`,
        };
      }
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

// Each buffered request gets a monotonic per-tab `seq` so cursor pagination
// can address "everything older than this seq". Console messages get the same
// treatment for consistency.
const networkSeq = new Map(); // tabId → next seq
const consoleSeq = new Map(); // tabId → next seq

function paginate(buf, limit, cursor) {
  // Cursor is the seq of the OLDEST item already-returned in a prior call;
  // we return items strictly older than cursor for "page back" behaviour, or
  // newest-first slice when cursor is missing.
  let pool = buf;
  if (cursor) {
    const c = Number(cursor);
    if (!Number.isNaN(c)) pool = buf.filter((e) => e.seq < c);
  }
  // Newest-first slice
  const items = pool.slice(-limit);
  const truncated = pool.length > items.length;
  const next_cursor = truncated && items.length > 0 ? String(items[0].seq) : undefined;
  return { items, truncated, next_cursor };
}

const DEFAULT_NETWORK_TYPES = new Set([
  "xmlhttprequest",
  "fetch",
  "document",
]);

function filterNetwork(buf, opts) {
  const typeFilter = opts.type && opts.type.length ? new Set(opts.type) : DEFAULT_NETWORK_TYPES;
  const methodFilter =
    opts.methodIn && opts.methodIn.length ? new Set(opts.methodIn) : null;
  let urlMatcher = null;
  if (opts.urlPattern) {
    const p = opts.urlPattern;
    if (p.startsWith("/") && p.lastIndexOf("/") > 0) {
      const last = p.lastIndexOf("/");
      try {
        urlMatcher = new RegExp(p.slice(1, last), p.slice(last + 1));
      } catch {
        urlMatcher = { test: (s) => s.includes(p) };
      }
    } else {
      urlMatcher = { test: (s) => s.includes(p) };
    }
  }
  return buf.filter((e) => {
    if (!typeFilter.has(e.type)) return false;
    if (methodFilter && !methodFilter.has(e.method)) return false;
    if (urlMatcher && !urlMatcher.test(e.url)) return false;
    if (opts.statusGte !== undefined && e.status < opts.statusGte) return false;
    if (opts.statusLt !== undefined && e.status >= opts.statusLt) return false;
    return true;
  });
}

function getConsole(tabId, limit, cursor) {
  const buf = consoleBuffers.get(tabId) ?? [];
  const page = paginate(buf, limit, cursor);
  return {
    count: page.items.length,
    items: page.items,
    truncated: page.truncated,
    ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
  };
}

function getNetwork(tabId, opts) {
  const buf = networkBuffers.get(tabId) ?? [];
  const filtered = filterNetwork(buf, opts);
  const page = paginate(filtered, opts.limit ?? 50, opts.cursor);
  return {
    count: page.items.length,
    items: page.items,
    truncated: page.truncated,
    ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
  };
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const buf = networkBuffers.get(details.tabId) ?? [];
    const seq = (networkSeq.get(details.tabId) ?? 0) + 1;
    networkSeq.set(details.tabId, seq);
    buf.push({
      seq,
      method: details.method,
      url: details.url,
      status: details.statusCode,
      type: details.type,
      ts: details.timeStamp,
    });
    // Buffer 500 entries (up from 200) so cursor pagination can page back
    // through more history before falling off the end.
    if (buf.length > 500) buf.splice(0, buf.length - 500);
    networkBuffers.set(details.tabId, buf);
  },
  { urls: ["<all_urls>"] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  indicatorState.delete(tabId);
  indicatorInjected.delete(tabId);
  focusEmulated.delete(tabId);
  deviceMetrics.delete(tabId);
  dialogDispositions.delete(tabId);
  frameRegistry.delete(tabId);
  frameNumbers.delete(tabId);
  // Chrome auto-detaches the debugger when the tab closes, so we don't call
  // chrome.debugger.detach here — just clear our in-memory state (cancelling any
  // pending idle-backstop timer) so a closed tab leaves no stale entry behind.
  const detachTimer = detachTimers.get(tabId);
  if (detachTimer) {
    clearTimeout(detachTimer);
    detachTimers.delete(tabId);
  }
  attached.delete(tabId);
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
