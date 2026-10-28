import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_BOX_MESSAGE, CARD_SHELL_ATTRS, CARD_SHELL_CSP, CARD_VIEW_ATTRS, CARD_VIEW_CSP, cardBoxSupported, cardShellDoc, cardViewDoc, fromCardBox } from "./card-box";

// The wall itself is proven in a real Chromium (server/card-box.integration.test.ts); these hold its shape.

test("both frames: scripts, but no same-origin, forms, popups or navigation of others; the policy twice", () => {
  for (const a of [CARD_SHELL_ATTRS, CARD_VIEW_ATTRS]) {
    assert.equal(a.sandbox, "allow-scripts");
    assert.equal(a.referrerpolicy, "no-referrer");
  }
  assert.equal(CARD_SHELL_ATTRS.csp, CARD_SHELL_CSP);
  assert.equal(CARD_VIEW_ATTRS.csp, CARD_VIEW_CSP);
  for (const csp of [CARD_SHELL_CSP, CARD_VIEW_CSP]) {
    assert.ok(csp.startsWith("default-src 'none';"));
    // Nothing over the network, whichever directive is read.
    assert.doesNotMatch(csp, /https?:|wss?:|\*|'self'/);
    assert.match(csp, /frame-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
  }
});

test("each document starts with its policy, before any script", () => {
  const view = cardViewDoc("body{color:red}</style><script>x()</script>");
  assert.ok(view.indexOf(`content="${CARD_VIEW_CSP}"`) < view.indexOf("<script>"));
  assert.ok(!view.includes("</style><script>x()"), "base styles can't close their element");
  const shell = cardShellDoc(view);
  assert.ok(shell.indexOf(`content="${CARD_SHELL_CSP}"`) < shell.indexOf("<script>"));
  // The view's document rides inside the shell's script, never closing it.
  assert.equal(shell.split("</script>").length, 2);
});

test("the page takes only its card's shell's messages", () => {
  const shell = {};
  const ok = { [CARD_BOX_MESSAGE]: 1, op: "api", msg: { x: 1 } };
  assert.deepEqual(fromCardBox({ source: shell, data: ok }, shell), { op: "api", msg: { x: 1 } });
  assert.equal(fromCardBox({ source: {}, data: ok }, shell), null, "another frame");
  assert.equal(fromCardBox({ source: null, data: ok }, shell), null);
  assert.equal(fromCardBox({ source: shell, data: ok }, null), null, "no shell yet");
  assert.equal(fromCardBox({ source: shell, data: { op: "api" } }, shell), null, "not a box message");
  assert.equal(fromCardBox({ source: shell, data: { [CARD_BOX_MESSAGE]: 1, op: "navigate" } }, shell), null, "an unknown op");
  assert.deepEqual(fromCardBox({ source: shell, data: { [CARD_BOX_MESSAGE]: 1, op: "height", height: 120 } }, shell), { op: "height", height: 120 });
  assert.equal(fromCardBox({ source: shell, data: { [CARD_BOX_MESSAGE]: 1, op: "height", height: "120" } }, shell), null);
  assert.deepEqual(fromCardBox({ source: shell, data: { [CARD_BOX_MESSAGE]: 1, op: "focus", user: "yes" } }, shell), { op: "focus", user: false });
});

test("a browser without the frame's csp attribute runs no view", () => {
  assert.equal(cardBoxSupported({ csp: "" }), true);
  assert.equal(cardBoxSupported({}), false);
  assert.equal(cardBoxSupported(undefined), false);
});
