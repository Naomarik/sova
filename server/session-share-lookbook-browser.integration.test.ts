// A shared Lookbook's wall in a real Chrome (§app.session-share/lookbook-view, /lookbook-serving,
// §chat.design-mode/prototype-frame): the real share listener serving a scratch build of the share
// page, a chat with a Lookbook on disk, and Chrome with every request answered here (Google Fonts by
// stand-ins, everything else off-host refused and noted). A hostile design tries every way out
// (fetch, beacon, image, form post, window.open, top and parent navigation, reading its parent,
// cookies and storage, fetching its own share's /api/s): nothing reaches a listening server, the
// share's page stays where it is, and nothing opens. Each way of replacing its own document is
// stopped. A benign design with an inline script and a Google font runs and loads its font, so a
// wall that shows only a blank frame can't pass; and with the iframe `csp` attribute gone (a
// browser that can't wall a running page), the same design is a still with its scripts off.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, BrowserContext, Frame, Page } from "playwright-core";
import { DESIGN_FRAME_LEFT, DESIGN_NOTE_TAG, designScriptsDropped } from "../src/lib/design-frame";
import { STILL_LINE } from "../src/share/lookbook-model";
import { bigPage, hostilePages, LB_RUN, LB_SESSION_ID, LB_SHOWN, writeLookbookChat } from "./session-share-lookbook.test.helper";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const root = scratchRoot("sova-lb-wall-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const { launchTourBrowser } = await import("./tours/browser");
const { createShareServer } = await import("./share/listener");
const { createShare } = await import("./session-shares");
const { changeDesign, writePage } = await import("./design/store");

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

/** Every request that reached a listening server and named a leak. */
const hits: string[] = [];
const leak = createServer((req, res) => {
  hits.push(`elsewhere ${req.method} ${req.url}`);
  res.setHeader("access-control-allow-origin", "*");
  res.end("x");
});
const share = createShareServer({ client: () => randomUUID() });
share.on("request", (req: { method?: string; url?: string }) => {
  if (/leak/.test(req.url ?? "")) hits.push(`share ${req.method} ${req.url}`);
});
const L = `http://127.0.0.1:${await listen(leak)}`;
const S = `http://127.0.0.1:${await listen(share)}`;

const fx = writeLookbookChat(join(root, "agent"));
const { share: rec, tokens } = createShare({ sessionId: LB_SESSION_ID, sessionPath: fx.sessionPath, title: "Lookbook", mode: "live", cut: null, days: 30, labels: ["Wall"], anyone: false });
void rec;
const TOKEN = tokens[0]!.token;

// The hostile design K joins the shared run: version 1 tries everything that keeps its document,
// each later one replaces it one way.
const hostile = hostilePages(L, S, `${S}/api/s/${TOKEN}`);
{
  const dir = join(root, "agent", "design", encodeURIComponent(LB_SESSION_ID));
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { designs: Record<string, unknown>[]; runs: { id: string; labels: string[] }[] };
  const like = state.designs.find((d) => d.label === "A")!;
  state.designs.push({ ...like, label: "K", direction: "Hostile", layout: undefined, modelName: "Mk Hostile Model", versions: hostile.map((_, i) => ({ n: i + 1, at: new Date(Date.UTC(2026, 8, 30, 0, 0, 5 + i)).toISOString(), chars: 100, by: "first" })) });
  state.runs.find((r) => r.id === LB_RUN)!.labels.push("K");
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  mkdirSync(join(dir, "K"), { recursive: true });
  hostile.forEach((html, i) => writeFileSync(join(dir, "K", `v${i + 1}.html`), html));
  // M: a page of 24 MB, most of the way to the full-size document cap (SESSION_SHARE_DESIGN_MAX_BYTES, 32 MiB).
  state.designs.push({ ...like, label: "M", direction: "Long", layout: undefined, modelName: "Mk Long Model", versions: [{ n: 1, at: new Date(Date.UTC(2026, 8, 30, 0, 0, 5)).toISOString(), chars: 1, by: "first" }] });
  state.runs.find((r) => r.id === LB_RUN)!.labels.push("M");
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  mkdirSync(join(dir, "M"), { recursive: true });
  writeFileSync(join(dir, "M", "v1.html"), bigPage(24));
  // N: code the redactor's name guesses once rewrote (`e.key=[redacted]'Escape'`, so nothing ran), and one script
  // that really doesn't parse.
  state.designs.push({ ...like, label: "N", direction: "Keys", layout: undefined, modelName: "Mk Keys Model", versions: [{ n: 1, at: new Date(Date.UTC(2026, 8, 30, 0, 0, 5)).toISOString(), chars: 1, by: "first" }] });
  state.runs.find((r) => r.id === LB_RUN)!.labels.push("N");
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  mkdirSync(join(dir, "N"), { recursive: true });
  writeFileSync(join(dir, "N", "v1.html"), `<!doctype html><html><body><h1 id="h">VISIBLE-LB-KEYS</h1><p id="ran">not yet</p><script>let key='draft';const keyOf=(x)=>x;key=keyOf(key);const cfg={"token": "abc"};const e={key:'Escape'};if(e.key==='Escape'&&cfg.token==='abc')document.getElementById('ran').textContent='key code ran';</script><script>if(</script></body></html>`);
}

const FONT = readFileSync(join(ROOT, "public", "fonts", "IBMPlexSans-Variable.woff2"));
let browser: Browser;
/** Google Fonts requests the stand-ins answered, and every other off-host request (refused). */
const fonts: string[] = [];
const offHost: string[] = [];

before(async () => {
  const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--mode", "share", "--outDir", process.env.SOVA_SHARE_DIST!, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
  share.close();
  share.closeAllConnections();
  leak.close();
});

/** A fresh tab on `path` under the share listener, every request answered here. `still`: as a browser without the iframe `csp` attribute. */
async function open(path: string, o: { still?: boolean; width?: number } = {}): Promise<{ page: Page; ctx: BrowserContext; popups: string[]; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: 900 } });
  const popups: string[] = [];
  if (o.still) await ctx.addInitScript(() => void delete (HTMLIFrameElement.prototype as unknown as { csp?: string }).csp);
  await ctx.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === S || url.origin === L) return route.continue();
    if (url.hostname === "fonts.googleapis.com") {
      fonts.push(url.href);
      return route.fulfill({ status: 200, contentType: "text/css", headers: { "access-control-allow-origin": "*" }, body: `@font-face{font-family:'Inter';font-style:normal;font-weight:400 700;src:url(https://fonts.gstatic.com/s/inter/v1/stand-in.woff2) format('woff2')}` });
    }
    if (url.hostname === "fonts.gstatic.com") {
      fonts.push(url.href);
      return route.fulfill({ status: 200, contentType: "font/woff2", headers: { "access-control-allow-origin": "*" }, body: FONT });
    }
    offHost.push(url.href);
    return route.abort();
  });
  const page = await ctx.newPage();
  ctx.on("page", (p) => void popups.push(p.url() || "about:blank"));
  // What any of its frames logged as an error, from before the first one loads.
  const errors: string[] = [];
  page.on("console", (m) => void (m.type() === "error" && errors.push(m.text())));
  await page.goto(S + path);
  return { page, ctx, popups, errors };
}

/** The frame element a design draws in: the open view's, else the design page's. */
const frameElement = (page: Page) => page.locator("dialog.lb-open iframe.lb-frame, main.lb-page iframe.lb-frame").first();

/** The running page's frame (the shell's child, whatever its address) of the design on show, once its heading reads `heading`.
    Found by the element, never by its address, so a change of address can't hide a frame. */
async function designFrame(page: Page, heading: string): Promise<Frame> {
  for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const shell = await (await frameElement(page).elementHandle({ timeout: 1000 }).catch(() => null))?.contentFrame();
    const f = shell?.childFrames()[0];
    if (f && (await f.locator("#h").textContent({ timeout: 200 }).catch(() => null)) === heading) return f;
  }
  assert.fail(`no running page reading ${heading}: ${page.frames().map((f) => f.url()).join(" | ")}`);
}

describe("a shared Lookbook in Chrome", () => {
  test("a benign design runs its inline script and loads its Google font; the block shows its tiles", async () => {
    const { page, ctx } = await open(`/s/${TOKEN}`);
    try {
      await page.locator("section.lb-block").first().waitFor({ timeout: 20_000 });
      assert.equal(await page.locator("section.lb-block .lb-title").first().textContent(), "Lookbook · 5 designs");
      for (const l of ["A", "B", "K", "M", "N"]) assert.equal(await page.locator(`article.lb-tile[aria-label="Design ${l}"]`).count(), 1, `tile ${l}`);
      await ctx.close();
      const full = await open(`/s/${TOKEN}?design=A&v=2`);
      const f = await designFrame(full.page, LB_SHOWN.A.pages[2]);
      await f.waitForFunction(() => document.getElementById("ran")?.textContent === "script ran 2", null, { timeout: 15_000 });
      assert.equal(await f.locator("#h").textContent(), LB_SHOWN.A.pages[2]);
      // The font came from the Google Fonts stand-ins and is in use.
      await f.waitForFunction(() => document.fonts.check("700 16px Inter") && [...document.fonts].some((x) => x.family.replace(/['"]/g, "") === "Inter" && x.status === "loaded"), null, { timeout: 15_000 });
      assert.ok(fonts.some((u) => u.startsWith("https://fonts.googleapis.com/css2")) && fonts.some((u) => u.startsWith("https://fonts.gstatic.com/")), `font requests: ${fonts.join(" ")}`);
      assert.equal(await f.evaluate(() => String(origin)), "null", "an opaque origin");
      assert.equal(await full.page.locator(".lb-page-note").filter({ hasText: STILL_LINE }).count(), 0, "Chrome runs the design: no still line");
      assert.equal(await f.locator(DESIGN_NOTE_TAG).count(), 0, "its code all parses: no note");
      assert.deepEqual(full.errors.filter((t) => /couldn't run/.test(t)), [], "and nothing logged");
      await full.ctx.close();
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test("code the name guesses would rewrite runs on the link; a script that doesn't parse leaves a note and its error in the console", async () => {
    const { page, ctx, errors: logged } = await open(`/s/${TOKEN}?design=N&v=1`);
    try {
      const f = await designFrame(page, "VISIBLE-LB-KEYS");
      await f.waitForFunction(() => document.getElementById("ran")?.textContent === "key code ran", null, { timeout: 15_000 });
      const note = await f.evaluate((tag) => {
        const host = document.querySelector(tag);
        const chip = host?.shadowRoot?.firstElementChild;
        if (!chip) return null;
        const r = chip.getBoundingClientRect();
        // What a click at the chip's middle, and at its dot's, would land on.
        const under = [chip, chip.firstElementChild!].map((e) => {
          const b = e.getBoundingClientRect();
          return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.tagName;
        });
        return { text: host!.shadowRoot!.textContent, left: r.left, bottom: innerHeight - r.bottom, width: r.width, under };
      }, DESIGN_NOTE_TAG);
      assert.ok(note, "the note is on the page");
      assert.equal(note.text, designScriptsDropped(1));
      assert.ok(note.width > 0 && note.left < 40 && note.bottom >= 0 && note.bottom < 40, `drawn in the bottom-left corner: ${JSON.stringify(note)}`);
      assert.ok(note.under.every((t) => t && t !== DESIGN_NOTE_TAG.toUpperCase()), `a click on it reaches the page, never the note: ${note.under}`);
      for (const end = Date.now() + 5000; !logged.some((t) => /couldn't run/.test(t)) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
      assert.ok(logged.some((t) => /This design's script couldn't run/.test(t) && /SyntaxError|Unexpected/.test(t)), `the parse error is logged: ${logged.join(" | ")}`);
    } finally {
      await ctx.close();
    }
  });

  test("a hostile design reaches nothing: no server elsewhere or of the share, no navigation, no window, no storage, no parent", async () => {
    // Control: a tab of the same browser and routing reaches both recorders and gets its off-host
    // request noted, so silence below is the wall's, not a deaf recorder's.
    const control = await open(`/api/s/${TOKEN}?leak=control`);
    await control.page.goto(`${L}/leak/control`);
    await control.page.goto("https://elsewhere.invalid/").catch(() => {});
    await control.ctx.close();
    assert.ok(hits.some((h) => h.startsWith("elsewhere")) && hits.some((h) => h.startsWith("share")) && offHost.length > 0, `control: ${hits.join(" | ")} ${offHost.join(" ")}`);
    hits.length = 0;
    offHost.length = 0;
    const { page, ctx, popups } = await open(`/s/${TOKEN}?design=K&v=1`);
    try {
      const f = await designFrame(page, "VISIBLE-LB-HOSTILE");
      const got = await f.waitForFunction(() => { const t = document.getElementById("tries")?.textContent; return t && t !== "none" ? t : null; }, null, { timeout: 15_000 });
      const tries = JSON.parse((await got.jsonValue())!) as string[];
      const of = (name: string) => tries.find((t) => t.startsWith(`${name}:`));
      for (const name of ["parent-dom", "top-dom", "top-href", "storage", "session", "cookie"]) assert.equal(of(name), `${name}:threw`, `${name}: ${tries.join(" ")}`);
      assert.equal(of("rtc"), "rtc:undefined", "no WebRTC");
      assert.equal(of("origin"), "origin:null", "an opaque origin");
      // The page's own policy and seal are enforced in its frame, whatever its address: the browser
      // reports what it refused, and a fetch it forbids rejects.
      await f.waitForFunction(() => document.getElementById("csp")?.textContent !== "none" && document.getElementById("fetchprobe")?.textContent !== "none", null, { timeout: 10_000 });
      assert.equal(await f.locator("#fetchprobe").textContent(), "rejected", "a fetch the policy forbids rejects");
      const refused = JSON.parse((await f.locator("#csp").textContent())!) as string[];
      for (const directive of ["connect-src", "img-src", "frame-src", "script-src-elem", "style-src-elem"]) assert.ok(refused.some((v) => v.startsWith(`${directive} `)), `the page's policy refused a ${directive} try: ${refused.join(" | ")}`);
      // Its own blob: and data: frames too (Chrome names no address for a local scheme it refuses).
      assert.ok(refused.some((v) => /^frame-src (?!https?:)/.test(v)), `its own blob:/data: frames are refused: ${refused.join(" | ")}`);
      // Nothing the page can read of where it is names the share's link (its token).
      const where = (await f.locator("#where").textContent())!;
      assert.notEqual(where, "none");
      assert.ok(!where.includes(TOKEN), `the design can read the share's token: ${where}`);
      // What was sent is sent by now (each try ran 50 ms after load); a beat for the slowest to land.
      await page.waitForTimeout(1500);
      assert.equal(await page.getByText(DESIGN_FRAME_LEFT).count(), 0, "nothing in this round replaced the design's document");
      // A person clicking the design's own link out goes nowhere either: the shell stops it.
      await f.locator("#out").click();
      await page.getByText(DESIGN_FRAME_LEFT).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      assert.ok(fonts.some((u) => u.includes("family=Leak")), "control: the page's Google Fonts request was made");
      assert.deepEqual(fonts.filter((u) => u.includes(TOKEN)), [], "no Google Fonts request carries the share's token");
      assert.deepEqual(hits, [], "nothing reached a listening server");
      assert.deepEqual(offHost, [], "nothing left for another host");
      assert.deepEqual(popups, [], "no window opened");
      assert.equal(page.url(), `${S}/s/${TOKEN}?design=K&v=1`, "the share's page stayed where it was");
      assert.equal(await page.locator("main.lb-page").count(), 1, "and still shows the design page");
    } finally {
      await ctx.close();
    }
  });

  test("a page of 24 MB, near the document cap, loads, runs and draws whole", async () => {
    const { page, ctx } = await open(`/s/${TOKEN}?design=M&v=1`);
    try {
      const f = await designFrame(page, "VISIBLE-LB-BIG");
      await f.waitForFunction(() => /^script ran \d{4,}$/.test(document.getElementById("ran")?.textContent ?? ""), null, { timeout: 30_000 });
      assert.equal(await f.locator("#end").textContent(), "VISIBLE-LB-BIG-END", "the very end of the page is there");
      await frameElement(page).and(page.locator(".lb-frame-shown")).waitFor({ timeout: 30_000 });
    } finally {
      await ctx.close();
    }
  });

  test("each way of replacing its own document is stopped, and reaches nothing", async () => {
    for (let n = 2; n <= hostile.length; n++) {
      hits.length = 0;
      offHost.length = 0;
      const { page, ctx, popups } = await open(`/s/${TOKEN}?design=K&v=${n}`);
      try {
        await page.getByText(DESIGN_FRAME_LEFT).waitFor({ timeout: 15_000 }).catch(() => assert.fail(`v${n}: the page was not stopped`));
        await page.waitForTimeout(500);
        assert.deepEqual(hits, [], `v${n}: nothing reached a listening server`);
        assert.deepEqual(offHost, [], `v${n}: nothing left for another host`);
        assert.deepEqual(popups, [], `v${n}: no window opened`);
        assert.equal(page.url(), `${S}/s/${TOKEN}?design=K&v=${n}`, `v${n}: the share's page stayed`);
      } finally {
        await ctx.close();
      }
    }
  });

  test("the conversation page with every hostile tile drawn reaches nothing either", async () => {
    hits.length = 0;
    offHost.length = 0;
    const { page, ctx, popups } = await open(`/s/${TOKEN}`);
    try {
      const tile = page.locator('article.lb-tile[aria-label="Design K"]');
      await tile.scrollIntoViewIfNeeded();
      await tile.locator("iframe.lb-frame.lb-frame-shown").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      assert.deepEqual(hits, []);
      assert.deepEqual(offHost, []);
      assert.deepEqual(popups, []);
      assert.equal(page.url(), `${S}/s/${TOKEN}`);
    } finally {
      await ctx.close();
    }
  });

  test("without the iframe csp attribute the design is a still: its scripts don't run, and the page says so once", async () => {
    const { page, ctx } = await open(`/s/${TOKEN}?design=A&v=2`, { still: true });
    try {
      await page.getByText(STILL_LINE).first().waitFor({ timeout: 20_000 });
      let f: Frame | null | undefined;
      for (const end = Date.now() + 15_000; !(f && (await f.locator("#h").count().catch(() => 0))) && Date.now() < end; await new Promise((r) => setTimeout(r, 50)))
        f = await (await frameElement(page).elementHandle({ timeout: 1000 }).catch(() => null))?.contentFrame();
      assert.ok(f, `the still frame: ${page.frames().map((x) => x.url()).join(" | ")}`);
      assert.equal(await f.locator("#h").textContent(), LB_SHOWN.A.pages[2]);
      assert.equal(await f.locator("#ran").textContent(), "not yet", "no script ran");
      assert.deepEqual(f.childFrames().map((x) => x.url()), [], "no running page is ever made: the still is one document");
    } finally {
      await ctx.close();
    }
  });

  test("without the iframe csp attribute the conversation's tiles are stills too: no tile runs a script", async () => {
    const { page, ctx } = await open(`/s/${TOKEN}`, { still: true });
    try {
      const tile = page.locator('article.lb-tile[aria-label="Design A"]');
      await tile.scrollIntoViewIfNeeded();
      const el = tile.locator("iframe.lb-frame");
      await el.waitFor({ timeout: 20_000 });
      let f: Frame | null | undefined;
      for (const end = Date.now() + 15_000; !(f && (await f.locator("#h").count().catch(() => 0))) && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) f = await (await el.elementHandle().catch(() => null))?.contentFrame();
      assert.ok(f, "the tile's still frame");
      assert.equal(await f.locator("#ran").textContent(), "not yet", "the tile ran no script");
      assert.deepEqual(f.childFrames().map((x) => x.url()), []);
      // Version 3 is A's newest finished one, the tile's page.
      assert.equal(await f.locator("#h").textContent(), LB_SHOWN.A.pages[3]);
    } finally {
      await ctx.close();
    }
  });

  test("Follow live: a version finished while the full-size view is open joins its Version picker, and the view stays open on the newest", async () => {
    const { page, ctx } = await open(`/s/${TOKEN}#design=B`);
    try {
      const dialog = page.locator("dialog.lb-open");
      await dialog.waitFor({ timeout: 20_000 });
      const options = () => dialog.locator(".lb-version select option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      assert.deepEqual(await options(), ["1"]);
      await designFrame(page, LB_SHOWN.B.pages[1]);
      writePage(LB_SESSION_ID, "B", 2, `<!doctype html><html><body><h1 id="h">VISIBLE-LB-PAGE-B2</h1></body></html>`);
      changeDesign(LB_SESSION_ID, "B", (d) => void d.versions.push({ n: 2, at: new Date().toISOString(), chars: 60, by: "refine" }));
      await page.waitForFunction(() => [...document.querySelectorAll("dialog.lb-open .lb-version select option")].some((o) => (o as HTMLOptionElement).value === "2"), null, { timeout: 20_000 });
      assert.deepEqual(await options(), ["1", "2"]);
      assert.equal(await dialog.evaluate((d) => (d as HTMLDialogElement).open), true, "the view stayed open");
      const f = await designFrame(page, "VISIBLE-LB-PAGE-B2");
      assert.equal(await f.locator("#h").textContent(), "VISIBLE-LB-PAGE-B2", "it follows the newest in");
      assert.equal(page.url(), `${S}/s/${TOKEN}#design=B`);
    } finally {
      await ctx.close();
    }
  });
});
