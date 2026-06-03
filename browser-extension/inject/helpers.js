/**
 * In-page helpers. Idempotent — re-running is a no-op.
 *
 * Defines these globals on the page's isolated world (or MAIN, per how the
 * service worker injects this):
 *   - globalThis.__mcpA11y()             → raw a11y tree
 *   - globalThis.__mcpAct(kind, opts)    → click/type/hover/scroll/...
 *   - globalThis.__mcpResolveRef(ref)    → liveness probe for a single ref
 *
 * Refs are stable numeric IDs: a given element keeps the same id across every
 * walk (via a persistent WeakMap) and resolves for as long as it stays
 * attached to the DOM — they are not re-derived per snapshot. The daemon's
 * pruner passes these ids straight through as the `ref` the agent sees.
 */

(() => {
  // Versioned guard. On reinjection (chrome.scripting.executeScript pushes
  // helpers.js on every action call), bail out if the same version is already
  // loaded — preserves the in-page ref maps so refs stay stable and resolvable
  // across an action sequence. Bump the integer when changing the in-page
  // contract (new act kind, return-shape change, ref-identity scheme).
  const HELPERS_VERSION = 9;
  if (globalThis.__mcpHelpersVersion === HELPERS_VERSION) return;
  globalThis.__mcpHelpersVersion = HELPERS_VERSION;
  globalThis.__mcpHelpersLoaded = true;

  const NATIVE_ROLES = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    TEXTAREA: "textbox",
    SELECT: "combobox",
    LABEL: "text",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    IMG: "image",
    NAV: "navigation",
    MAIN: "main",
    ASIDE: "complementary",
    HEADER: "banner",
    FOOTER: "contentinfo",
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    TR: "row",
    TD: "cell",
    TH: "columnheader",
    FORM: "form",
    SECTION: "region",
    ARTICLE: "article",
  };

  const INTERACTIVE_TAGS = new Set([
    "BUTTON",
    "A",
    "INPUT",
    "TEXTAREA",
    "SELECT",
  ]);
  const INTERACTIVE_ROLE_RE =
    /^(button|link|textbox|searchbox|combobox|checkbox|radio|menuitem|menuitemcheckbox|menuitemradio|tab|listbox|option|slider|spinbutton|switch)$/i;

  function roleOf(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit.toLowerCase();
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (/** @type {HTMLElement} */ (el).isContentEditable) return "textbox";
    return NATIVE_ROLES[el.tagName] || null;
  }

  function isInteractive(el) {
    if (!(el instanceof Element)) return false;
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (/** @type {HTMLElement} */ (el).isContentEditable) return true;
    const role = el.getAttribute("role");
    return !!(role && INTERACTIVE_ROLE_RE.test(role));
  }

  function nameOf(el) {
    const aria = el.getAttribute?.("aria-label");
    if (aria) return aria.trim();
    const labelled = el.getAttribute?.("aria-labelledby");
    if (labelled) {
      const ref = document.getElementById(labelled);
      if (ref) return (ref.textContent || "").trim();
    }
    if (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT"
    ) {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return (lab.textContent || "").trim();
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.trim();
    }
    if (el.tagName === "IMG") return el.getAttribute("alt") || "";
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const txt = (el.textContent || "").trim();
    if (txt && txt.length <= 200) return txt;
    return "";
  }

  function valueOf(el) {
    if (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT"
    )
      return el.value ?? "";
    return undefined;
  }

  // The element's own view — `window.getComputedStyle`/`elementFromPoint` must
  // be called on the document the element actually lives in once the walk
  // descends into a same-origin child frame (its elements belong to the frame's
  // document, not the top one). Falls back to the top `window` for detached
  // nodes. The top `window` stays the reference for top-viewport math
  // (inViewport, offset accumulation) — those are deliberately frame-agnostic.
  function viewOf(el) {
    try {
      return (el.ownerDocument && el.ownerDocument.defaultView) || window;
    } catch {
      return window;
    }
  }

  function isHidden(el) {
    const style = viewOf(el).getComputedStyle(el);
    return (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0"
    );
  }

  function isVisible(el, rect) {
    // Bail only on style-hidden elements. Zero-dimension wrappers are a very
    // common React/Chakra layout idiom (e.g. Suno's create page has an empty
    // class=""  div with width:1336 height:0 between the form and body) — the
    // wrapper itself has no box but its overflowing children render fine. If
    // we returned false here, walkA11y would prune the whole subtree below,
    // hiding the entire form from the snapshot. So: zero-rect is OK as long
    // as we still recurse into children. A LEAF with a zero rect IS hidden;
    // walkA11y handles that case explicitly below.
    if (!rect) return false;
    if (isHidden(el)) return false;
    return true;
  }

  // Viewport test against the TOP window using TOP-VIEWPORT (offset-applied)
  // coordinates — so an element inside a same-origin child frame is judged by
  // where it actually paints on the user's screen, not by the frame's own
  // viewport. `window` is lexically the top frame's window throughout (this
  // closure is injected once into the top frame's isolated world).
  function inViewportAbs(left, top, right, bottom) {
    const vw = window.innerWidth,
      vh = window.innerHeight;
    return right > 0 && bottom > 0 && left < vw && top < vh;
  }

  // Max same-origin iframe nesting we descend, guarding against pathological
  // self-embedding pages. Open shadow roots don't count toward this — they're
  // same-document and can't cycle.
  const MAX_FRAME_DEPTH = 10;

  // Per-`__mcpA11y()` log of every child frame the walk encountered, surfaced on
  // the tree root so the bridge can build a `meta.frames` summary WITHOUT a
  // second round trip or a debugger attach. `descended:false` marks a
  // cross-origin (or too-deep / unloaded) frame whose content the snapshot
  // could not traverse — making the skipped boundary loud (invariant #20).
  let frameLog = [];

  // Stable, non-evicting refs (HELPERS_VERSION 7). A given element keeps the
  // SAME id across every walk via a persistent WeakMap, and a ref resolves for
  // as long as its element stays connected to the DOM — even if a later
  // snapshot dropped it (out of the pruner's cap, scrolled out of viewport, or
  // hidden). The reverse id→element map holds WeakRefs so detached/replaced
  // nodes stay garbage-collectable (this runs inside the user's real browser).
  // Neither structure is reset on __mcpA11y(); a re-rendered element is a new
  // object and correctly earns a fresh id.
  /** @type {WeakMap<Element, string>} stable element→id identity */
  const elementIds = new WeakMap();
  /** @type {Map<string, WeakRef<Element>>} id→element reverse lookup (self-pruning) */
  const nodeMap = new Map();
  let persistentCounter = 0;

  /** Mint (or reuse) the stable id for an element and refresh its reverse entry. */
  function idFor(el) {
    let id = elementIds.get(el);
    if (id === undefined) {
      id = String(++persistentCounter);
      elementIds.set(el, id);
    }
    nodeMap.set(id, new WeakRef(el));
    return id;
  }

  /**
   * @param {Element} el
   * @param {number} depth
   * @param {{dx:number, dy:number, frameDepth:number}} [offset]
   *   Accumulated top-viewport offset. `getBoundingClientRect` is relative to
   *   the element's OWN document's viewport, so inside a same-origin child frame
   *   we add the frame's content-box origin (in top coords) to lift descendant
   *   rects to top-viewport space. Shadow roots add nothing (same document).
   */
  function walkA11y(el, depth, offset) {
    offset = offset || { dx: 0, dy: 0, frameDepth: 0 };
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return null;
    const hasShadow = !!el.shadowRoot; // open shadow root only — closed is null
    const isFrame = el.tagName === "IFRAME" || el.tagName === "FRAME";
    // A truly geometric-zero LEAF is hidden — drop. But a zero-rect element
    // WITH children (or a shadow host / frame) might wrap rendered content;
    // recurse before bailing.
    const zeroRect = rect.width === 0 || rect.height === 0;
    if (zeroRect && el.children.length === 0 && !hasShadow && !isFrame)
      return null;
    const role = roleOf(el);
    const name = role ? nameOf(el) : "";
    const nodeId = idFor(el);
    const style = viewOf(el).getComputedStyle(el);
    const absLeft = rect.left + offset.dx;
    const absTop = rect.top + offset.dy;
    const node = {
      nodeId,
      role: role || "generic",
      name,
      depth,
      rect: { x: absLeft, y: absTop, w: rect.width, h: rect.height },
      inViewport: inViewportAbs(
        absLeft,
        absTop,
        absLeft + rect.width,
        absTop + rect.height,
      ),
      children: [],
    };
    const value = valueOf(el);
    if (value !== undefined) node.value = value;
    if (el.matches?.("[disabled]")) node.disabled = true;
    if (el.tagName === "INPUT") {
      const input = /** @type {HTMLInputElement} */ (el);
      if (input.type === "checkbox" || input.type === "radio")
        node.checked = input.checked;
    }
    if (el.getAttribute?.("aria-selected") === "true") node.selected = true;
    const expanded = el.getAttribute?.("aria-expanded");
    if (expanded !== null && expanded !== undefined)
      node.expanded = expanded === "true";
    // Extra flags for the pruner's heuristics: cookie-banner collapse, modal
    // focus, accessibility-hidden filtering, and position-fixed detection
    // (overlay banners almost always carry position:fixed).
    if (el.getAttribute?.("aria-hidden") === "true") node.ariaHidden = true;
    if (el.hasAttribute?.("inert")) node.inert = true;
    // <dialog open> with modal-style open() shows a top-layer modal — useful
    // for the pruner to prioritise its descendants.
    if (
      el.tagName === "DIALOG" &&
      /** @type {HTMLDialogElement} */ (el).open === true
    ) {
      node.dialogModal = true;
    }
    if (style && style.position && style.position !== "static") {
      node.position = style.position;
    }
    // Active-layer pass: flag an interactive element that is NOT the topmost
    // hit-tested element at its own centre as `occluded`. SPAs that keep a stale
    // previous-slide / under-layer mounted (Articulate Storyline) produce ghost
    // interactives at the same coordinates as the live ones; the pruner uses
    // this flag only to DEPRIORITISE (score penalty), never to exclude — so a
    // legitimately-overlapped-but-unique control still surfaces. Hit-test in the
    // element's OWN document with LOCAL coords (pre-offset). Layout is already
    // clean mid-walk (no mutations), so elementFromPoint adds no re-layout cost.
    if (!zeroRect && isInteractive(el)) {
      try {
        const doc = el.ownerDocument;
        const top = doc.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (top && top !== el && !el.contains(top) && !top.contains(el))
          node.occluded = true;
      } catch {}
    }

    for (const child of Array.from(el.children)) {
      const sub = walkA11y(child, depth + 1, offset);
      if (sub) node.children.push(sub);
    }
    // Open shadow root: its children render in the host's coordinate space
    // (same document), so the SAME offset applies. Surfaces web components (e.g.
    // UI5 custom elements) that a light-DOM-only walk would never see.
    if (hasShadow) {
      for (const child of Array.from(el.shadowRoot.children)) {
        const sub = walkA11y(child, depth + 1, offset);
        if (sub) node.children.push(sub);
      }
    }
    // Child frame: descend if same-origin (mutates `node` in place — marks a
    // cross-origin boundary as a leaf, or splices the frame document's subtree).
    if (isFrame) descendFrame(el, node, depth, offset, absLeft, absTop, role, name);
    if (node.children.length === 0 && !role && name) node.role = "text";
    return node;
  }

  /**
   * Descend a child <iframe>/<frame>. Same-origin → splice the frame document's
   * pruned subtree under `node`, with descendant rects shifted to top-viewport
   * by the frame's content-box origin. Cross-origin (SecurityError on
   * `contentDocument`), too-deep, or unloaded → turn `node` into a single
   * `iframe` leaf flagged `crossOrigin` so the boundary is loud and nameable
   * (Phase 4 adds opt-in cross-origin descent). Every frame is logged for the
   * `meta.frames` summary.
   */
  function descendFrame(el, node, depth, offset, absLeft, absTop, role, name) {
    let url = "";
    try {
      url = el.src || el.getAttribute("src") || "";
    } catch {}
    let doc = null;
    try {
      doc = el.contentDocument; // throws / null for cross-origin
    } catch {
      doc = null;
    }
    const tooDeep = offset.frameDepth >= MAX_FRAME_DEPTH;
    if (!doc || tooDeep) {
      // Cross-origin / unreachable: present a named leaf so the pruner keeps it
      // (named nodes are kept) and the serializer can render a recovery hint.
      // Only override role/name when this node carries no semantics of its own.
      if (!role && !name) {
        node.role = "iframe";
        node.name = url || "cross-origin frame";
      }
      node.crossOrigin = true;
      if (url) node.frameUrl = url;
      frameLog.push({ url, descended: false });
      return;
    }
    frameLog.push({ url, descended: true });
    const body = doc.body;
    if (!body) return;
    const childOffset = {
      // clientLeft/clientTop = the iframe's border widths; the content box
      // origin sits inside the border, so add them to the border-box origin.
      dx: absLeft + (el.clientLeft || 0),
      dy: absTop + (el.clientTop || 0),
      frameDepth: offset.frameDepth + 1,
    };
    const sub = walkA11y(body, depth + 1, childOffset);
    if (sub) node.children.push(sub);
  }

  function findByRef(ref) {
    const wr = nodeMap.get(String(ref));
    if (!wr) return null;
    const el = wr.deref();
    // Liveness gate: a ref resolves only while its element is still attached to
    // the document. A detached (or GC'd) element is genuinely gone — drop the
    // dead entry and report a miss so the bridge surfaces an actionable error.
    if (!el || !el.isConnected) {
      nodeMap.delete(String(ref));
      return null;
    }
    return el;
  }

  globalThis.__mcpResolveRef = function (ref) {
    const el = findByRef(ref);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      name: nameOf(el),
      role: roleOf(el),
      tag: el.tagName,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  };

  function notifyAction(phase, kind, ref) {
    try {
      globalThis.__mcpIndicator?.onAction?.({ phase, kind, ref });
    } catch {}
  }

  globalThis.__mcpA11y = function () {
    // Refs are stable + non-evicting: do NOT reset nodeMap/counter here, or an
    // element would renumber every snapshot and refs from a prior snapshot
    // would stop resolving. Bound the reverse map's growth on long-lived SPAs
    // by sweeping dead WeakRefs — but only past a threshold so the common case
    // pays nothing. (Lazy pruning in findByRef covers refs the agent re-probes;
    // this sweep reclaims the rest.)
    if (nodeMap.size > 5000) {
      for (const [id, wr] of nodeMap) {
        const el = wr.deref();
        if (!el || !el.isConnected) nodeMap.delete(id);
      }
    }
    // Reset the per-walk frame log; walkA11y/descendFrame append to it as the
    // tree is built across same-origin frames and cross-origin boundaries.
    frameLog = [];
    const root = walkA11y(document.body, 0) || {
      role: "WebArea",
      name: document.title,
      depth: 0,
      children: [],
      inViewport: true,
    };
    root.role = "WebArea";
    root.name = document.title;
    // Surface the frame summary so the bridge can build `meta.frames` (which
    // child frames exist and whether each was descended) with no extra hop.
    if (frameLog.length) root.frames = frameLog;
    // Surface CSS viewport so the annotation hop can scale CSS-pixel rects to
    // canvas-pixel coordinates via `imgW / cssViewport.w` (and the matching
    // `imgH / cssViewport.h`) — independent of DPR and resize history. DPR
    // bakes into both the captured bitmap and the CSS viewport identically,
    // so it drops out of the scale formula whichever hop did the resize.
    root.cssViewport = { w: window.innerWidth, h: window.innerHeight };
    return root;
  };

  function dispatchMouse(el, type, opts = {}) {
    const rect = el.getBoundingClientRect();
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: opts.button === "right" ? 2 : opts.button === "middle" ? 1 : 0,
      ctrlKey: !!opts.modifiers?.includes("Control"),
      shiftKey: !!opts.modifiers?.includes("Shift"),
      altKey: !!opts.modifiers?.includes("Alt"),
      metaKey: !!opts.modifiers?.includes("Meta"),
    });
    el.dispatchEvent(ev);
  }

  function actClick(opts) {
    const el = findByRef(opts.ref);
    if (!el) return { error: `ref ${opts.ref} not found` };
    const count = opts.clickCount || 1;
    for (let i = 0; i < count; i++) {
      dispatchMouse(el, "mousedown", opts);
      dispatchMouse(el, "mouseup", opts);
      dispatchMouse(el, "click", opts);
    }
    if (count === 2) dispatchMouse(el, "dblclick", opts);
    if (opts.button === "right") dispatchMouse(el, "contextmenu", opts);
    return { clicked: opts.ref };
  }

  function actType(opts) {
    const raw = findByRef(opts.ref);
    if (!raw) return { error: `ref ${opts.ref} not found` };
    let el = /** @type {HTMLElement & { value?: string }} */ (raw);
    // If the ref points at a wrapper, walk into the first typable descendant (contenteditable
    // div, <input>, or <textarea>). Common on framework-built editors (ChatGPT, Discord, etc.)
    // where the snapshot's nearest interactive node is an outer container.
    if (
      !el.isContentEditable &&
      !("value" in el && typeof el.value === "string")
    ) {
      const inner = el.querySelector?.(
        '[contenteditable="true"], [contenteditable=""], textarea, input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio])',
      );
      if (inner) el = /** @type {HTMLElement & { value?: string }} */ (inner);
    }
    const hasValue = "value" in el && typeof el.value === "string";
    const editable = el.isContentEditable;
    if (!hasValue && !editable)
      return {
        error: `ref ${opts.ref} is not a text input (and no editable descendant)`,
      };
    el.focus?.();
    if (!opts.append) {
      if (hasValue) el.value = "";
      else el.textContent = "";
    }
    if (hasValue) {
      el.value = (opts.append ? el.value : "") + opts.text;
    } else {
      // For contenteditable, use insertText execCommand when available so frameworks (React, Lexical)
      // see real beforeinput/input events with proper InputEvent.data. Falls back to textContent.
      const ok = document.execCommand?.("insertText", false, opts.text);
      if (!ok) el.textContent = (opts.append ? el.textContent : "") + opts.text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: opts.text };
  }

  function actSelectOption(opts) {
    const el = findByRef(opts.ref);
    if (!(el instanceof HTMLSelectElement))
      return { error: `ref ${opts.ref} is not a <select>` };
    const match = Array.from(el.options).find(
      (o) => o.value === opts.value || o.text === opts.value,
    );
    if (!match) return { error: `no option matched ${opts.value}` };
    el.value = match.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: match.value };
  }

  function actHover(opts) {
    const el = findByRef(opts.ref);
    if (!el) return { error: `ref ${opts.ref} not found` };
    dispatchMouse(el, "mouseover");
    dispatchMouse(el, "mouseenter");
    dispatchMouse(el, "mousemove");
    return { hovered: opts.ref };
  }

  function actScroll(opts) {
    const el = opts.ref ? findByRef(opts.ref) : null;
    const target = el || document.scrollingElement || document.body;
    target.scrollBy({
      left: opts.deltaX || 0,
      top: opts.deltaY || 400,
      behavior: "instant",
    });
    return { scrolled: { x: opts.deltaX || 0, y: opts.deltaY || 400 } };
  }

  function actPressKey(opts) {
    const key = opts.key;
    const init = {
      bubbles: true,
      cancelable: true,
      key,
      code: key,
      ctrlKey: !!opts.modifiers?.includes("Control"),
      shiftKey: !!opts.modifiers?.includes("Shift"),
      altKey: !!opts.modifiers?.includes("Alt"),
      metaKey: !!opts.modifiers?.includes("Meta"),
    };
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { pressed: key };
  }

  async function actWaitFor(opts) {
    const startedAt = Date.now();
    const deadline = startedAt + (opts.timeout || 10_000);
    const pollMs = opts.pollIntervalMs ?? 100;
    if (opts.selector) {
      // Sync-first check: if the element is already in the DOM at call time,
      // return immediately. Without this, the poll loop sleeps 100ms before
      // ever looking — which makes wait_for race with helper re-injection and
      // miss already-present elements (root cause of Issue #8).
      if (document.querySelector(opts.selector))
        return { met: true, found: opts.selector, elapsedMs: 0 };
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (document.querySelector(opts.selector))
          return {
            met: true,
            found: opts.selector,
            elapsedMs: Date.now() - startedAt,
          };
      }
      return {
        met: false,
        error: `selector ${opts.selector} not found within timeout`,
        elapsedMs: Date.now() - startedAt,
      };
    }
    if (opts.condition) {
      // Helper-contract completeness: an in-page caller invoking
      // __mcpAct("wait_for", {condition}) directly still works. The
      // bridge's normal path NEVER reaches here — background.js::dispatchInner
      // intercepts condition mode and routes through chrome.debugger
      // Runtime.evaluate, which bypasses strict-CSP sites' unsafe-eval
      // rejection of `new Function(...)`.
      let lastValue;
      let lastError;
      const evalOnce = () => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (function(){ return (${opts.condition}); })();`);
          const v = fn();
          lastValue = v;
          return v;
        } catch (e) {
          lastError = e && e.message ? e.message : String(e);
          return undefined;
        }
      };
      const v0 = evalOnce();
      if (v0) {
        return { met: true, value: v0, elapsedMs: 0 };
      }
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const v = evalOnce();
        if (v) {
          return { met: true, value: v, elapsedMs: Date.now() - startedAt };
        }
      }
      return {
        met: false,
        value: lastValue,
        error: lastError
          ? `predicate threw: ${lastError}`
          : `predicate did not become truthy within timeout`,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await new Promise((r) => setTimeout(r, opts.timeout || 100));
    return { met: true, waited: opts.timeout, elapsedMs: Date.now() - startedAt };
  }

  function actUpload(opts) {
    const raw = findByRef(opts.ref);
    if (!raw) return { error: `ref ${opts.ref} not found` };
    let el = raw;
    if (!(el instanceof HTMLInputElement) || el.type !== "file") {
      const inner = el.querySelector?.('input[type="file"]');
      if (inner) el = inner;
    }
    if (!(el instanceof HTMLInputElement) || el.type !== "file")
      return { error: `ref ${opts.ref} is not a file input` };
    const dt = new DataTransfer();
    for (const f of opts.files) {
      const bin = atob(f.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
    }
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { uploaded: opts.files.map((f) => f.name), ref: opts.ref };
  }

  // ─── drag & drop (HELPERS_VERSION 8) ──────────────────────────────
  //
  // Two synthetic-event families, all page-side (no CDP Input.*, no window
  // raise): the HTML5 DnD-API sequence (dragstart→dragover→drop with a shared
  // DataTransfer) drives `draggable="true"` sources and is the only way to
  // synthesize a FILE drop; the pointer sequence (mousedown→mousemove→mouseup
  // with PointerEvents) drives pointer-based DnD libraries (SortableJS
  // fallback, react-beautiful-dnd, kanban boards). isTrusted is false on
  // synthetic events — a minority of libraries that gate on it won't react.

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function clampToViewport(x, y) {
    return {
      x: Math.max(0, Math.min(Math.round(x), window.innerWidth - 1)),
      y: Math.max(0, Math.min(Math.round(y), window.innerHeight - 1)),
    };
  }

  function mouseInit(x, y, opts = {}) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: opts.button ?? 0,
      buttons: opts.buttons ?? 0,
    };
  }

  function fireMouse(el, type, x, y, opts = {}) {
    el.dispatchEvent(new MouseEvent(type, mouseInit(x, y, opts)));
  }

  function firePointer(el, type, x, y, opts = {}) {
    // Some pointer-based DnD libs listen for PointerEvent specifically; the
    // paired MouseEvent (fired alongside) carries the drag for the rest.
    const Ctor = window.PointerEvent;
    if (!Ctor) return;
    el.dispatchEvent(
      new Ctor(type, {
        ...mouseInit(x, y, opts),
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: opts.pressure ?? 0,
      }),
    );
  }

  function fireDrag(el, type, dataTransfer, x, y) {
    // A real DragEvent carrying a DataTransfer drives HTML5 DnD-API listeners.
    let ev;
    try {
      ev = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        dataTransfer,
      });
    } catch {
      // Some engines reject a dataTransfer init on DragEvent — fall back to a
      // MouseEvent with the dataTransfer pinned on as an own property.
      ev = new MouseEvent(type, mouseInit(x, y));
      try {
        Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
      } catch {}
    }
    el.dispatchEvent(ev);
  }

  function actDrag(opts) {
    const src = findByRef(opts.ref);
    if (!src) return { error: `ref ${opts.ref} not found` };
    const tgt = findByRef(opts.targetRef);
    if (!tgt) return { error: `target ref ${opts.targetRef} not found` };
    const mechanism =
      opts.mechanism && opts.mechanism !== "auto"
        ? opts.mechanism
        : src.draggable === true || src.getAttribute?.("draggable") === "true"
          ? "native"
          : "pointer";
    const s = centerOf(src);
    const t = centerOf(tgt);
    if (mechanism === "native") {
      const dt = new DataTransfer();
      fireMouse(src, "mousedown", s.x, s.y, { buttons: 1 });
      fireDrag(src, "dragstart", dt, s.x, s.y);
      fireDrag(tgt, "dragenter", dt, t.x, t.y);
      fireDrag(tgt, "dragover", dt, t.x, t.y);
      fireDrag(tgt, "drop", dt, t.x, t.y);
      fireDrag(src, "dragend", dt, t.x, t.y);
      fireMouse(src, "mouseup", t.x, t.y, { buttons: 0 });
    } else {
      // Press on the source, step toward the target dispatching on the element
      // under each interpolated point (so libs tracking elementFromPoint see
      // the transit), release on the target.
      firePointer(src, "pointerdown", s.x, s.y, { buttons: 1, pressure: 0.5 });
      fireMouse(src, "mousedown", s.x, s.y, { buttons: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = s.x + ((t.x - s.x) * i) / steps;
        const y = s.y + ((t.y - s.y) * i) / steps;
        const cp = clampToViewport(x, y);
        const under = document.elementFromPoint(cp.x, cp.y) || tgt;
        firePointer(under, "pointermove", x, y, { buttons: 1, pressure: 0.5 });
        fireMouse(under, "mousemove", x, y, { buttons: 1 });
      }
      firePointer(tgt, "pointerup", t.x, t.y, { buttons: 0 });
      fireMouse(tgt, "mouseup", t.x, t.y, { buttons: 0 });
    }
    return { dragged: opts.ref, to: opts.targetRef, mechanism };
  }

  function actDrop(opts) {
    const tgt = findByRef(opts.ref);
    if (!tgt) return { error: `ref ${opts.ref} not found` };
    const dt = new DataTransfer();
    for (const f of opts.files || []) {
      const bin = atob(f.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
    }
    const t = centerOf(tgt);
    fireDrag(tgt, "dragenter", dt, t.x, t.y);
    fireDrag(tgt, "dragover", dt, t.x, t.y);
    fireDrag(tgt, "drop", dt, t.x, t.y);
    return { dropped: (opts.files || []).map((f) => f.name), ref: opts.ref };
  }

  function runAct(kind, opts) {
    switch (kind) {
      case "click":
        return actClick(opts);
      case "type":
        return actType(opts);
      case "select_option":
        return actSelectOption(opts);
      case "hover":
        return actHover(opts);
      case "scroll":
        return actScroll(opts);
      case "press_key":
        return actPressKey(opts);
      case "wait_for":
        return actWaitFor(opts);
      case "upload":
        return actUpload(opts);
      case "drag":
        return actDrag(opts);
      case "drop":
        return actDrop(opts);
      default:
        return { error: `unknown act kind: ${kind}` };
    }
  }

  globalThis.__mcpAct = function (kind, opts) {
    notifyAction("start", kind, opts?.ref);
    const out = /** @type {any} */ (runAct(kind, opts));
    if (out && typeof out.then === "function") {
      return out.then((r) => {
        notifyAction("end", kind, opts?.ref);
        return r;
      });
    }
    notifyAction("end", kind, opts?.ref);
    return out;
  };
})();
