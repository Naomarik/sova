#!/usr/bin/env node
// E2E: Settings saves from the dialog's footer (§app.settings-dialog/save-bar).
//
// Drives a hermetic server — `pnpm run dev:hermetic` in THIS worktree, which serves the built app
// (`pnpm run build` first) on 4810 with PI_CODING_AGENT_DIR=<worktree>/.agent — through the
// playwright skill's own browser (start-browser.sh: an isolated Chromium on a freshly claimed CDP
// port, stopped at the end). Every write is checked on disk in that .agent, so the script refuses
// a server whose files live anywhere else (the real ~/.pi, another worktree's .agent).
//
//   pnpm run build && pnpm run dev:hermetic        # in one terminal
//   pnpm run e2e:settings-footer-save              # in another
//
// Env: SOVA_E2E_PORT (default 4810) when 4810 is held by another worktree's server and this one
// runs the same command on another port; SOVA_E2E_SHOTS, a folder for the footer screenshots.
// The playwright skill needs its node_modules (`npm ci` in .claude/skills/playwright/scripts, or a
// symlink to another checkout's).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = join(ROOT, ".agent");
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SOVA_E2E_SHOTS ?? null;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");

let passed = 0;
const failures = [];
/** One named check: a failure is recorded and the run goes on, so one report says everything. */
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(err?.message ?? err).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const eq = (actual, expected, what) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const api = async (path) => {
  const r = await fetch(`${BASE}${path}`, { headers: tokenHeaders(AGENT) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const meshFile = join(AGENT, "sova", "peers.json");
/** This host's name as peers.json stores it (`self.label`). */
const meshLabelOnDisk = () => (existsSync(meshFile) ? (readJson(meshFile).self?.label ?? null) : null);

// ---- preflight: the server is this worktree's hermetic one ----
try {
  const d = await api("/api/settings/decisions");
  assert(d.file.startsWith(AGENT + "/"), `the server on ${PORT} writes ${d.file}, not into ${AGENT}: start this worktree's hermetic server (pnpm run dev:hermetic)`);
} catch (err) {
  console.error(`preflight: ${err.message}`);
  process.exit(2);
}
if (!existsSync(join(SKILL, "node_modules", "playwright"))) {
  console.error(`preflight: no playwright in ${SKILL}/node_modules — run npm ci there, or symlink another checkout's`);
  process.exit(2);
}

const skillRequire = createRequire(join(SKILL, "package.json"));
const { chromium } = skillRequire("playwright");
const started = execFileSync(join(SKILL, "start-browser.sh"), ["--headless"], { cwd: SKILL, stdio: ["ignore", "pipe", "pipe"] }).toString();
const cdpPort = /PW_PORT=(\d+)/.exec(started)?.[1];
if (!cdpPort) throw new Error(`start-browser.sh printed no PW_PORT:\n${started}`);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

try {
  // The token on every request the page makes (the gate's header): no unlock screen to pass.
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, colorScheme: "dark", extraHTTPHeaders: tokenHeaders(AGENT) });
  const page = await context.newPage();
  // The app's service worker serves the build it cached, not the one on disk: drop it first.
  await page.goto(`${BASE}/`);
  await page.evaluate(async () => {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await r.unregister();
    for (const k of (await caches?.keys?.()) ?? []) await caches.delete(k);
  });
  await page.goto(`${BASE}/`);
  await page.reload();
  assert((await page.evaluate(() => innerWidth)) === 1280, "viewport width");

  const dialog = page.getByRole("dialog", { name: "Settings" });
  const foot = dialog.locator(".settings-foot");
  const footButton = (name) => foot.getByRole("button", { name, exact: true });
  const status = dialog.locator("#settings-foot-status");
  const tab = (name) => dialog.getByRole("tab", { name, exact: true });
  const panel = dialog.locator(".settings-panel");
  const openTab = async (name, ready) => {
    await tab(name).click();
    if (ready) await ready.waitFor({ state: "visible", timeout: 20000 });
  };
  const hostInput = dialog.locator("#mesh-host-label");
  const neverTui = dialog.getByRole("checkbox", { name: "Never send TUI sessions" });
  /** A switch's input is drawn by its label (the box is visual only): click the label to move it. */
  const setSwitch = async (input, on) => {
    await input.waitFor({ state: "attached", timeout: 20000 });
    if ((await input.isChecked()) !== on) await input.locator("xpath=ancestor::label[1]").click();
    assert((await input.isChecked()) === on, "the switch moved");
  };

  const waitStatus = async (text) => {
    try {
      await page.waitForFunction(([t]) => document.querySelector("#settings-foot-status")?.textContent?.trim() === t, [text], { timeout: 20000 });
    } catch {
      throw new Error(`footer status: expected ${JSON.stringify(text)}, got ${JSON.stringify((await status.textContent())?.trim())}`);
    }
  };
  const shot = async (name, locator = dialog) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await locator.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
  };

  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await dialog.waitFor({ state: "visible" });

  const decisionsFile = (await api("/api/settings/decisions")).file;
  const tuiOnDisk = () => (existsSync(decisionsFile) ? readJson(decisionsFile).neverSendTui : (null));

  console.log(`settings-footer-save e2e against ${BASE} (agent dir ${AGENT})`);

  await check("no form has a Save bar: every tab's panel has no Save Changes or Discard Changes", async () => {
    for (const [name, ready] of [
      ["General", dialog.locator("#recent-count")],
      ["Models", dialog.locator(".model-policy-list")],
      ["Modes", dialog.locator(".settings-delegate-file").nth(1)],
      ["Teams", dialog.locator("#team-contextPct")],
      ["Overseer", dialog.locator("#overseer-extra-prompt")],
      ["Decisions", dialog.locator("#decisions-exclusions")],
      ["Summaries", dialog.locator("#summarizer-primary-model")],
      ["Themes", null],
      ["Mesh", hostInput],
      ["Experimental", dialog.locator(".settings-provider")],
    ]) {
      await openTab(name, ready);
      if (name === "Summaries") await shot("dialog-summaries");
      for (const b of ["Save Changes", "Discard Changes"])
        eq(await panel.getByRole("button", { name: b }).count(), 0, `${name}: "${b}" buttons in the panel`);
    }
  });

  await check("clean: the footer offers Close only, and says nothing", async () => {
    await openTab("General", dialog.locator("#recent-count"));
    eq(await footButton("Close").count(), 1, "Close");
    eq(await footButton("Save Changes").count(), 0, "Save Changes");
    eq(await footButton("Discard Changes").count(), 0, "Discard Changes");
    eq((await status.textContent()).trim(), "", "status");
    await shot("footer-clean", foot);
    await shot("dialog-clean");
  });

  const tui0 = tuiOnDisk() ?? false;
  const label0 = (await api("/api/mesh/settings")).hostLabel;
  const label1 = `e2e-${Date.now().toString(36)}`;

  await check("dirty: edits on 2 tabs; the footer names both and reads Discard Changes · Save Changes · Cancel", async () => {
    await openTab("Decisions", dialog.locator("#decisions-exclusions"));
    await setSwitch(neverTui, !tui0);
    await openTab("Mesh", hostInput);
    await hostInput.fill(label1);
    await waitStatus("Unsaved: Decisions, Mesh");
    const names = await foot.getByRole("button").allTextContents();
    eq(names.map((n) => n.trim()), ["Discard Changes", "Save Changes", "Cancel"], "footer buttons, left to right");
    assert(await footButton("Save Changes").isEnabled(), "Save Changes is enabled");
    await shot("footer-dirty", foot);
    await shot("dialog-dirty-mesh");
  });

  await check("Modes tab: its forms end in the Stored in line, and the footer is the dialog's", async () => {
    await openTab("Modes", dialog.locator(".settings-delegate-file").nth(1));
    eq(await dialog.getByRole("button", { name: "Reset to Defaults" }).count(), 1, "Delegate's Reset to Defaults (in its heading)");
    const inHead = await dialog.locator(".settings-type-head").getByRole("button", { name: "Reset to Defaults" }).count();
    eq(inHead, 1, "Reset to Defaults sits in the section heading");
    await shot("dialog-modes-dirty");
  });

  await check("Save from a third tab (General) writes both forms; the files on disk say so", async () => {
    await openTab("General", dialog.locator("#recent-count"));
    await footButton("Save Changes").click();
    await waitStatus("Saved Decisions and Mesh.");
    eq(tuiOnDisk(), !tui0, `neverSendTui in ${decisionsFile}`);
    eq(meshLabelOnDisk(), label1, `hostLabel in ${meshFile}`);
    eq(await footButton("Close").count(), 1, "Close is back");
    eq(await footButton("Save Changes").count(), 0, "Save Changes is gone");
    eq(await tab("General").getAttribute("aria-selected"), "true", "stayed on General");
  });

  await check("Discard reverts every tab, and writes nothing", async () => {
    await openTab("Decisions", dialog.locator("#decisions-exclusions"));
    await setSwitch(neverTui, tui0);
    await openTab("Mesh", hostInput);
    await hostInput.fill(`${label1}-x`);
    await waitStatus("Unsaved: Decisions, Mesh");
    await footButton("Discard Changes").click();
    await waitStatus("");
    eq(await hostInput.inputValue(), label1, "Mesh name");
    await openTab("Decisions", dialog.locator("#decisions-exclusions"));
    eq(await neverTui.isChecked(), !tui0, "Decisions switch");
    eq(tuiOnDisk(), !tui0, "decisions file unchanged");
    eq(meshLabelOnDisk(), label1, "mesh file unchanged");
    eq(await footButton("Close").count(), 1, "Close");
  });

  await check("an invalid form disables Save, and the footer names it", async () => {
    await openTab("Decisions", dialog.locator("#decisions-exclusions"));
    await setSwitch(neverTui, tui0);
    await openTab("Mesh", hostInput);
    await hostInput.fill("  ");
    await waitStatus("Mesh: This host needs a name.");
    assert(await footButton("Save Changes").isDisabled(), "Save Changes is disabled");
    eq(await dialog.locator("#mesh-host-label-hint.field-error").count(), 1, "the field says it inline too");
    await shot("footer-invalid", foot);
    await hostInput.fill(label1);
    await waitStatus("Unsaved: Decisions");
    assert(await footButton("Save Changes").isEnabled(), "Save Changes is enabled again");
    await footButton("Discard Changes").click();
    await waitStatus("");
  });

  await check("a failing save: the others stay saved, the dialog opens the failed tab, and its banner says why", async () => {
    await page.route("**/api/settings/decisions", (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected failure" }) }) : route.fallback(),
    );
    const label2 = `${label1}-2`;
    await openTab("Decisions", dialog.locator("#decisions-exclusions"));
    await setSwitch(neverTui, tui0);
    await openTab("Mesh", hostInput);
    await hostInput.fill(label2);
    await openTab("General", dialog.locator("#recent-count"));
    await footButton("Save Changes").click();
    await waitStatus("Saved Mesh; Decisions failed.");
    eq(meshLabelOnDisk(), label2, "the mesh save stands");
    eq(tuiOnDisk(), !tui0, "the decisions file is unchanged");
    eq(await tab("Decisions").getAttribute("aria-selected"), "true", "the dialog is on Decisions");
    const banner = dialog.locator(".banner-error", { hasText: "Couldn't save the decision settings." });
    await banner.waitFor({ state: "visible", timeout: 5000 });
    assert((await banner.textContent()).includes("Injected failure."), "the banner quotes the server");
    eq(await neverTui.isChecked(), tui0, "the edit is kept");
    await shot("footer-failed", foot);
    await shot("dialog-failed");
    await page.unroute("**/api/settings/decisions");
    // An edit clears the failure; Save then writes it.
    await setSwitch(neverTui, !tui0);
    await setSwitch(neverTui, tui0);
    await waitStatus("Unsaved: Decisions");
    await footButton("Save Changes").click();
    await waitStatus("Saved Decisions.");
    eq(tuiOnDisk(), tui0, "the retry is written");
  });

  await check("Reset to Defaults in a section's heading changes the draft only", async () => {
    const ctx = dialog.locator("#team-contextPct");
    await openTab("Teams", ctx);
    const reset = dialog.locator(".settings-type-head").getByRole("button", { name: "Reset to Defaults" });
    const teamInfo = await api("/api/settings/team");
    const def = teamInfo.defaults.monitor.contextPct;
    // Neither the default nor what an earlier run saved: the edit must make the form dirty.
    const custom = [55, 56, 57].find((v) => v !== def && v !== teamInfo.settings.monitor.contextPct);
    await ctx.fill(String(custom));
    await waitStatus("Unsaved: Teams");
    await footButton("Save Changes").click();
    await waitStatus("Saved Teams.");
    const teamFile = (await api("/api/settings/team")).file;
    eq(readJson(teamFile).monitor.contextPct, custom, "saved value on disk");
    assert(await reset.isEnabled(), "Reset to Defaults is enabled off the defaults");
    await reset.click();
    eq(await ctx.inputValue(), String(def), "the field shows the default");
    await waitStatus("Unsaved: Teams");
    eq(readJson(teamFile).monitor.contextPct, custom, "the file is unchanged");
    await footButton("Discard Changes").click();
    eq(await ctx.inputValue(), String(custom), "Discard brings the saved value back");
  });

  await check("Cancel with unsaved edits holds the close and asks", async () => {
    await openTab("Mesh", hostInput);
    await hostInput.fill(`${label1}-cancel`);
    await openTab("General", dialog.locator("#recent-count"));
    await footButton("Cancel").click();
    await dialog.getByText("Your Mesh changes aren't saved.").waitFor({ state: "visible", timeout: 5000 });
    assert(await dialog.isVisible(), "the dialog stays open");
    eq(await tab("Mesh").getAttribute("aria-selected"), "true", "it brings the edit's tab forward");
    await shot("dialog-close-held");
    await dialog.getByRole("button", { name: "Keep Editing" }).click();
    await footButton("Discard Changes").click();
    await waitStatus("");
    await footButton("Close").click();
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
  });

  await check("folded (390px): status and Cancel share a line, Discard · Save the next; every button inside the sheet", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert((await page.evaluate(() => innerWidth)) === 390, "viewport width 390");
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await dialog.waitFor({ state: "visible" });
    await openTab("Mesh", hostInput);
    await hostInput.fill(`${label1}-phone`);
    await waitStatus("Unsaved: Mesh");
    const box = await foot.boundingBox();
    const at = {};
    for (const name of ["Discard Changes", "Save Changes", "Cancel"]) {
      const b = await footButton(name).boundingBox();
      assert(b && box && b.x >= box.x && b.x + b.width <= box.x + box.width + 0.5, `${name} fits the footer`);
      assert(b.height >= 44, `${name} is a 44px target (${b.height}px)`);
      at[name] = b;
    }
    const line = await status.boundingBox();
    const middle = (b) => Math.round(b.y + b.height / 2);
    eq(middle(at["Discard Changes"]), middle(at["Save Changes"]), "Discard and Save share a row");
    assert(at["Cancel"].y + at["Cancel"].height <= at["Save Changes"].y, "Cancel is on the line above them");
    assert(line.y < at["Cancel"].y + at["Cancel"].height && line.y + line.height > at["Cancel"].y, "the status shares Cancel's line");
    assert(Math.abs(at["Save Changes"].x + at["Save Changes"].width - (box.x + box.width - 16)) < 1, "Save sits at the trailing edge");
    await shot("footer-dirty-folded", foot);
    await footButton("Discard Changes").click();
  });
} finally {
  try {
    await browser.close();
  } catch {}
  try {
    execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
  } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
