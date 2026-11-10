import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DESIGN_NONCE_SLOT, DESIGN_PAGE_CSP, DESIGN_SHELL_ATTRS, DESIGN_STREAM_ATTRS, DESIGN_STREAM_CSP, designHasFirstPaint, designHasStyles, designPageCsp, designPageDoc, designShellDoc, designStreamDoc, fromDesignFrame, versionLabel } from "./design-frame";

const directives = (csp: string) => new Map(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)] as const));

test("a page's network is Google Fonts and its own data, in every state of a page", () => {
  for (const csp of [DESIGN_PAGE_CSP, DESIGN_STREAM_CSP]) {
    const d = directives(csp);
    assert.deepEqual(d.get("default-src"), ["'none'"]);
    assert.deepEqual(d.get("connect-src"), ["'none'"]);
    assert.deepEqual(d.get("frame-src"), ["'none'"]);
    assert.deepEqual(d.get("form-action"), ["'none'"]);
    assert.deepEqual(d.get("base-uri"), ["'none'"]);
    assert.ok(d.get("font-src")!.includes("https://fonts.gstatic.com"));
    assert.ok(d.get("style-src")!.includes("https://fonts.googleapis.com"));
    assert.ok(!d.get("img-src")!.some((s) => s.startsWith("http")), "no image from the web");
  }
  assert.equal(directives(DESIGN_STREAM_CSP).get("script-src"), undefined, "no scripts while it is written");
  assert.deepEqual(directives(designPageCsp("n")).get("script-src"), ["'nonce-n'", "'unsafe-eval'"], "only the nonce's boot runs inline");
});

/** The document a shell really gives its page frame: its own script, run. */
function builtBy(html: string, motion = true): string {
  const shell = designShellDoc(designPageDoc(html, { motion }));
  const script = shell.slice(shell.indexOf("<script>") + "<script>".length, shell.lastIndexOf("</script>"));
  const frame: Record<string, unknown> & { srcdoc?: string } = { setAttribute() {}, addEventListener() {}, style: {} };
  vm.runInNewContext(script, { document: { createElement: () => frame, body: { append() {} } }, parent: { postMessage() {} }, addEventListener() {}, setTimeout() {}, crypto, Array, Uint8Array, Object, JSON });
  return frame.srcdoc!;
}

test("the policy and the seal come before anything the page wrote", () => {
  const doc = builtBy("<!doctype html><html><head><script>window.X=1</script></head><body>hi</body></html>");
  const csp = doc.indexOf("Content-Security-Policy");
  const rtc = doc.indexOf("RTC");
  const mine = doc.indexOf("window.X");
  assert.ok(csp >= 0 && rtc > csp && mine > rtc);
});

test("the real nonce is only in Sova's head, even on a page that writes the slot's name", () => {
  const page = `<iframe srcdoc="<script nonce='${DESIGN_NONCE_SLOT}'>x</script>"></iframe><script>const n="${DESIGN_NONCE_SLOT}"</script>`;
  const doc = builtBy(page);
  const nonce = /nonce="([0-9a-f]{36})"/.exec(doc)?.[1];
  assert.ok(nonce, "a real nonce was made");
  assert.equal(doc.split(nonce!).length - 1, 2, "in the policy and on the boot script, nowhere else");
  assert.ok(doc.endsWith(page), "the page's text is exactly as written");
  assert.notEqual(builtBy(page).match(/nonce="([0-9a-f]{36})"/)?.[1], nonce, "fresh for each document");
});

test("only the nonce's boot runs inline, and it runs the page's scripts itself", () => {
  const held = designPageDoc("<script>one</script>", { motion: true }).head;
  assert.equal(held.split(`nonce="${DESIGN_NONCE_SLOT}"`).length, 2, "one script carries the nonce");
  assert.match(held, /querySelectorAll\("script:not\(\[src\]\)"\)/);
  assert.match(held, /meta\[http-equiv\]/, "and its policy tag is taken out of view");
});

test("a grid card holds motion and the full view runs it", () => {
  const held = designPageDoc("x", { motion: false }).head;
  const running = designPageDoc("x", { motion: true }).head;
  assert.match(held, /animation-duration:0s/);
  assert.match(held, /window\.requestAnimationFrame=/);
  assert.doesNotMatch(running, /animation-duration:0s/);
  assert.doesNotMatch(running, /window\.requestAnimationFrame=/);
});

test("the streaming document runs nothing and the empty sandbox says so", () => {
  assert.equal(DESIGN_STREAM_ATTRS.sandbox, "");
  assert.ok(designStreamDoc("<p>so far").endsWith("<p>so far"));
  assert.doesNotMatch(designStreamDoc("<p>"), /<script/);
  assert.equal(DESIGN_SHELL_ATTRS.sandbox, "allow-scripts allow-forms");
});

test("the shell escapes the page so a closing script tag in it can't end the shell's own script", () => {
  const doc = designShellDoc(designPageDoc("a</script><b>", { motion: true }));
  assert.equal(doc.indexOf("</script>"), doc.lastIndexOf("</script>"), "only the shell's own closing tag");
});

test("a page draws once its first style block closes, whatever its case", () => {
  assert.equal(designHasStyles("<style>a{}"), false);
  assert.equal(designHasStyles("<style>a{}</style>"), true);
  assert.equal(designHasStyles("<STYLE>a{}</STYLE >"), true);
});

test("a shell's word counts only from this frame's own shell", () => {
  const shell = {};
  const data = { "sova-design-frame": 1, op: "left" };
  assert.equal(fromDesignFrame({ source: shell, data }, shell), "left");
  assert.equal(fromDesignFrame({ source: {}, data }, shell), null, "another frame");
  assert.equal(fromDesignFrame({ source: shell, data: { op: "left" } }, shell), null, "no tag");
  assert.equal(fromDesignFrame({ source: shell, data: { "sova-design-frame": 1, op: "other" } }, shell), null, "no such word");
  assert.equal(fromDesignFrame({ source: null, data }, null), null, "no shell yet");
});

test("versions are named by label, with the first unnumbered", () => {
  assert.equal(versionLabel("A", 1), "A");
  assert.equal(versionLabel("A", 2), "A2");
  assert.equal(versionLabel("AB", 3), "AB3");
});

test("a page being written has something to see only once its body has text", () => {
  const styles = "<html><head><style>body{color:red}</style>";
  assert.equal(designHasFirstPaint("<style>a{}"), false);
  assert.equal(designHasFirstPaint(styles), false);
  assert.equal(designHasFirstPaint(`${styles}</head><body class="x">`), false);
  assert.equal(designHasFirstPaint(`${styles}</head><body><header>\n<nav class="n"><a href="#">`), false);
  assert.equal(designHasFirstPaint(`${styles}</head><body><header><a href="#">Tea`), true);
  assert.equal(designHasFirstPaint(`${styles}${" ".repeat(4000)}`), true);
});

test("a page being written is inert in its own frame, whatever holds it: a click can't follow a link out", () => {
  assert.equal(DESIGN_STREAM_ATTRS.inert, "");
  assert.equal(DESIGN_STREAM_ATTRS.sandbox, "");
});

test("a finished page says it has drawn only after its fonts and its opening animations, each with a time limit", () => {
  const { head } = designPageDoc("<p>x</p>", { motion: true });
  assert.match(head, /document\.fonts\.ready[^;]*\.then\(settled\)[^;]*\.then\(said\)/, "fonts, then animations, then the word");
  assert.match(head, /getAnimations\(\)[\s\S]*isFinite\(t\.endTime\)/, "an endless animation is never waited for");
  assert.equal((head.match(/setTimeout\(r,1500\)/g) ?? []).length, 2, "each wait is capped");
});
