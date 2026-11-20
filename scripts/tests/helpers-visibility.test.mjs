// Page-side visibility in the a11y walk (helpers.js::isHidden). helpers.js is
// an injected IIFE, so it is run here in a bare VM context over stub elements:
// enough DOM for the walk, nothing that needs Chrome. Pins which opacity-0
// elements keep their subtree — a tab that is not being rendered holds an entry
// animation at its first frame, and pruning there empties the whole snapshot.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HELPERS = fs.readFileSync(
  fileURLToPath(
    new URL("../../browser-extension/inject/helpers.js", import.meta.url),
  ),
  "utf8",
);

function walk(body) {
  class Element {}
  const view = { getComputedStyle: (el) => el.style };
  const adopt = (spec) => {
    const el = Object.assign(new Element(), {
      tagName: spec.tag || "DIV",
      style: {
        visibility: "visible",
        display: "block",
        position: "static",
        opacity: spec.opacity ?? "1",
      },
      attrs: spec.attrs || {},
      textContent: spec.text || "",
      ownerDocument: { defaultView: view, elementFromPoint: () => null },
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
      hasAttribute(name) {
        return name in this.attrs;
      },
      matches: () => false,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 20,
      }),
      getAnimations: () => {
        if (spec.animationsThrow) throw new Error("no animations here");
        return spec.animations || [];
      },
    });
    el.children = (spec.children || []).map(adopt);
    el.childElementCount = el.children.length;
    return el;
  };
  const context = vm.createContext({
    Element,
    WeakRef,
    document: { title: "stub", body: adopt(body) },
    innerWidth: 1000,
    innerHeight: 800,
  });
  context.window = context;
  vm.runInContext(HELPERS, context);
  return context.__mcpA11y();
}

const animation = (playState, frames) => ({
  playState,
  effect: { getKeyframes: () => frames },
});

// A wrapper at opacity 0 around one named button: the button's presence in the
// walked tree says whether the wrapper's subtree survived.
function buttonSurvives(animations) {
  const tree = walk({
    children: [
      {
        opacity: "0",
        animations,
        children: [{ tag: "BUTTON", attrs: { "aria-label": "Send" } }],
      },
    ],
  });
  return JSON.stringify(tree).includes('"name":"Send"');
}

test("opacity 0 with no animation is hidden", () => {
  assert.equal(buttonSurvives([]), false);
});

test("opacity 0 at the start of a running fade-in is kept", () => {
  assert.equal(
    buttonSurvives([
      animation("running", [{ opacity: "0" }, { opacity: "1" }]),
    ]),
    true,
  );
});

test("a paused or pending fade-in is kept too", () => {
  for (const state of ["paused", "pending"])
    assert.equal(
      buttonSurvives([animation(state, [{ opacity: "0" }, { opacity: "1" }])]),
      true,
      state,
    );
});

test("a fade-in whose last keyframe leaves opacity to the element is kept", () => {
  assert.equal(
    buttonSurvives([
      animation("running", [
        { opacity: "0", transform: "translateY(8px)" },
        { transform: "none" },
      ]),
    ]),
    true,
  );
});

test("an animation ending at opacity 0 stays hidden", () => {
  assert.equal(
    buttonSurvives([
      animation("running", [{ opacity: "1" }, { opacity: "0" }]),
    ]),
    false,
  );
});

test("a finished animation does not rescue opacity 0", () => {
  assert.equal(
    buttonSurvives([
      animation("finished", [{ opacity: "0" }, { opacity: "1" }]),
    ]),
    false,
  );
});

test("a running animation that never touches opacity does not rescue it", () => {
  assert.equal(
    buttonSurvives([
      animation("running", [{ transform: "none" }, { transform: "scale(2)" }]),
    ]),
    false,
  );
});

test("an element whose animations cannot be read falls back to hidden", () => {
  const tree = walk({
    children: [
      {
        opacity: "0",
        animationsThrow: true,
        children: [{ tag: "BUTTON", attrs: { "aria-label": "Send" } }],
      },
    ],
  });
  assert.equal(JSON.stringify(tree).includes('"name":"Send"'), false);
});
