// The Forms in a browser group's shared harness (scripts/test-groups.mjs, group "forms"): one Chrome per
// area file against a throwaway server (server/testing/hermetic-server.ts) serving this tree's frontend,
// built fresh into the scratch root (a stale dist/ would test old code), signed in by the server's
// cookie as the operator's browser is (some saves refuse a script header). Chrome's sockets need a
// short temp dir: it picks its own (settings-browser-temp.test.helper.ts); with no short writable one it skips.
// Not a test file: each area's *browser.integration.test.ts imports it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";
import { discoverTourBrowser } from "./tours/browser";
import { chooseBrowserTemp } from "./settings-browser-temp.test.helper";
import { scratchRoot } from "./test-scratch";

const ROOT = resolve(import.meta.dirname, "..");

export interface FormsBrowser {
  /** Why the file skips (no short writable temp dir), else undefined. */
  skip: string | undefined;
  s: HermeticServer;
  page: Page;
}

/** Registers before/after for one area file: build, server, Chrome, a signed-in page. */
export function formsBrowser(prefix: string, viewport = { width: 1440, height: 1000 }): FormsBrowser {
  const temp = chooseBrowserTemp();
  const skip = "skip" in temp ? temp.skip : undefined;
  const shortTmp = "dir" in temp ? temp.dir : undefined;
  const keptTmpdir = process.env.TMPDIR;
  let browser: Browser | undefined;
  const h = { skip } as FormsBrowser;
  before(async () => {
    if (skip) return;
    // Chrome (and Playwright's profile for it) put their sockets under TMPDIR: the short one chosen.
    process.env.TMPDIR = shortTmp;
    const dist = join(scratchRoot(prefix), "dist");
    mkdirSync(dist, { recursive: true });
    execFileSync("node", [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    h.s = await startHermeticServer({ env: { SOVA_DIST: dist } });
    browser = await chromium.launch({ executablePath: discoverTourBrowser(), headless: true, env: { ...process.env, TMPDIR: shortTmp! } });
    const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
    const { authCookieName } = await import("./auth");
    await ctx.addCookies([{ name: authCookieName(h.s.agentDir), value: h.s.token, url: h.s.base }]);
    h.page = await ctx.newPage();
  }, { timeout: 180_000 });
  after(async () => {
    await browser?.close();
    // The server's scratch root is under the short temp dir: stop it (and check its HOME) first.
    const changed = await h.s?.stop();
    if (keptTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = keptTmpdir;
    if ("cleanup" in temp) temp.cleanup();
    assert.deepEqual(changed ?? [], [], "the sentinel HOME changed");
  });
  return h;
}

/** Polls until `check` holds (the page settles on its own time), else fails naming `what` and `seen()`. */
export async function until(what: string, check: () => Promise<boolean>, timeoutMs = 15_000, seen?: () => Promise<string>): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what}: never happened${seen ? ` (${await seen().catch(() => "?")})` : ""}`);
}

const COUNT = /^\d[\d,]* \/ \d[\d,]*$/;

/** Types `text` into `box`: filled at once, key by key (what freezes a box holding a number: D2, D2b),
    or pasted (one text insertion, which a maxlength would cut). */
export async function typeInto(box: Locator, text: string, how: "fill" | "keys" | "paste" = "fill"): Promise<void> {
  if (how === "fill") return box.fill(text);
  await box.fill("");
  if (how === "keys") return box.pressSequentially(text);
  await box.focus();
  await box.page().keyboard.insertText(text);
}

/** The kit's red state: the box keeps `text` as typed, is aria-invalid, and names exactly one visible
    red sentence (`.field-error`) through aria-describedby; its hint and its "n / most" count may sit
    beside it. No other red sentence shows in its field. Returns the sentence. */
export async function isRed(box: Locator, text: string, what: string): Promise<string> {
  await until(`${what}: "${text}" turns its box red`, async () => (await box.getAttribute("aria-invalid")) === "true");
  assert.equal(await box.inputValue(), text, `${what}: the box doesn't keep "${text}" as typed`);
  // One read of the page at a time (the box, its describedby targets, its field), polled until it settles.
  const read = () =>
    box.evaluate((el, countRe) => {
      const count = new RegExp(countRe);
      const vis = (n: Element | null): n is HTMLElement => !!n && n.getClientRects().length > 0;
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const text = (n: Element) => (n.textContent ?? "").replace(/\s+/g, " ").trim();
      const named = ids.map((id) => document.getElementById(id)).filter(vis).filter((n) => n.classList.contains("field-error")).map(text).filter((t) => t && !count.test(t));
      const field = el.closest(".field");
      const shown = field ? [...field.querySelectorAll(".field-error")].filter(vis).map(text).filter((t) => t && !count.test(t)) : named;
      return { invalid: el.getAttribute("aria-invalid"), named, shown, ids, html: (field ?? el.parentElement)?.outerHTML.slice(0, 1500) ?? "" };
    }, COUNT.source);
  let r = await read();
  const end = Date.now() + 5_000;
  while ((r.invalid !== "true" || r.named.length !== 1 || JSON.stringify(r.shown) !== JSON.stringify(r.named)) && Date.now() < end) {
    await new Promise((res) => setTimeout(res, 100));
    r = await read();
  }
  assert.equal(r.invalid, "true", `${what}: "${text}" went back to not red`);
  assert.equal(r.named.length, 1, `${what}: "${text}" names ${r.named.length} red sentences (${JSON.stringify(r.named)}), want one; describedby ${JSON.stringify(r.ids)}; field ${r.html}`);
  assert.deepEqual(r.shown, r.named, `${what}: "${text}" shows other red sentences in its field`);
  return r.named[0]!;
}

/** Types three characters key by key into `box` and asserts it is the same element afterwards, still
    attached and still focused: a box rebuilt by a keystroke (a reactive read in the call that draws it)
    loses focus and every key after the first, whatever caused the rebuild. Leaves `text` typed. */
export async function keepsFocus(box: Locator, what: string, text = "123"): Promise<void> {
  await box.fill("");
  await box.focus();
  const before = await box.elementHandle();
  assert.ok(before, `${what}: no box`);
  await box.page().keyboard.type(text, { delay: 30 });
  assert.equal(await before.evaluate((el) => el.isConnected), true, `${what}: typing rebuilt the box (the element it started in is gone)`);
  assert.equal(await before.evaluate((el) => document.activeElement === el), true, `${what}: the box lost focus while typing`);
  assert.equal(await before.evaluate((el) => (el as HTMLInputElement).value), text, `${what}: the box kept "${await before.evaluate((el) => (el as HTMLInputElement).value)}" of "${text}"`);
  await before.dispose();
}

/** Before any project registration: `root` is a scratch folder (under the temp dir) holding its own
    repository, so neither the server nor its conform runs can reach a parent's .git (a folder inside a
    worktree resolves to that repository's main checkout). Throws otherwise. */
export function assertOwnRepo(root: string): void {
  const real = realpathSync(root);
  const tmp = realpathSync(process.env.TMPDIR ?? tmpdir());
  assert.ok(real.startsWith(tmp + sep), `refusing to register ${real}: not under the temp dir ${tmp}`);
  assert.ok(existsSync(join(real, ".git")), `refusing to register ${real}: it has no .git of its own`);
  const top = execFileSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  assert.equal(realpathSync(top), real, `refusing to register ${real}: git resolves it to ${top}`);
}
