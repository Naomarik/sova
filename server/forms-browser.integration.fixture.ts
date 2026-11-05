// The Forms in a browser group's shared harness (scripts/test-groups.mjs, group "forms"): one Chrome per
// area file against a throwaway server (server/testing/hermetic-server.ts) serving this tree's frontend,
// built fresh into the scratch root (a stale dist/ would test old code), signed in by the server's
// cookie as the operator's browser is (some saves refuse a script header). Chrome's sockets need a
// short temp dir: it picks its own (settings-browser-temp.ts); with no short writable one it skips.
// Not a test file: each area's *browser.integration.test.ts imports it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";
import { discoverTourBrowser } from "./tours/browser";
import { chooseBrowserTemp } from "./settings-browser-temp";
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
  const ids = ((await box.getAttribute("aria-describedby")) ?? "").split(/\s+/).filter(Boolean);
  const page = box.page();
  const messages: string[] = [];
  for (const id of ids) {
    const el = page.locator(`[id="${id}"]`);
    if ((await el.count()) === 0 || !(await el.isVisible())) continue;
    if (!(await el.evaluate((n) => n.classList.contains("field-error")))) continue;
    const t = ((await el.textContent()) ?? "").replace(/\s+/g, " ").trim();
    // A count ("12 / 48") turns red over its most, but is not a sentence.
    if (t && !COUNT.test(t)) messages.push(t);
  }
  assert.equal(messages.length, 1, `${what}: "${text}" names ${messages.length} red sentences (${JSON.stringify(messages)}), want one`);
  const inField = await box.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' field ')][1]").locator(".field-error:visible").allTextContents();
  const shown = inField.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && !COUNT.test(t));
  assert.deepEqual(shown, messages, `${what}: "${text}" shows other red sentences in its field`);
  return messages[0]!;
}
