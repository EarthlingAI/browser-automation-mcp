/**
 * In-page agent-presence indicator. Idempotent.
 *
 * Layered visuals, all sandboxed in a Shadow-DOM root attached to documentElement:
 *   - composite favicon halo (layer A, page side)
 *   - viewport-edge glow (layer B)
 *   - click ripple + caret flash (layer C)
 *   - HUD pill + collapsible action log (layer D)
 *
 * Driven by:
 *   - globalThis.__mcpIndicator.set({state, agentLabel})  ← extension push on lease edges
 *   - globalThis.__mcpIndicator.onAction({phase, kind, ref})  ← helpers.js per-action edges
 */

(() => {
  if (globalThis.__mcpIndicator?.teardown) {
    try {
      globalThis.__mcpIndicator.teardown();
    } catch {}
  }

  // Brand pink — matches `palette.primary.600` (#D5477E) from the host brand
  // palette and aligns with Chrome's `"pink"` tab-group preset for visual
  // continuity between the tab strip and the in-page overlay. The same rgb
  // triple drives every accent in this overlay: viewport-edge glow, pill
  // border + hover shadow, ripple/outline strokes, panel border, constellation
  // gradient stops, and favicon halo. Change here = change everywhere.
  const BRAND = "213, 71, 126";
  const ACTING_LINGER_MS = 600;
  const LOG_CAP = 50;
  const RELEASED_FADE_MS = 3000;
  const DEFAULT_AGENT_NAME = "Automation";

  const SHADOW_CSS = `
:host, * { box-sizing: border-box; }
.hidden { display: none !important; }

/*
 * Round 7: hide the entire HUD (pill + panel) and viewport glow during
 * screenshot capture so the agent's annotated picture isn't cluttered with
 * the extension's own UI. The bridge flips data-browser-capturing on
 * <html> around the snapshot_capture hop; :host-context() matches when an
 * ancestor of the shadow host (here <html>) carries the attribute.
 */
:host-context([data-browser-capturing="1"]) .hud,
:host-context([data-browser-capturing="1"]) .glow {
  visibility: hidden !important;
}

.glow {
  position: fixed; inset: 0; pointer-events: none;
  animation: pulse 2.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: inset 0 0 40px 4px rgba(${BRAND}, 0.18); }
  50% { box-shadow: inset 0 0 56px 8px rgba(${BRAND}, 0.30); }
}

.ripple {
  position: fixed; width: 8px; height: 8px;
  border: 2px solid rgba(${BRAND}, 0.85);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  animation: ripple 500ms ease-out forwards;
  pointer-events: none;
}
@keyframes ripple {
  0% { width: 8px; height: 8px; opacity: 0.9; }
  100% { width: 64px; height: 64px; opacity: 0; }
}

.outline {
  position: fixed;
  border: 2px solid rgba(${BRAND}, 0.85);
  border-radius: 4px;
  pointer-events: none;
  animation: outline-fade 500ms ease-out forwards;
}
@keyframes outline-fade {
  from { opacity: 1; }
  to { opacity: 0; }
}

.hud {
  position: fixed;
  right: 20px; bottom: 20px;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  pointer-events: none;
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #fff;
}

.pill {
  pointer-events: auto;
  display: inline-flex; align-items: center; gap: 10px;
  padding: 10px 18px;
  background: #000;
  color: #fff;
  border: 1px solid rgba(${BRAND}, 0.6);
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 4px 18px rgba(0,0,0,0.45), 0 0 0 1px rgba(${BRAND}, 0.08);
  transition: transform 0.2s ease, box-shadow 0.3s ease;
  font: inherit;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.pill:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 22px rgba(0,0,0,0.55), 0 0 0 1px rgba(${BRAND}, 0.18);
}
.pill.released { border-color: rgba(148, 163, 184, 0.6); opacity: 0.7; }
.constellation {
  flex-shrink: 0;
  overflow: visible;
  filter: drop-shadow(0 0 4px rgba(${BRAND}, 0.6));
}
.constellation-group {
  animation: c-spin 3.2s linear infinite;
}
.constellation-edge {
  animation: c-line 1.8s ease-in-out infinite;
}
.constellation-node {
  animation: c-node 1.8s ease-in-out infinite;
}
@keyframes c-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes c-line {
  0%   { stroke-dashoffset: 24;  opacity: 0; }
  30%  { stroke-dashoffset: 0;   opacity: 1; }
  70%  { stroke-dashoffset: 0;   opacity: 1; }
  100% { stroke-dashoffset: -24; opacity: 0; }
}
@keyframes c-node {
  0%, 100% { transform: scale(0.85); opacity: 0.55; }
  50%      { transform: scale(1.15); opacity: 1; }
}

.panel {
  pointer-events: auto;
  width: 320px; max-height: 360px;
  background: #000;
  border: 1px solid rgba(${BRAND}, 0.4);
  border-radius: 10px;
  overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 4px 18px rgba(0,0,0,0.45), 0 0 0 1px rgba(${BRAND}, 0.08);
}
.panel header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  font-weight: 600;
}
.panel .close {
  background: none; border: none; color: #94a3b8;
  font-size: 18px; cursor: pointer; padding: 0 4px;
}
.panel .close:hover { color: #fff; }

.log {
  margin: 0; padding: 4px 0;
  list-style: none;
  overflow-y: auto;
  flex: 1;
}
.log li {
  display: flex; gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.log li.empty {
  justify-content: center; color: #64748b; font-style: italic;
  border: none;
}
.log .when { color: #64748b; min-width: 64px; }
.log .what { color: #e2e8f0; }
`;

  const originalIcons = capturedIcons();

  // One-shot cleanup for tabs that ran an older build which prefixed the title.
  {
    const stripped = document.title.replace(
      /^[●◐◑]\s+Automation\s+[—\-]\s+/u,
      "",
    );
    if (stripped !== document.title) document.title = stripped;
  }

  let state = { state: "released", agentLabel: undefined };
  let acting = false;
  let actingLingerTimer = null;
  let faviconPulseTimer = null;
  let faviconPulsePhase = 0;

  let host, root, glow, hud, pill, panel, panelList;
  let log = [];
  const tabKey = `mcp-log-${location.hostname}-${location.pathname}`;

  buildShadow();
  void hydrateLog();
  watchStorage();

  globalThis.__mcpIndicator = {
    set(next) {
      const prev = state;
      state = next || { state: "released" };
      if (state.state === "leased") onLease();
      else onRelease(prev);
    },
    onAction(evt) {
      if (!evt) return;
      if (evt.phase === "start") onActionStart(evt);
      else if (evt.phase === "end") onActionEnd(evt);
    },
    teardown,
  };

  function buildShadow() {
    host = document.createElement("div");
    host.id = "__mcp_indicator_host__";
    host.style.cssText =
      "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    root.appendChild(style);

    glow = el("div", "glow hidden");
    root.appendChild(glow);

    hud = el("div", "hud hidden");
    pill = el("button", "pill");
    pill.type = "button";
    const text = el("span", "text");
    text.textContent = "Automation";
    pill.appendChild(buildConstellationSvg(18));
    pill.appendChild(text);
    pill.addEventListener("click", togglePanel);
    hud.appendChild(pill);

    panel = el("div", "panel hidden");
    const header = document.createElement("header");
    const headerTitle = document.createElement("span");
    headerTitle.textContent = "Agent activity";
    const closeBtn = el("button", "close");
    closeBtn.title = "Collapse";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", togglePanel);
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    panelList = el("ul", "log");
    panel.appendChild(panelList);
    hud.appendChild(panel);

    root.appendChild(hud);
    renderLog();
  }

  // Three-node triangle with edges that draw in/out in sequence — ported from ui/ConstellationIndicator.
  function buildConstellationSvg(size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("constellation");

    const defs = document.createElementNS(NS, "defs");
    const edgeGrad = document.createElementNS(NS, "linearGradient");
    edgeGrad.setAttribute("id", "mcp-edge");
    edgeGrad.setAttribute("x1", "0");
    edgeGrad.setAttribute("y1", "0");
    edgeGrad.setAttribute("x2", "1");
    edgeGrad.setAttribute("y2", "1");
    appendStop(edgeGrad, "0%", `rgba(${BRAND}, 1)`);
    appendStop(edgeGrad, "100%", `rgba(255, 220, 230, 0.85)`);
    defs.appendChild(edgeGrad);

    const nodeGrad = document.createElementNS(NS, "radialGradient");
    nodeGrad.setAttribute("id", "mcp-node");
    nodeGrad.setAttribute("cx", "0.5");
    nodeGrad.setAttribute("cy", "0.5");
    nodeGrad.setAttribute("r", "0.5");
    appendStop(nodeGrad, "0%", "#fff");
    appendStop(nodeGrad, "100%", `rgba(${BRAND}, 1)`);
    defs.appendChild(nodeGrad);
    svg.appendChild(defs);

    const g = document.createElementNS(NS, "g");
    g.classList.add("constellation-group");
    g.style.transformOrigin = "12px 12px";

    const nodes = [
      [5, 8],
      [19, 8],
      [12, 20],
    ];
    const edges = [
      [nodes[0][0], nodes[0][1], nodes[1][0], nodes[1][1]],
      [nodes[1][0], nodes[1][1], nodes[2][0], nodes[2][1]],
      [nodes[2][0], nodes[2][1], nodes[0][0], nodes[0][1]],
    ];

    edges.forEach(([x1, y1, x2, y2], i) => {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("stroke", "url(#mcp-edge)");
      line.setAttribute("stroke-width", "2.2");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-dasharray", "24");
      line.classList.add("constellation-edge");
      line.style.animationDelay = `${i * 0.6}s`;
      g.appendChild(line);
    });

    nodes.forEach(([cx, cy], i) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "3.4");
      c.setAttribute("fill", "url(#mcp-node)");
      c.classList.add("constellation-node");
      c.style.transformOrigin = `${cx}px ${cy}px`;
      c.style.animationDelay = `${i * 0.25}s`;
      g.appendChild(c);
    });

    svg.appendChild(g);
    return svg;
  }

  function appendStop(parent, offset, color) {
    const NS = "http://www.w3.org/2000/svg";
    const stop = document.createElementNS(NS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    parent.appendChild(stop);
  }

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  // ─── lease state ──────────────────────────────────────────────

  function onLease() {
    setGlow("idle");
    showHud();
    setPillTitle();
    applyFavicon(false);
  }

  function onRelease(prev) {
    setGlow("none");
    actingClear();
    stopFaviconPulse();
    restoreFavicon();
    if (prev && prev.state === "leased") {
      pillReleased();
      setTimeout(() => hideHud(), RELEASED_FADE_MS);
    } else {
      hideHud();
    }
  }

  // ─── action edges ─────────────────────────────────────────────

  function onActionStart(evt) {
    acting = true;
    if (actingLingerTimer) {
      clearTimeout(actingLingerTimer);
      actingLingerTimer = null;
    }
    setGlow("acting");
    startFaviconPulse();
    const target = resolveTarget(evt.ref);
    if (target) {
      if (evt.kind === "click") rippleAt(target.rect);
      if (evt.kind === "type" || evt.kind === "select_option")
        flashOutline(target.rect);
    }
  }

  function onActionEnd(evt) {
    const target = resolveTarget(evt.ref);
    appendLog({
      ts: Date.now(),
      kind: evt.kind,
      ref: evt.ref,
      name: target?.name || "",
      tag: target?.tag || "",
    });
    actingLingerTimer = setTimeout(() => {
      acting = false;
      actingLingerTimer = null;
      stopFaviconPulse();
      if (state.state === "leased") setGlow("idle");
    }, ACTING_LINGER_MS);
  }

  function resolveTarget(ref) {
    if (ref === undefined || ref === null) return null;
    try {
      return globalThis.__mcpResolveRef?.(ref) || null;
    } catch {
      return null;
    }
  }

  // ─── glow ─────────────────────────────────────────────────────

  function setGlow(mode) {
    if (mode === "none") glow.classList.add("hidden");
    else glow.classList.remove("hidden");
  }

  function actingClear() {
    if (actingLingerTimer) {
      clearTimeout(actingLingerTimer);
      actingLingerTimer = null;
    }
    acting = false;
  }

  // ─── ripple + outline ─────────────────────────────────────────

  function rippleAt(rect) {
    const r = el("div", "ripple");
    r.style.left = `${rect.x + rect.w / 2}px`;
    r.style.top = `${rect.y + rect.h / 2}px`;
    root.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }

  function flashOutline(rect) {
    const o = el("div", "outline");
    o.style.left = `${rect.x}px`;
    o.style.top = `${rect.y}px`;
    o.style.width = `${rect.w}px`;
    o.style.height = `${rect.h}px`;
    root.appendChild(o);
    setTimeout(() => o.remove(), 500);
  }

  // ─── HUD pill ─────────────────────────────────────────────────

  function showHud() {
    hud.classList.remove("hidden");
  }

  function hideHud() {
    hud.classList.add("hidden");
    if (panel) panel.classList.add("hidden");
  }

  // Resolve the actor name shown in the pill ("Tab controlled by X" / "Released
  // by X"). Priority:
  //   1. `state.agentLabel` — explicit per-session label from the bridge's
  //      `--agent <label>` flag. Used verbatim ("Tab controlled by Anjuman").
  //   2. `state.tabGroupBrand` — host brand stamped by the daemon from
  //      `BROWSER_EXTENSION_TAB_GROUP_LABEL`. Appended with " Agent" to read
  //      grammatically ("Tab controlled by Earthling Agent"). Skipped when it
  //      equals the generic default so we don't end up saying "Automation Agent".
  //   3. `DEFAULT_AGENT_NAME` — generic fallback ("Tab controlled by Automation").
  function resolveActorName() {
    if (state.agentLabel) return state.agentLabel;
    const brand = state.tabGroupBrand;
    if (brand && brand !== DEFAULT_AGENT_NAME) return `${brand} Agent`;
    return DEFAULT_AGENT_NAME;
  }

  function setPillTitle() {
    pill.querySelector(".text").textContent = `Tab controlled by ${resolveActorName()}`;
    pill.classList.remove("released");
  }

  function pillReleased() {
    pill.querySelector(".text").textContent = `Released by ${resolveActorName()}`;
    pill.classList.add("released");
  }

  function togglePanel() {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) renderLog();
  }

  // ─── action log (persisted) ───────────────────────────────────

  function appendLog(entry) {
    log.push(entry);
    if (log.length > LOG_CAP) log = log.slice(-LOG_CAP);
    persistLog();
    if (panel && !panel.classList.contains("hidden")) renderLog();
  }

  async function hydrateLog() {
    try {
      const got = await chrome.storage.session.get(tabKey);
      const arr = got?.[tabKey];
      if (Array.isArray(arr)) {
        log = arr;
        if (panelList) renderLog();
      }
    } catch {}
  }

  function persistLog() {
    try {
      chrome.storage.session.set({ [tabKey]: log });
    } catch {}
  }

  function watchStorage() {
    try {
      chrome.storage.onChanged?.addListener((changes, area) => {
        if (area !== "session" || !changes[tabKey]) return;
        const v = changes[tabKey].newValue;
        if (Array.isArray(v)) {
          log = v;
          if (panel && !panel.classList.contains("hidden")) renderLog();
        }
      });
    } catch {}
  }

  function renderLog() {
    panelList.textContent = "";
    if (!log.length) {
      const li = el("li", "empty");
      li.textContent = "No actions yet.";
      panelList.appendChild(li);
      return;
    }
    const now = Date.now();
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      const li = el("li");
      const when = el("span", "when");
      when.textContent = relativeTime(now - e.ts);
      const what = el("span", "what");
      what.textContent = formatEntry(e);
      li.appendChild(when);
      li.appendChild(what);
      panelList.appendChild(li);
    }
  }

  function formatEntry(e) {
    const name = e.name ? `"${truncate(e.name, 28)}"` : "";
    switch (e.kind) {
      case "click":
        return `clicked ${name || "element"}`;
      case "type":
        return `typed into ${name || "field"}`;
      case "select_option":
        return `selected option in ${name || "dropdown"}`;
      case "hover":
        return `hovered ${name || "element"}`;
      case "scroll":
        return `scrolled`;
      case "press_key":
        return `pressed key`;
      case "upload":
        return `uploaded file`;
      case "wait_for":
        return `waited`;
      default:
        return e.kind;
    }
  }

  function relativeTime(ms) {
    const s = Math.round(ms / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return `${h}h ago`;
  }

  // ─── favicon halo ─────────────────────────────────────────────

  function startFaviconPulse() {
    if (faviconPulseTimer) return;
    faviconPulseTimer = setInterval(() => {
      faviconPulsePhase++;
      applyFavicon(faviconPulsePhase % 2 === 0);
    }, 600);
  }

  function stopFaviconPulse() {
    if (faviconPulseTimer) {
      clearInterval(faviconPulseTimer);
      faviconPulseTimer = null;
    }
    faviconPulsePhase = 0;
    if (state.state === "leased") applyFavicon(false);
  }

  function capturedIcons() {
    return Array.from(document.querySelectorAll('link[rel~="icon"]')).map(
      (l) => ({ el: l, href: l.getAttribute("href") }),
    );
  }

  async function applyFavicon(invert) {
    const srcLink = pickIconLink();
    if (!srcLink) return;
    try {
      const dataUrl = await composeFavicon(
        srcLink.getAttribute("href") || "",
        invert,
      );
      if (!dataUrl) return;
      srcLink.setAttribute("href", dataUrl);
    } catch {}
  }

  function pickIconLink() {
    let link = document.querySelector('link[rel~="icon"]');
    if (!link) {
      const created = document.createElement("link");
      created.rel = "icon";
      created.href = originalIcons[0]?.href || "/favicon.ico";
      document.head.appendChild(created);
      link = created;
    }
    return link;
  }

  function composeFavicon(src, invert) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const size = 32;
          const c = document.createElement("canvas");
          c.width = size;
          c.height = size;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, size, size);
          ctx.lineWidth = invert ? 4 : 3;
          ctx.strokeStyle = invert
            ? `rgba(${BRAND},0.95)`
            : `rgba(${BRAND},0.85)`;
          ctx.beginPath();
          ctx.arc(size - 7, size - 7, 5, 0, Math.PI * 2);
          ctx.fillStyle = invert
            ? "rgba(255,255,255,0.95)"
            : `rgba(${BRAND},0.95)`;
          ctx.fill();
          ctx.stroke();
          resolve(c.toDataURL("image/png"));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function restoreFavicon() {
    for (const o of originalIcons) {
      if (o.el && o.href !== null) o.el.setAttribute("href", o.href);
    }
  }

  // ─── teardown ─────────────────────────────────────────────────

  function teardown() {
    stopFaviconPulse();
    restoreFavicon();
    host?.remove();
    globalThis.__mcpIndicatorLoaded = false;
  }

  // ─── utils ────────────────────────────────────────────────────

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
})();
