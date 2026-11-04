// Run: pnpm test:int -- server/settings-browser.integration.test.ts
// Chrome's sockets need a short temp dir: the file picks its own (settings-browser-temp.ts), so a long
// TMPDIR never fails it; with no short writable one at all it skips, saying why.
// Settings in a real browser (§app.settings-dialog/save-bar), against a throwaway server
// (server/testing/hermetic-server.ts) serving this tree's frontend, built fresh into the scratch root
// (a stale dist/ would test old code). Per tab: the dialog opens clean; an edit says "Unsaved: <form>";
// Save Changes says "Saved <form>."; a reload and reopen shows the value; an invalid box is red, keeps
// what was typed, the footer names the form and Save waits; Reset to Defaults leaves no red box and
// saves; a reload shows the default. The forms' every field is src/lib/settings-forms-roundtrip.test.ts
// (unit) and every route server/settings-roundtrip.integration.test.ts: this file is the seams between
// them (the boxes, the footer, the reload), which only a browser sees.
// Its own slow group ("settings", scripts/test-groups.mjs): a landing runs it only when settings code
// changes. Chrome is found as the tour tests find it (discoverTourBrowser): none installed fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";
import { discoverTourBrowser } from "./tours/browser";
import { chooseBrowserTemp } from "./settings-browser-temp";
import { scratchRoot } from "./test-scratch";

const ROOT = resolve(import.meta.dirname, "..");
let s: HermeticServer;
let browser: Browser;
let page: Page;
const temp = chooseBrowserTemp();
const skip = "skip" in temp ? temp.skip : undefined;
const shortTmp = "dir" in temp ? temp.dir : undefined;
const keptTmpdir = process.env.TMPDIR;

before(async () => {
  if (skip) return;
  // Chrome (and Playwright's profile for it) put their sockets under TMPDIR: the short one chosen.
  process.env.TMPDIR = shortTmp;
  const dist = join(scratchRoot("sova-settings-browser-"), "dist");
  mkdirSync(dist, { recursive: true });
  execFileSync("node", [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  s = await startHermeticServer({ env: { SOVA_DIST: dist } });
  browser = await chromium.launch({ executablePath: discoverTourBrowser(), headless: true, env: { ...process.env, TMPDIR: shortTmp! } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "x-sova-token": s.token }, serviceWorkers: "block" });
  page = await ctx.newPage();
}, { timeout: 180_000 });
after(async () => {
  await browser?.close();
  // The server's scratch root is under the short temp dir: stop it (and check its HOME) first.
  const changed = await s?.stop();
  if (keptTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = keptTmpdir;
  if ("cleanup" in temp) temp.cleanup();
  assert.deepEqual(changed ?? [], [], "the sentinel HOME changed");
});

const NAMES: Record<string, string> = { general: "General", models: "Models", subagents: "Subagents", alignment: "Alignment", overseer: "Overseer", notifications: "Notifications", decisions: "Decisions", summaries: "Summaries", memory: "Memory", organizations: "Organizations", mesh: "Mesh", "public-links": "Public links" };
/** The Settings dialog (the close-hold asks in a dialog of its own). */
const dialog = () => page.locator('[role="dialog"]:has(#settings-foot-status)');
const status = async () => ((await page.locator("#settings-foot-status").textContent()) ?? "").replace(/\s+/g, " ").trim();
const saveButton = () => dialog().getByRole("button", { name: "Save Changes", exact: true });
/** Polls until `check` holds (the page settles on its own time), else fails saying what it last saw. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what}: never happened (footer: "${await status().catch(() => "?")}")`);
}
const statusIs = (want: string | RegExp) => until(`footer reads ${want}`, async () => (typeof want === "string" ? (await status()) === want : want.test(await status())));

/** A fresh page load (every draft forgotten), Settings open on `tab`, its forms loaded and clean. */
async function open(tab: string, ready: () => ReturnType<Page["locator"]>): Promise<void> {
  // A real load: a hash change alone keeps the page, its drafts and its last "Saved".
  await page.goto("about:blank");
  await page.goto(`${s.base}/#/settings/${tab}`);
  await dialog().waitFor({ timeout: 30_000 });
  await dialog().getByRole("tab", { name: NAMES[tab], exact: true }).or(dialog().locator("nav").getByRole("button", { name: NAMES[tab], exact: true })).first().click();
  await ready().first().waitFor({ state: "attached", timeout: 15_000 });
  await statusIs("");
  assert.equal(await saveButton().count(), 0, `${tab}: Save Changes shows on a clean dialog`);
  assert.equal(await dialog().locator('[aria-invalid="true"]').count(), 0, `${tab}: a red box on a clean dialog`);
}
async function save(label: string): Promise<void> {
  await statusIs(`Unsaved: ${label}`);
  assert.equal(await saveButton().isDisabled(), false, `${label}: Save Changes is disabled on a valid edit`);
  await saveButton().click();
  await statusIs(`Saved ${label}.`);
}
/** A box typed into: it keeps the text, goes red, the footer names the form, and Save waits.
    `keys`: typed key by key (what freezes a box that holds a number, not text: D2, D2b). */
async function refused(box: ReturnType<Page["locator"]>, text: string, label: string, keys = false): Promise<void> {
  if (keys) {
    await box.fill("");
    await box.pressSequentially(text);
  } else await box.fill(text);
  await until(`${label}: "${text}" turns its box red`, async () => (await box.getAttribute("aria-invalid")) === "true");
  assert.equal(await box.inputValue(), text, `${label}: the box doesn't keep "${text}" as typed`);
  const said = await status();
  assert.match(said, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${label}: the footer doesn't name the form: "${said}"`);
  assert.equal(await saveButton().isDisabled(), true, `${label}: Save Changes is enabled over "${text}"`);
}
const checkbox = (label: string | RegExp) => dialog().getByRole("checkbox", { name: label });
const box = (sel: string) => dialog().locator(sel);
/** A group's Reset to Defaults: in the Overseer group's fieldset, else beside its section heading. */
const resetIn = (heading: string) =>
  dialog().locator(`fieldset:has(> legend:text-is("${heading}")), .settings-type-head:has(h3:text-is("${heading}"))`).getByRole("button", { name: "Reset to Defaults" }).first();
/** A switch: the box is drawn by its label (visually hidden), so it is clicked through it. */
async function setSwitch(label: string | RegExp, on: boolean): Promise<void> {
  const c = checkbox(label);
  // What the user clicks: the switch's label (the box itself is drawn off-screen).
  if ((await c.isChecked()) !== on) await c.evaluate((e) => ((e.closest("label") as HTMLElement | null) ?? (e as HTMLElement)).click());
  await until(`the switch ${label} moves`, async () => (await c.isChecked()) === on);
  assert.equal(await c.isChecked(), on, `the switch ${label} didn't move`);
}

describe("Settings in a browser: edit, save, reload, invalid, reset", { timeout: 280_000, skip }, () => {
  test("Overseer: a limit up to 1000 saves (D1); a half-typed or too-large box stays red as typed (D2); over-long notes wait (D5); Reset to Defaults recovers", async () => {
    const cap = () => box("#overseer-cap-concurrentSessions");
    await open("overseer", cap);
    await cap().fill("600");
    await save("Overseer");
    await open("overseer", cap);
    assert.equal(await cap().inputValue(), "600");
    for (const t of ["", "1e", "-5", "1.5", "1001", "a5"]) await refused(cap(), t, "Overseer");
    for (const t of ["-3", "2.5", "1e"]) await refused(cap(), t, "Overseer", true);
    // The co-worker's report: Reset to Defaults over a red box leaves no red box and saves.
    await resetIn("Limits").click();
    await until("Reset to Defaults clears every red box", async () => (await dialog().locator('[aria-invalid="true"]').count()) === 0);
    assert.equal(await cap().inputValue(), "10");
    await save("Overseer");
    await open("overseer", cap);
    assert.equal(await cap().inputValue(), "10");
    assert.equal(await resetIn("Limits").isDisabled(), true, "Limits' Reset to Defaults is enabled at the defaults (D4)");
    await refused(box("#overseer-notes"), "n".repeat(8001), "Overseer");
  });

  test("Models: a provider switch and its At once box save together; a half-typed At once is red", async () => {
    const zai = () => dialog().getByLabel("Requests at once for zai", { exact: true });
    await open("models", zai);
    await refused(zai(), "1e", "Request limits");
    await zai().fill("7");
    await setSwitch("Allow subagents to use zai", false);
    await statusIs("Unsaved: Models, Request limits");
    await saveButton().click();
    await statusIs("Saved Models and Request limits.");
    await open("models", zai);
    assert.equal(await zai().inputValue(), "7");
    assert.equal(await checkbox("Allow subagents to use zai").isChecked(), false);
  });

  test("General: Updates' switches save and reload", async () => {
    const auto = () => checkbox("Check for updates automatically");
    await open("general", auto);
    await setSwitch("Check for updates automatically", false);
    await save("Updates");
    await open("general", auto);
    assert.equal(await auto().isChecked(), false);
  });

  test("General: Sessions in Recent saves as typed and, on leaving, repairs to the nearest count it can show, saying so", async () => {
    // The operator's exception to "keep it red" (no Save: it is this browser's own setting).
    const recent = () => box("#recent-count");
    await open("general", recent);
    for (const [typed, fixed] of [["7.5", "8"], ["0", "3"], ["999", "20"], ["7.4", "7"]] as const) {
      await recent().fill("");
      await recent().pressSequentially(typed);
      await recent().press("Tab");
      await until(`"${typed}" becomes ${fixed} on leaving`, async () => (await recent().inputValue()) === fixed);
      await until(`the repair to ${fixed} is announced`, async () => (await page.getByText(`Recent shows ${fixed} sessions.`).count()) > 0);
      assert.equal(await saveButton().count(), 0, "Sessions in Recent never holds Save");
    }
    await open("general", recent);
    assert.equal(await recent().inputValue(), "7", "a reload keeps the repaired count");
  });

  test("Subagents: a pasted 60-character name stays whole and red with its count, Save waits, and shortening it clears that (D10)", async () => {
    const edit = () => box("#subagents-edit-my-setup");
    await open("subagents", edit);
    await edit().click();
    const name = box("#subagents-name");
    await name.waitFor({ timeout: 15_000 });
    const sixty = "P".repeat(60);
    await name.fill("");
    await name.focus();
    // A paste is one text insertion (a box's maxlength would cut it to 48 here).
    await page.keyboard.insertText(sixty);
    await until("the 60-character name turns its box red", async () => (await name.getAttribute("aria-invalid")) === "true");
    assert.equal(await name.inputValue(), sixty, "the pasted name was cut");
    assert.equal(((await box("#subagents-name-count").textContent()) ?? "").trim(), "60 / 48");
    assert.match(await status(), /Subagents/, "the footer names Subagents");
    assert.equal(await saveButton().isDisabled(), true, "Save Changes is enabled over a 60-character name");
    await name.fill("P".repeat(48));
    await until("a 48-character name clears the red box", async () => (await name.getAttribute("aria-invalid")) === null);
    assert.equal(((await box("#subagents-name-count").textContent()) ?? "").trim(), "48 / 48");
    await save("Subagents");
    await open("subagents", edit);
    await edit().click();
    await box("#subagents-name").waitFor({ timeout: 15_000 });
    assert.equal(await box("#subagents-name").inputValue(), "P".repeat(48));
  });

  test("Subagents → Teams: a cleared or 'abc' Wrap-up context % stays as typed and red; Save waits (D14)", { todo: "D14" }, async () => {
    const edit = () => box("#subagents-edit-my-setup");
    await open("subagents", edit);
    await edit().click();
    await dialog().locator("summary", { hasText: "Teams" }).first().click();
    await setSwitch("Add a coordinator to new teams", true);
    await setSwitch("Add a monitor to new teams", true);
    const pct = box("#subagents-my-setup-contextPct");
    await pct.waitFor({ timeout: 15_000 });
    for (const t of ["", "abc", "1.", "500"]) await refused(pct, t, "Subagents");
    for (const t of ["-3", "2.5"]) await refused(pct, t, "Subagents", true);
  });

  test("Alignment: a switch saves and reloads", async () => {
    const draw = () => checkbox("Draw when it helps");
    await open("alignment", draw);
    await setSwitch("Draw when it helps", true);
    await save("Alignment");
    await open("alignment", draw);
    assert.equal(await draw().isChecked(), true);
  });

  test("Notifications: a kind's switch saves and reloads", async () => {
    const kind = () => checkbox(/^Subagent error/);
    await open("notifications", kind);
    await setSwitch(/^Subagent error/, true);
    await save("Phone Notifications");
    await open("notifications", kind);
    assert.equal(await kind().isChecked(), true);
  });

  test("Decisions: a switch saves; a folder that isn't a full path waits", async () => {
    const tui = () => checkbox("Never send TUI sessions");
    await open("decisions", tui);
    await setSwitch("Never send TUI sessions", true);
    await save("Decisions");
    await open("decisions", tui);
    assert.equal(await tui().isChecked(), true);
    await box("#decisions-exclusions").fill("relative/path");
    await until("Decisions' problem in the footer", async () => /Decisions/.test(await status()));
    assert.equal(await saveButton().isDisabled(), true);
  });

  test("Summaries: Session titles' minutes save, a half-typed one is red as typed, Reset to Defaults recovers", async () => {
    const interval = () => box("#session-titles-interval");
    await open("summaries", interval);
    await interval().fill("10");
    await save("Session titles");
    await open("summaries", interval);
    assert.equal(await interval().inputValue(), "10");
    for (const t of ["", "1e", "0", "1441"]) await refused(interval(), t, "Session titles");
    for (const t of ["-3", "2.5", "1e"]) await refused(interval(), t, "Session titles", true);
    await resetIn("Session titles").click();
    await until("Reset to Defaults clears every red box", async () => (await dialog().locator('[aria-invalid="true"]').count()) === 0);
    await save("Session titles");
    await open("summaries", interval);
    assert.equal(await interval().inputValue(), "5");
    assert.equal(await resetIn("Session titles").isDisabled(), true, "Session titles' Reset to Defaults is enabled at the defaults");
  });

  test("Memory: a summary size saves, and Reset to Defaults puts it back", async () => {
    const size = () => box("#memory-size-zoomable");
    await open("memory", size);
    await size().selectOption("64");
    await save("Memory");
    await open("memory", size);
    assert.equal(await size().inputValue(), "64");
    await resetIn("Summary size").click();
    await save("Memory");
    await open("memory", size);
    assert.equal(await size().inputValue(), "32");
  });

  test("Organizations: the message limit saves; out of range is red as typed", async () => {
    const limit = () => dialog().getByRole("textbox", { name: /^Message limit/ });
    await open("organizations", limit);
    await limit().fill("100");
    await save("Organizations");
    await open("organizations", limit);
    assert.equal(await limit().inputValue(), "100");
    for (const t of ["", "0", "1001", "1e"]) await refused(limit(), t, "Organizations");
    for (const t of ["-3", "2.5", "1e"]) await refused(limit(), t, "Organizations", true);
  });

  test("Mesh: the host's name saves; a blank one waits", async () => {
    const name = () => box("#mesh-host-label");
    await open("mesh", name);
    await name().fill("test-box");
    await save("Mesh");
    await open("mesh", name);
    assert.equal(await name().inputValue(), "test-box");
    await name().fill("");
    await until("Mesh's problem in the footer", async () => /Mesh|name/.test(await status()));
    assert.equal(await saveButton().isDisabled(), true);
  });

  test("Public links: Log visitors saves and reloads", async () => {
    const log = () => checkbox(/^Log visitors/);
    await open("public-links", log);
    await setSwitch(/^Log visitors/, true);
    await save("Visitor logging");
    await open("public-links", log);
    assert.equal(await log().isChecked(), true);
  });
});
