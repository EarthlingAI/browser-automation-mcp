/**
 * Snapshot regression harness — the safety net for the pruning/format/diff
 * changes in the streamlining round (CP3/CP4/CP5).
 *
 * It runs the REAL `prune()` (imported from the built bundle) over FROZEN raw
 * a11y-tree fixtures captured from real, content-rich sites, then reports the
 * full set of elements the pruner keeps. Because the fixtures are frozen JSON,
 * prune is deterministic over them — so comparing a saved baseline against the
 * current build flags any element the new pipeline silently drops.
 *
 * ── Capturing fixtures (one-time, agent-driven; needs the extension connected)
 *   For each target site (aim for 6-8 diverse pages — long-form article, docs
 *   SPA, data/news grid, dense feed, strict-CSP app, cookie-wall, e-commerce):
 *     1. browser_navigate to the URL; let it settle.
 *     2. browser_evaluate with the full contents of `capture-snippet.js` as the
 *        expression (returns the RawNode root by value).
 *     3. Write scripts/harness/fixtures/<name>.json:
 *          { "url": "...", "title": "...", "capturedAt": "<ISO>", "rawTree": <result> }
 *   Fixtures are tracked (a fresh clone needs them to run the harness).
 *
 * ── Running (from the package root, after `npm run build`)
 *   node scripts/harness/snapshot-harness.mjs                 # report (default)
 *   node scripts/harness/snapshot-harness.mjs --save-baseline # freeze current output
 *   node scripts/harness/snapshot-harness.mjs --compare       # diff vs baseline
 *   Optional: --opts '{"detail":"full","limit":2000}'         # override prune opts
 *             --fixtures-dir <dir>  --baseline-dir <dir>
 *
 * Workflow for the pruning flip (CP4):
 *   git stash / checkout the OLD prune, `npm run build`, `--save-baseline`,
 *   restore the NEW prune, `npm run build`, `--compare`. A non-zero exit means
 *   a "needed" element (interactive role or non-empty name) present in the OLD
 *   output is missing from the NEW output — investigate before shipping.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flagValue(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const MODE = argv.includes("--save-baseline")
  ? "save-baseline"
  : argv.includes("--compare")
    ? "compare"
    : "report";
const FIXTURES_DIR = path.resolve(PKG_ROOT, flagValue("--fixtures-dir", "scripts/harness/fixtures"));
const BASELINE_DIR = path.resolve(PKG_ROOT, flagValue("--baseline-dir", "scripts/harness/baseline"));
const PRUNE_OPTS = JSON.parse(flagValue("--opts", "{}"));

// "Needed" = an element the agent would plausibly act on or read. Dropping one
// silently is the regression we are guarding against. Mirrors prune's notion of
// interactive roles; non-empty name covers headings/labels/landmarks.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "listbox", "option",
  "slider", "spinbutton", "switch",
]);
const isNeeded = (n) => INTERACTIVE_ROLES.has(n.role) || (n.name && n.name.length > 0);

// ── load prune from the built bundle ────────────────────────────────
const BUNDLE = path.join(PKG_ROOT, "dist", "test-exports.mjs");
if (!fs.existsSync(BUNDLE)) {
  console.error(`[harness] missing ${path.relative(PKG_ROOT, BUNDLE)} — run \`npm run build\` first.`);
  process.exit(2);
}
const { prune, serializeTree } = await import(pathToFileURL(BUNDLE).href);

// ── fixtures ────────────────────────────────────────────────────────
function loadFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"));
      return { name: f.replace(/\.json$/, ""), ...fx };
    });
}

function flatten(tree) {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

// Inventory entry per kept node — the comparable identity + the fields a diff
// would care about. Keyed by `ref` (= frozen fixture nodeId → deterministic).
function inventoryOf(pruned) {
  return flatten(pruned)
    .filter((n) => n.ref !== undefined)
    .map((n) => ({
      ref: String(n.ref),
      role: n.role,
      name: n.name ?? "",
      value: n.value ?? "",
      flags: [
        n.checked !== undefined ? `checked=${n.checked}` : null,
        n.selected ? "selected" : null,
        n.disabled ? "disabled" : null,
        n.values ? `values=${n.values.length}` : null,
      ]
        .filter(Boolean)
        .join(","),
    }));
}

function analyze(fx) {
  const opts = { ...PRUNE_OPTS };
  if (fx.rawTree?.cssViewport && !opts.viewport) opts.viewport = fx.rawTree.cssViewport;
  const pruned = prune(fx.rawTree, opts);
  const meta = pruned.meta ?? {};
  const treeOnly = { ...pruned };
  delete treeOnly.meta;
  return {
    inventory: inventoryOf(pruned),
    meta,
    jsonSize: JSON.stringify(treeOnly).length,
    // CP3: byte size of the compact indented outline that now ships in
    // payload.tree, for the old(JSON)-vs-new(text) token comparison.
    textSize: serializeTree(treeOnly).length,
    opts,
  };
}

// ── modes ───────────────────────────────────────────────────────────
function report(fixtures) {
  console.log(`[harness] report — ${fixtures.length} fixture(s), opts=${JSON.stringify(PRUNE_OPTS)}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("fixture", 24), pad("kept", 6), pad("candidates", 11), pad("fallback", 9), pad("json-bytes", 11), pad("text-bytes", 11), "saved");
  console.log("-".repeat(86));
  let totJson = 0;
  let totText = 0;
  for (const fx of fixtures) {
    const a = analyze(fx);
    totJson += a.jsonSize;
    totText += a.textSize;
    const saved = a.jsonSize ? `${Math.round((1 - a.textSize / a.jsonSize) * 100)}%` : "-";
    console.log(
      pad(fx.name, 24),
      pad(a.inventory.length, 6),
      pad(a.meta.total_candidates ?? "?", 11),
      pad(a.meta.viewport_fallback ? "YES" : "-", 9),
      pad(a.jsonSize, 11),
      pad(a.textSize, 11),
      saved,
    );
  }
  console.log("-".repeat(86));
  const totSaved = totJson ? `${Math.round((1 - totText / totJson) * 100)}%` : "-";
  console.log(pad("TOTAL", 24), pad("", 6), pad("", 11), pad("", 9), pad(totJson, 11), pad(totText, 11), totSaved);
}

function saveBaseline(fixtures) {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  for (const fx of fixtures) {
    const a = analyze(fx);
    const out = { fixture: fx.name, url: fx.url ?? "", opts: a.opts, meta: a.meta, jsonSize: a.jsonSize, inventory: a.inventory };
    fs.writeFileSync(path.join(BASELINE_DIR, `${fx.name}.json`), JSON.stringify(out, null, 2) + "\n");
    console.log(`[harness] baseline saved: ${fx.name} (${a.inventory.length} kept, ${a.jsonSize} json-bytes)`);
  }
}

function compare(fixtures) {
  let neededDrops = 0;
  for (const fx of fixtures) {
    const baselinePath = path.join(BASELINE_DIR, `${fx.name}.json`);
    if (!fs.existsSync(baselinePath)) {
      console.log(`[harness] ${fx.name}: NO BASELINE — run --save-baseline first (skipping)`);
      continue;
    }
    const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const cur = analyze(fx);
    const baseByRef = new Map(base.inventory.map((n) => [n.ref, n]));
    const curByRef = new Map(cur.inventory.map((n) => [n.ref, n]));

    const dropped = base.inventory.filter((n) => !curByRef.has(n.ref));
    const added = cur.inventory.filter((n) => !baseByRef.has(n.ref));
    const changed = cur.inventory.filter((n) => {
      const b = baseByRef.get(n.ref);
      return b && (b.role !== n.role || b.name !== n.name || b.value !== n.value || b.flags !== n.flags);
    });
    const neededDropped = dropped.filter(isNeeded);
    neededDrops += neededDropped.length;

    console.log(
      `\n=== ${fx.name} ===  kept ${base.inventory.length} → ${cur.inventory.length}` +
        `  |  -${dropped.length} +${added.length} ~${changed.length}` +
        `  |  candidates ${base.meta?.total_candidates ?? "?"} → ${cur.meta?.total_candidates ?? "?"}` +
        `  |  json-bytes ${base.jsonSize} → ${cur.jsonSize}`,
    );
    if (neededDropped.length) {
      console.log(`  ⚠ ${neededDropped.length} NEEDED element(s) dropped:`);
      for (const n of neededDropped.slice(0, 25))
        console.log(`    - [ref=${n.ref}] ${n.role} "${n.name}"${n.value ? ` =${JSON.stringify(n.value)}` : ""}`);
      if (neededDropped.length > 25) console.log(`    … and ${neededDropped.length - 25} more`);
    }
    const incidentalDrops = dropped.length - neededDropped.length;
    if (incidentalDrops) console.log(`  · ${incidentalDrops} incidental (unnamed/non-interactive) drop(s)`);
  }
  console.log(
    neededDrops
      ? `\n[harness] FAIL — ${neededDrops} needed element(s) dropped vs baseline.`
      : `\n[harness] OK — no needed elements dropped vs baseline.`,
  );
  if (neededDrops) process.exit(1);
}

// ── main ────────────────────────────────────────────────────────────
const fixtures = loadFixtures();
if (fixtures.length === 0) {
  console.error(`[harness] no fixtures in ${path.relative(PKG_ROOT, FIXTURES_DIR)} — capture some first (see header).`);
  process.exit(2);
}
if (MODE === "save-baseline") saveBaseline(fixtures);
else if (MODE === "compare") compare(fixtures);
else report(fixtures);
