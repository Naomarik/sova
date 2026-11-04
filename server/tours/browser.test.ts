import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { macRecordingTmp } from "./sandbox";
import { assertTourBrowserTempPath, chooseTourBrowser, discoverTourBrowser, findMacHeadlessShell, insideAppBundle, pinnedHeadlessShellRevision, TOUR_APP_BROWSER_REFUSAL, TourBrowserSetupError } from "./browser";

test("longest Chromium socket path fits the worst-case supported parent temp root or refuses clearly", () => {
  const base = "/tmp/sova-test-home-XXXXXX/st-XXXXXX";
  const actualSocket = assertTourBrowserTempPath(base);
  assert.equal(Buffer.byteLength(actualSocket), 93);
  assert.ok(Buffer.byteLength(actualSocket) <= 100);
  // This is the nested layout that made the real installed browser SIGTRAP; it must be
  // distinguished from the supported parent-owned base, not merely match a prefix string.
  assert.throws(() => assertTourBrowserTempPath(`${base}/b-XXXXXX/t`), /too long.*shorter writable TMPDIR/);
  assert.throws(() => assertTourBrowserTempPath(`/tmp/${"long-parent-".repeat(20)}`), /sandbox is never disabled/);
});

test("browser discovery only returns an already installed executable, with a clear refusal", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-browser-"));
  try {
    const browser = join(root, "chromium"); writeFileSync(browser, "fixture, never executed"); chmodSync(browser, 0o700);
    assert.equal(discoverTourBrowser({ PATH: root }, "linux"), browser);
    assert.equal(discoverTourBrowser({ SOVA_TOUR_BROWSER: browser, PATH: "" }, "linux"), browser);
    assert.throws(() => discoverTourBrowser({ PATH: "" }, "linux"), error => error instanceof TourBrowserSetupError && /not installed.*never downloads/.test(error.message));
    assert.throws(() => discoverTourBrowser({ SOVA_TOUR_BROWSER: join(root, "missing"), PATH: root }, "linux"), /Nothing was downloaded/);
    chmodSync(browser, 0o600);
    assert.throws(() => discoverTourBrowser({ PATH: root }, "linux"), /not installed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A fake executable (never run). */
function fake(file: string, mode = 0o700): string { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "fixture, never executed"); chmodSync(file, mode); return file; }
const shellAt = (cache: string, rev: number, plat = "mac-arm64") => join(cache, `chromium_headless_shell-${rev}`, `chrome-headless-shell-${plat}`, "chrome-headless-shell");

test("macOS: the headless shell comes from Playwright's cache, the pinned revision first, else the newest, this machine's architecture first", () => {
  const cache = mkdtempSync(join(tmpdir(), "tour-shell-"));
  try {
    const env = { PLAYWRIGHT_BROWSERS_PATH: cache };
    assert.equal(findMacHeadlessShell(env, "1208", "arm64"), undefined, "nothing installed: nothing found, nothing downloaded");
    const old = fake(shellAt(cache, 1208)), newest = fake(shellAt(cache, 1243));
    assert.equal(findMacHeadlessShell(env, "1208", "arm64"), old, "the pinned revision wins over a newer one");
    assert.equal(findMacHeadlessShell(env, "", "arm64"), newest, "no pin: the newest");
    assert.equal(findMacHeadlessShell(env, "9999", "arm64"), newest, "a pinned revision that is not installed: the newest");
    const x64 = fake(shellAt(cache, 1243, "mac-x64"));
    assert.equal(findMacHeadlessShell(env, "1243", "x64"), x64);
    assert.equal(findMacHeadlessShell(env, "1243", "arm64"), newest);
    chmodSync(newest, 0o600); chmodSync(x64, 0o600);
    assert.equal(findMacHeadlessShell(env, "1243", "arm64"), old, "a shell that cannot run is skipped");
    // HOME's own cache, when PLAYWRIGHT_BROWSERS_PATH is unset.
    const home = mkdtempSync(join(tmpdir(), "tour-home-"));
    try {
      const own = fake(shellAt(join(home, "Library", "Caches", "ms-playwright"), 1300));
      assert.equal(findMacHeadlessShell({ HOME: home }, "1300", "arm64"), own);
    } finally { rmSync(home, { recursive: true, force: true }); }
    assert.match(pinnedHeadlessShellRevision() ?? "", /^\d+$/, "this Sova's Playwright pins a revision");
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test("macOS discovery puts the headless shell ahead of PATH and the apps; SOVA_TOUR_BROWSER still wins; Linux ignores it", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-order-"));
  try {
    const cache = join(root, "cache"), bin = join(root, "bin");
    const shell = fake(shellAt(cache, 1208, `mac-${process.arch}`)), chromium = fake(join(bin, "chromium"));
    const env = { PLAYWRIGHT_BROWSERS_PATH: cache, PATH: bin };
    assert.equal(discoverTourBrowser(env, "darwin"), shell);
    assert.equal(discoverTourBrowser({ ...env, SOVA_TOUR_BROWSER: chromium }, "darwin"), chromium);
    assert.equal(discoverTourBrowser(env, "linux"), chromium, "Linux: the PATH names, exactly as before");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("macOS with the sandbox on refuses an app-bundle Chrome before anything starts; off, it still records; Linux chooses nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "tour-app-"));
  try {
    const app = fake(join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
    const link = join(root, "chrome"); symlinkSync(app, link);
    const shell = fake(shellAt(join(root, "cache"), 1208, `mac-${process.arch}`));
    assert.ok(insideAppBundle(app) && insideAppBundle(link) && !insideAppBundle(shell));
    for (const configured of [app, link]) {
      assert.throws(() => chooseTourBrowser(true, { SOVA_TOUR_BROWSER: configured, PATH: "" }, "darwin"),
        (error: unknown) => error instanceof TourBrowserSetupError && error.message === TOUR_APP_BROWSER_REFUSAL && /chromium-headless-shell/.test(error.message) && !error.message.includes(root));
      assert.equal(chooseTourBrowser(false, { SOVA_TOUR_BROWSER: configured, PATH: "" }, "darwin"), configured);
    }
    assert.equal(chooseTourBrowser(true, { SOVA_TOUR_BROWSER: shell, PATH: "" }, "darwin"), shell);
    assert.equal(chooseTourBrowser(true, { PLAYWRIGHT_BROWSERS_PATH: join(root, "cache"), PATH: "" }, "darwin"), shell);
    // Linux: the server chooses nothing (the child discovers its own), even for an app path.
    assert.equal(chooseTourBrowser(true, { SOVA_TOUR_BROWSER: app, PATH: "" }, "linux"), undefined);
    assert.equal(chooseTourBrowser(true, { PATH: "" }, "linux"), undefined, "Linux: no discovery, no refusal here");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a recording's short temp folder is macOS's alone", () => {
  assert.equal(macRecordingTmp("linux"), undefined, "Linux keeps its default");
  const short = macRecordingTmp("darwin");
  if (process.platform !== "darwin") { if (short) rmSync(short, { recursive: true, force: true }); return; }
  // /tmp is closed to a sandboxed chat running this test; then the attempt keeps the default and the path check refuses.
  if (!short) return;
  try { assert.match(short, /^\/tmp\/st-/); assert.ok(Buffer.byteLength(assertTourBrowserTempPath(join("/private", short, "t"))) <= 100); }
  finally { rmSync(short, { recursive: true, force: true }); }
});
