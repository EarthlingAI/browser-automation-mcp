/**
 * In-page helpers. Idempotent — re-running is a no-op.
 *
 * Defines two globals on the page's isolated world (or MAIN, per how the
 * service worker injects this):
 *   - globalThis.__earthlingA11y()             → raw a11y tree
 *   - globalThis.__earthlingAct(kind, opts)    → click/type/hover/scroll/...
 *
 * Refs are sequential numeric IDs assigned by walking the same interactive
 * elements in the same BFS order both here and in the daemon's pruner.
 */

(() => {
  if (globalThis.__earthlingHelpersLoaded) return;
  globalThis.__earthlingHelpersLoaded = true;

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

  function isVisible(el, rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0"
    )
      return false;
    return true;
  }

  function inViewport(rect) {
    const vw = window.innerWidth,
      vh = window.innerHeight;
    return rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh;
  }

  /** @type {Map<string, Element>} */
  let nodeMap = new Map();
  let nodeCounter = 0;

  /**
   * @param {Element} el
   * @param {number} depth
   */
  function walkA11y(el, depth) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return null;
    const role = roleOf(el);
    const name = role ? nameOf(el) : "";
    const nodeId = String(++nodeCounter);
    nodeMap.set(nodeId, el);
    const node = {
      nodeId,
      role: role || "generic",
      name,
      depth,
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      inViewport: inViewport(rect),
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

    for (const child of Array.from(el.children)) {
      const sub = walkA11y(child, depth + 1);
      if (sub) node.children.push(sub);
    }
    if (node.children.length === 0 && !role && name) node.role = "text";
    return node;
  }

  function findByRef(ref) {
    return nodeMap.get(String(ref)) || null;
  }

  globalThis.__earthlingResolveRef = function (ref) {
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
      globalThis.__earthlingIndicator?.onAction?.({ phase, kind, ref });
    } catch {}
  }

  globalThis.__earthlingA11y = function () {
    nodeMap = new Map();
    nodeCounter = 0;
    const root = walkA11y(document.body, 0) || {
      role: "WebArea",
      name: document.title,
      depth: 0,
      children: [],
      inViewport: true,
    };
    root.role = "WebArea";
    root.name = document.title;
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
    const deadline = Date.now() + (opts.timeout || 10_000);
    if (opts.selector) {
      while (Date.now() < deadline) {
        if (document.querySelector(opts.selector))
          return { found: opts.selector };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { error: `selector ${opts.selector} not found within timeout` };
    }
    await new Promise((r) => setTimeout(r, opts.timeout || 100));
    return { waited: opts.timeout };
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
      default:
        return { error: `unknown act kind: ${kind}` };
    }
  }

  globalThis.__earthlingAct = function (kind, opts) {
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
