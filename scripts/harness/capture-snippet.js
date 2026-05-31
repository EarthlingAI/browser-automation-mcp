/**
 * Self-contained raw a11y-tree capture, for the snapshot regression harness.
 *
 * WHY THIS EXISTS (and is not just `__mcpA11y()`):
 *   helpers.js injects `__mcpA11y` into the page's ISOLATED world via
 *   chrome.scripting.executeScript, but `browser_evaluate` runs in the MAIN
 *   world (chrome.debugger Runtime.evaluate — see background.js::runEvaluate),
 *   so the agent cannot reach `__mcpA11y` from an evaluate call. This snippet is
 *   a MAIN-world-evaluatable mirror of `helpers.js::__mcpA11y` that emits the
 *   exact same RawNode shape consumed by `snapshot/prune.ts`.
 *
 * HOW TO CAPTURE A FIXTURE (agent-driven; needs the extension connected):
 *   1. browser_navigate to the target site; let it settle.
 *   2. browser_evaluate with the FULL contents of this file as the expression
 *      (it is one IIFE that returns the RawNode root by value).
 *   3. Save the returned object to scripts/harness/fixtures/<name>.json as
 *      { "url": "...", "title": "...", "capturedAt": "<ISO>", "rawTree": <result> }.
 *      (snapshot-harness.mjs reads exactly that envelope.)
 *
 * DRIFT NOTE: the RawNode field set (nodeId/role/name/depth/rect/inViewport/
 * children + value/disabled/checked/selected/expanded/ariaHidden/inert/
 * dialogModal/position) is the stable contract between helpers.js and prune.ts.
 * Keep this walk byte-faithful to helpers.js::walkA11y so captured fixtures
 * stay representative of what the live pipeline feeds the pruner.
 */
(() => {
  const NATIVE_ROLES = {
    A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox",
    SELECT: "combobox", LABEL: "text", H1: "heading", H2: "heading",
    H3: "heading", H4: "heading", H5: "heading", H6: "heading", IMG: "image",
    NAV: "navigation", MAIN: "main", ASIDE: "complementary", HEADER: "banner",
    FOOTER: "contentinfo", UL: "list", OL: "list", LI: "listitem",
    TABLE: "table", TR: "row", TD: "cell", TH: "columnheader", FORM: "form",
    SECTION: "region", ARTICLE: "article",
  };

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
    if (el.isContentEditable) return "textbox";
    return NATIVE_ROLES[el.tagName] || null;
  }

  function nameOf(el) {
    const aria = el.getAttribute?.("aria-label");
    if (aria) return aria.trim();
    const labelled = el.getAttribute?.("aria-labelledby");
    if (labelled) {
      const ref = document.getElementById(labelled);
      if (ref) return (ref.textContent || "").trim();
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
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
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")
      return el.value ?? "";
    return undefined;
  }

  function isHidden(el) {
    const style = window.getComputedStyle(el);
    return style.visibility === "hidden" || style.display === "none" || style.opacity === "0";
  }

  function isVisible(el, rect) {
    if (!rect) return false;
    if (isHidden(el)) return false;
    return true;
  }

  function inViewport(rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    return rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh;
  }

  let nodeCounter = 0;

  function walkA11y(el, depth) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return null;
    const zeroRect = rect.width === 0 || rect.height === 0;
    if (zeroRect && el.children.length === 0) return null;
    const role = roleOf(el);
    const name = role ? nameOf(el) : "";
    const nodeId = String(++nodeCounter);
    const style = window.getComputedStyle(el);
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
      const input = el;
      if (input.type === "checkbox" || input.type === "radio") node.checked = input.checked;
    }
    if (el.getAttribute?.("aria-selected") === "true") node.selected = true;
    const expanded = el.getAttribute?.("aria-expanded");
    if (expanded !== null && expanded !== undefined) node.expanded = expanded === "true";
    if (el.getAttribute?.("aria-hidden") === "true") node.ariaHidden = true;
    if (el.hasAttribute?.("inert")) node.inert = true;
    if (el.tagName === "DIALOG" && el.open === true) node.dialogModal = true;
    if (style && style.position && style.position !== "static") node.position = style.position;
    for (const child of Array.from(el.children)) {
      const sub = walkA11y(child, depth + 1);
      if (sub) node.children.push(sub);
    }
    if (node.children.length === 0 && !role && name) node.role = "text";
    return node;
  }

  const root = walkA11y(document.body, 0) || {
    role: "WebArea", name: document.title, depth: 0, children: [], inViewport: true,
  };
  root.role = "WebArea";
  root.name = document.title;
  root.cssViewport = { w: window.innerWidth, h: window.innerHeight };
  return root;
})();
