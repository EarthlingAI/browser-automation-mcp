// Tool-metadata sweep. Every tool must declare:
//   - title (display name)
//   - description (agent-facing)
//   - inputSchema (zod)
//   - annotations (all 4 hints explicit)
//
// Per the MCP best-practices guide, read-only tools that omit `readOnlyHint`
// can be silently gated out of planning-phase agent runtimes. Conversely,
// write tools must NEVER declare `readOnlyHint: true`. This sweep is the
// single source of truth for those expectations.

import test from "node:test";
import assert from "node:assert/strict";
import {
  registerTabTools,
  registerObserveTools,
  registerInteractTools,
  registerNetTools,
  BridgeSession,
} from "../../dist/test-exports.mjs";

// Expected annotations per tool. Update this table when adding a new tool —
// it doubles as the read-only-hint policy doc.
const EXPECTED = {
  // Tabs
  browser_list_tabs: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_open_tab: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  browser_close_tab: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
  },
  browser_switch_tab: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_release_tab: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_activate_tab: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_resize: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_handle_dialog: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  // Observe
  browser_snapshot: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_console_messages: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_network_requests: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  // Interact
  browser_navigate: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_navigate_back: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_click: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_click_xy: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_draw: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_type: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_select_option: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_fill_form: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_hover: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  browser_scroll: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  browser_upload: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_drag: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_drop: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_press_key: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_evaluate: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_wait_for: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  browser_clipboard: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
  },
  // Net (privileged data primitives)
  browser_fetch: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
  browser_cookies: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
};

function collectRegisteredTools() {
  // Fake McpServer that captures every registerTool call so we can inspect
  // the metadata without booting a real transport.
  const captured = new Map();
  const fakeServer = {
    registerTool(name, config /* , cb */) {
      captured.set(name, config);
    },
  };
  // Fake context — handlers are never invoked here, so a stub daemon shaped
  // like a DaemonClient (sessionId only) is enough for registration time.
  const ctx = {
    daemon: {
      sessionId: "test-session",
      takeEnv: () => undefined,
      peekEnv: () => undefined,
    },
    session: new BridgeSession(),
  };
  registerTabTools(fakeServer, ctx);
  registerObserveTools(fakeServer, ctx);
  registerInteractTools(fakeServer, ctx);
  registerNetTools(fakeServer, ctx);
  return captured;
}

test("every expected tool is registered exactly once", () => {
  const tools = collectRegisteredTools();
  for (const name of Object.keys(EXPECTED)) {
    assert.ok(tools.has(name), `expected tool ${name} was not registered`);
  }
  // No surprise extras.
  for (const name of tools.keys()) {
    assert.ok(EXPECTED[name], `unexpected tool ${name} was registered`);
  }
  assert.equal(tools.size, Object.keys(EXPECTED).length);
});

test("every tool declares title, description, inputSchema, annotations", () => {
  const tools = collectRegisteredTools();
  for (const [name, cfg] of tools) {
    assert.ok(cfg.title, `${name} missing title`);
    assert.ok(cfg.description, `${name} missing description`);
    assert.ok(cfg.inputSchema, `${name} missing inputSchema`);
    assert.ok(cfg.annotations, `${name} missing annotations`);
    const a = cfg.annotations;
    assert.equal(typeof a.readOnlyHint, "boolean", `${name} readOnlyHint not boolean`);
    assert.equal(
      typeof a.destructiveHint,
      "boolean",
      `${name} destructiveHint not boolean`,
    );
    assert.equal(
      typeof a.idempotentHint,
      "boolean",
      `${name} idempotentHint not boolean`,
    );
    assert.equal(typeof a.openWorldHint, "boolean", `${name} openWorldHint not boolean`);
  }
});

test("annotation hints match the policy table", () => {
  const tools = collectRegisteredTools();
  for (const [name, want] of Object.entries(EXPECTED)) {
    const a = tools.get(name).annotations;
    assert.equal(a.readOnlyHint, want.readOnly, `${name}.readOnlyHint`);
    assert.equal(a.destructiveHint, want.destructive, `${name}.destructiveHint`);
    assert.equal(a.idempotentHint, want.idempotent, `${name}.idempotentHint`);
    assert.equal(a.openWorldHint, want.openWorld, `${name}.openWorldHint`);
  }
});
