/**
 * Shared role vocabulary for the snapshot pipeline. Lives in its own module so
 * prune.ts (which imports distill) and distill.ts (which needs the same sets)
 * don't form an import cycle with top-level initializers.
 */

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "listbox",
  "option",
  "slider",
  "spinbutton",
  "switch",
]);

// Runtime-redundant with INTERACTIVE_ROLES ∪ DATA_ROLES (every member is in
// one of them) — kept as intent vocabulary: keep-rule call sites and invariant
// #20 speak in "interactive / navigational / data-bearing", and the named set
// keeps that prose greppable to code. Don't "clean up" the redundancy.
export const NAV_ROLES = new Set([
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

export const DATA_ROLES = new Set(["listitem", "row", "treeitem"]);

/** Cell roles a row may collapse over (see the row-collapse rule in prune.ts). */
export const CELL_ROLES = new Set([
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
]);

/** Row containers that get the `(showing X of Y rows)` annotation. */
export const TABLE_ROLES = new Set(["table", "grid", "treegrid"]);
