// Run: pnpm test:int -- server/forms-claude-models-browser.integration.test.ts
// What an open Settings page shows while Claude Code's table changes (§app.claude-code-provider/model-table),
// in a real Chrome: the one quiet line, and a learned model reaching the page's model selects with no
// reload. A stand-in `claude` program holds real table rows; no real Claude Code or login is involved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { chooseBrowserTemp } from "./settings-browser-temp.test.helper";
import { until } from "./forms-browser.test.helper";
import { scratchRoot } from "./test-scratch";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";
import { discoverTourBrowser } from "./tours/browser";

const ROOT = join(import.meta.dirname, "..");
const LINE = "Showing the last known Claude models: Sova couldn't read Claude Code's model table.";
const NEXT = "claude-fable-9-1";
const fixture = JSON.parse(readFileSync(join(ROOT, "pi-config/extensions/claude-code/tests/fixtures/claude-tables/2.1.321.json"), "utf8")) as { rows: string[]; latestPerFamily: string };
const row = fixture.rows.find((r) => r.includes('id:"claude-fable-5-2"'))!.replaceAll("claude-fable-5-2", NEXT);
const GOOD = `const T=[${[...fixture.rows, row].join(",")}];var c={latest_per_family:${fixture.latestPerFamily.replace(/fable:"[^"]+"/, `fable:"${NEXT}"`)}};`;

const temp = chooseBrowserTemp();
const skip = "skip" in temp ? temp.skip : undefined;
const shortTmp = "dir" in temp ? temp.dir : undefined;
const keptTmpdir = process.env.TMPDIR;
let browser: Browser | undefined;
let s: HermeticServer | undefined;

after(async () => {
  await browser?.close();
  await s?.stop();
  if (keptTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = keptTmpdir;
  if ("cleanup" in temp) temp.cleanup();
});

test("the quiet line comes and goes, and a learned model reaches the open page, with no reload", { skip, timeout: 180_000 }, async () => {
  process.env.TMPDIR = shortTmp;
  const scratch = scratchRoot("sova-claude-models-browser-");
  const dist = join(scratch, "dist");
  mkdirSync(dist, { recursive: true });
  execFileSync("node", [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });

  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, "claude");
  let revision = 0;
  const install = (table: string) => {
    const tmp = `${exe}.${++revision}`;
    writeFileSync(tmp, `#!/bin/sh\n# ${revision} ${table}\nexec node ${JSON.stringify(join(ROOT, "scripts", "fake-claude.mjs"))} "$@"\n`);
    chmodSync(tmp, 0o755);
    renameSync(tmp, exe);
  };
  install("function R(){return 1}");
  const PATH = [bin, ...(process.env.PATH ?? "").split(":").filter((d) => d && !existsSync(join(d, "claude")))].join(":");
  s = await startHermeticServer({ extensions: ["claude-code"], env: { SOVA_DIST: dist, PATH, SOVA_MODELS_FETCH: "on", SOVA_CLAUDE_TABLE: "on", SOVA_CLAUDE_TABLE_POLL_MS: "100" } });

  browser = await chromium.launch({ executablePath: discoverTourBrowser(), headless: true, env: { ...process.env, TMPDIR: shortTmp! } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const { authCookieName } = await import("./auth");
  await ctx.addCookies([{ name: authCookieName(s.agentDir), value: s.token, url: s.base }]);
  const page: Page = await ctx.newPage();

  await page.goto(`${s.base}/#/settings/profiles`);
  const dialog = page.locator('[role="dialog"]:has(#settings-foot-status)');
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByRole("tab", { name: "Profiles", exact: true }).or(dialog.locator("nav").getByRole("button", { name: "Profiles", exact: true })).first().click();
  const seen = async () => ((await dialog.textContent()) ?? "").replace(/\s+/g, " ").slice(0, 800);
  const line = page.getByText(LINE, { exact: true });
  const fableNext = page.locator("option", { hasText: "Fable 9.1" });

  await until("the unreadable table's line shows", async () => (await line.count()) >= 1, 30_000, seen);
  assert.equal(await line.count(), 1, "one line, not one per row");
  assert.equal(await line.isVisible(), true);
  assert.equal(await fableNext.count(), 0, "not learned yet");
  await page.evaluate(() => void ((window as unknown as { __sameLoad: boolean }).__sameLoad = true));

  // A Claude Code with a table Sova can read: both changes reach this page on the server's push.
  install(GOOD);
  await until("the line goes at the good read", async () => (await line.count()) === 0, 30_000, seen);
  await until("the learned model reaches the open page's selects", async () => (await fableNext.count()) > 0, 30_000, seen);

  // Unreadable again, then no program at all: the line shows, then isn't for that case.
  install("function R(){return 2}");
  await until("the line is back", async () => (await line.count()) === 1, 30_000, seen);
  assert.ok((await fableNext.count()) > 0, "the last good list stays");
  rmSync(exe);
  await until("no line with no claude program", async () => (await line.count()) === 0, 30_000, seen);
  assert.ok((await fableNext.count()) > 0, "and the list still stands");
  assert.equal(await page.evaluate(() => (window as unknown as { __sameLoad?: boolean }).__sameLoad), true, "all of it with no reload");
});
