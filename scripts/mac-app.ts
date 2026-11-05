#!/usr/bin/env bun
// Sova as an installed app of its own on macOS (§app.installer/app-entry): the installed launcher
// runs this on the install's Bun for `sova app --install` and for `sova app`.
//
//   bun scripts/mac-app.ts install --browser <exe> --profile <user-data-dir> --port <n>
//                                  [--token-file <f>] [--close-running] [--auto]
//     Installs the app from http://127.0.0.1:<port>/ (the server must answer there) into that
//     profile over a DevTools pipe, sets it to open in a window of its own, opens the unlock link
//     once, closes the browser, then turns on the app's "hide title bar" setting in the closed
//     profile's store (mac-app-store.ts). The result goes in <profile>/sova-app.json, per port.
//     --close-running: a browser already running on the profile is asked to quit first (else the
//     step is skipped). --auto (the installer's run): an app the person removed stays removed.
//     Exit 0 installed or already installed · 3 skipped (the browser is running, or the app was
//     removed) · 1 failed (recorded) · 2 usage.
//
//   bun scripts/mac-app.ts check  (install's arguments)
//     What install would do, before anything is started: exit 0 already installed · 3 nothing to
//     do this run · 1 install it.
//
//   bun scripts/mac-app.ts open --browser <exe> --profile <dir> --port <n> --url <unlock url>
//                               [--token-file <f>] [--no-install]
//     Opens the installed app at <url> when it is installed for the port; installs it first when
//     nothing was ever tried for the port and the browser on that profile is closed. --no-install
//     (an install that passed --no-app-entry): never installs. Started through macOS's launcher
//     (launchApp below). Exit 0 the launch was accepted, which doesn't say the window appeared
//     (neither `open` nor a detached start can) · 10 not installed, or the browser couldn't be
//     started: the caller opens its bare --app window instead.
//
// Env: SOVA_APP_BROWSER_ARGS adds arguments to every browser start (tests: --use-mock-keychain).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appIdOf, appRecord, findAppId, loadStore, presetWco, storeDir } from "./mac-app-store";

type Args = Record<string, string | true>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = "", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[a.slice(2)] = next;
      i++;
    } else args[a.slice(2)] = true;
  }
  return { cmd, args };
}

const say = (s: string) => process.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- the record of what was done, per port ----

type PortState =
  | { state: "installed"; appId: string; manifestId: string; browser: string; version?: string; wco: boolean; at: string }
  | { state: "failed"; step: string; error: string; browser: string; version?: string; at: string }
  | { state: "removed"; appId: string; browser: string; at: string };

interface Marker {
  version: 1;
  ports: Record<string, PortState>;
}

const markerPath = (profile: string) => join(profile, "sova-app.json");

function readMarker(profile: string): Marker {
  try {
    const m = JSON.parse(readFileSync(markerPath(profile), "utf8")) as Marker;
    if (m && m.version === 1 && m.ports && typeof m.ports === "object") return m;
  } catch {
    /* none yet, or unreadable: as if nothing was tried */
  }
  return { version: 1, ports: {} };
}

function writeMarker(profile: string, port: string, s: PortState): void {
  const m = readMarker(profile);
  m.ports[port] = s;
  mkdirSync(profile, { recursive: true });
  const tmp = `${markerPath(profile)}.new.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, markerPath(profile));
}

// ---- the browser on the profile ----

/** The pid in the profile's SingletonLock ("<host>-<pid>") when that process is alive. */
export function runningPid(profile: string): number | null {
  let target: string;
  try {
    target = readlinkSync(join(profile, "SingletonLock"));
  } catch {
    return null;
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" ? pid : null; // a stale lock names a dead pid
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") return true;
    }
    if (Date.now() > end) return false;
    await sleep(200);
  }
}

const extraArgs = () => (process.env.SOVA_APP_BROWSER_ARGS ?? "").split(/\s+/).filter(Boolean);

/** DevTools over --remote-debugging-pipe: requests on fd 3, replies and events on fd 4, each a
    JSON message ended by a NUL. */
class Pipe {
  private id = 0;
  private buf = "";
  private pending = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
  private listeners: Array<(m: { method: string; params: any; sessionId?: string }) => void> = [];
  readonly exited: Promise<number | null>;
  constructor(readonly proc: ChildProcess) {
    const out = proc.stdio[4] as NodeJS.ReadableStream;
    out.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(raw);
        } catch {
          continue;
        }
        if (typeof m.id === "number" && this.pending.has(m.id)) {
          this.pending.get(m.id)!(m);
          this.pending.delete(m.id);
        } else if (m.method) for (const l of this.listeners) l(m);
      }
    });
    this.exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
  }
  send(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<any> {
    const id = ++this.id;
    const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m.result);
      });
      (this.proc.stdio[3] as NodeJS.WritableStream).write(`${msg}\0`);
    });
  }
  on(l: (m: { method: string; params: any; sessionId?: string }) => void): void {
    this.listeners.push(l);
  }
}

function startPiped(browser: string, profile: string): Pipe {
  const proc = spawn(browser, ["--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", ...extraArgs(), "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  return new Pipe(proc);
}

async function closeBrowser(pipe: Pipe): Promise<void> {
  const done = Promise.race([pipe.exited.then(() => true), sleep(20_000).then(() => false)]);
  pipe.send("Browser.close", {}, undefined, 10_000).catch(() => {});
  if (!(await done)) {
    pipe.proc.kill("SIGTERM");
    await Promise.race([pipe.exited, sleep(10_000)]);
  }
}

/** "Google Chrome" for ".../Google Chrome.app/Contents/MacOS/Google Chrome". */
const browserName = (exe: string) => /([^/]+)\.app\//.exec(exe)?.[1] ?? exe;

const origin = (port: string) => `http://127.0.0.1:${port}`;
const manifestIdFor = (port: string) => `${origin(port)}/`;

class StepError extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
  }
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new StepError(name, e instanceof Error ? e.message : String(e));
  }
}

/** Install over the pipe; returns the browser's version. Leaves the browser closed. */
async function installOverPipe(browser: string, profile: string, port: string, token: string | null): Promise<string | undefined> {
  const manifestId = manifestIdFor(port);
  const pipe = startPiped(browser, profile);
  try {
    const version = await step("start the browser", async () => {
      const exitedEarly = pipe.exited.then((c) => {
        throw new Error(`the browser exited (${c}) before answering`);
      });
      const v = await Promise.race([pipe.send("Browser.getVersion", {}, undefined, 30_000), exitedEarly]);
      return (v as { product?: string }).product;
    });
    // A page of the app, opened with the unlock link when there is a token: it posts the token
    // once, so the profile holds this install's cookie and the app starts unlocked.
    await step("open Sova in the browser", async () => {
      const url = token ? `${origin(port)}/#t=${token}` : `${origin(port)}/`;
      await pipe.send("Target.createTarget", { url });
      if (!token) return;
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        const { cookies } = (await pipe.send("Storage.getCookies", {})) as { cookies: Array<{ name: string; domain: string; port?: number }> };
        if (cookies.some((c) => c.name.startsWith("sova_token") && c.domain === "127.0.0.1")) return;
        await sleep(300);
      }
      say("sova app: the unlock link didn't set this install's cookie; the app will ask for the token once");
    });
    await step("install the app", () => pipe.send("PWA.install", { manifestId, installUrlOrBundleUrl: manifestId }, undefined, 60_000));
    // An install over DevTools opens as a tab until it is told otherwise.
    await step("open it in a window of its own", () => pipe.send("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" }));
    return version?.replace(/^[^/]*\//, "");
  } finally {
    await closeBrowser(pipe);
  }
}

/** With the browser closed: the app's "hide title bar" setting, the store copied aside first and
    put back when the result doesn't read back. Returns the app id and whether it is on. */
function presetTitleBar(profile: string, manifestId: string): { appId: string; wco: boolean; note?: string } {
  const db = storeDir(join(profile, "Default"));
  let appId = appIdOf(manifestId);
  if (!existsSync(join(db, "CURRENT"))) return { appId, wco: false, note: "the browser's web-app store isn't where Chrome keeps it" };
  let found: string | null;
  try {
    found = findAppId(loadStore(db), manifestId);
  } catch (e) {
    return { appId, wco: false, note: `the browser's web-app store couldn't be read (${(e as Error).message})` };
  }
  if (!found) return { appId, wco: false, note: "the browser's web-app store has no record of the app in a shape this knows" };
  appId = found;
  const backup = `${db}.sova-backup`;
  rmSync(backup, { recursive: true, force: true });
  cpSync(db, backup, { recursive: true });
  let result: ReturnType<typeof presetWco>;
  try {
    result = presetWco(db, appId, true);
  } catch (e) {
    result = { ok: false, appId, reason: (e as Error).message };
  }
  if (!result.ok) {
    rmSync(db, { recursive: true, force: true });
    renameSync(backup, db);
    return { appId, wco: false, note: `the title-bar setting wasn't written: ${result.reason}; the store is as it was` };
  }
  rmSync(backup, { recursive: true, force: true });
  return { appId, wco: true };
}

function readToken(file: string | true | undefined): string | null {
  if (typeof file !== "string") return null;
  try {
    const t = readFileSync(file, "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** The app still installed? Read from the store when the browser is closed; when it runs, or the
    store can't be read, the record's word stands. */
function stillInstalled(profile: string, appId: string): boolean {
  if (runningPid(profile)) return true;
  try {
    return appRecord(loadStore(storeDir(join(profile, "Default"))), appId) !== null;
  } catch {
    return true;
  }
}

/** Whether an install has anything to do, before anything is started: 0 already installed,
    3 nothing to do this run (removed under --auto, or the browser is running and may not be
    closed), null go ahead. */
function precheck(args: Args, how: { auto: boolean; closeRunning: boolean }): 0 | 3 | null {
  const browser = args.browser as string;
  const profile = args.profile as string;
  const port = args.port as string;
  const had = readMarker(profile).ports[port];
  if (had?.state === "installed" && had.browser === browser && stillInstalled(profile, had.appId)) {
    say(`Sova is already installed as an app for port ${port}${had.wco ? "" : " (with the browser's title bar)"}`);
    return 0;
  }
  if (had?.state === "installed" && had.browser === browser) {
    writeMarker(profile, port, { state: "removed", appId: had.appId, browser, at: new Date().toISOString() });
  }
  if (how.auto && (had?.state === "removed" || (had?.state === "installed" && had.browser === browser))) {
    say("the Sova app was removed from the browser, so it stays removed (sova app --install puts it back)");
    return 3;
  }
  if (runningPid(profile) && !how.closeRunning) {
    say("Sova's browser window is open, so Sova wasn't installed as an app; sova app does it the next time it opens Sova with that window closed");
    return 3;
  }
  return null;
}

async function install(args: Args, how: { auto: boolean; closeRunning: boolean; quiet?: boolean }): Promise<number> {
  const browser = args.browser as string;
  const profile = args.profile as string;
  const port = args.port as string;
  const manifestId = manifestIdFor(port);
  const early = precheck(args, how);
  if (early !== null) return early;

  let pid = runningPid(profile);
  if (pid && how.closeRunning) {
    say("closing Sova's browser window to install Sova as an app (it opens again with sova app)");
    process.kill(pid, "SIGTERM");
    if (!(await waitGone(pid, 20_000))) {
      say("Sova's browser window didn't close; skipped installing Sova as an app");
      return 3;
    }
    pid = null;
  }
  if (pid) return 3; // it started between the check and here
  if (!how.quiet) say(`installing Sova as an app in ${browserName(browser)} (it opens and closes once)`);

  let version: string | undefined;
  try {
    version = await installOverPipe(browser, profile, port, readToken(args["token-file"]));
    if (runningPid(profile)) throw new StepError("close the browser", "the browser on Sova's profile is still running");
  } catch (e) {
    const stepName = e instanceof StepError ? e.step : "install";
    const error = e instanceof Error ? e.message : String(e);
    writeMarker(profile, port, { state: "failed", step: stepName, error, browser, version, at: new Date().toISOString() });
    say(`couldn't install Sova as an app (${stepName}: ${error}); sova app keeps opening it in a bare browser window`);
    return 1;
  }
  const preset = presetTitleBar(profile, manifestId);
  writeMarker(profile, port, { state: "installed", appId: preset.appId, manifestId, browser, version, wco: preset.wco, at: new Date().toISOString() });
  if (!how.quiet) say(`installed Sova as an app (port ${port}, app id ${preset.appId})`);
  if (!preset.wco) say(`its window keeps the browser's title bar: ${preset.note}. The browser's own toggle at the top right hides it.`);
  return 0;
}

/** ".../Google Chrome.app" for ".../Google Chrome.app/Contents/MacOS/Google Chrome"; else null. */
export const bundleOf = (exe: string): string | null => /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1] ?? null;

/** Long past any real launch: `open` that hasn't answered by now gets the direct start. */
const OPEN_LIMIT_MS = 15_000;

/**
 * Starts the window's browser through macOS's launcher (§app.installer/app-entry). macOS holds a
 * program's starter responsible for its mic use, and detaching doesn't change that: started as a
 * child of Bun (hardened, no audio-input entitlement), the browser is refused the mic without a
 * prompt and getUserMedia never answers. Started by `open`, its permission is its own. The direct
 * start remains for an executable outside a bundle and for when `open` fails; false when it fails too.
 * The install's start (startPiped) stays direct: it needs the pipe and never takes the mic.
 */
async function launchApp(browser: string, profile: string, appId: string, url: string): Promise<boolean> {
  const args = [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", ...extraArgs(), `--app-id=${appId}`, `--app-launch-url-for-shortcuts-menu-item=${url}`];
  const bundle = bundleOf(browser);
  if (bundle && spawnSync("open", ["-n", "-a", bundle, "--args", ...args], { stdio: "ignore", timeout: OPEN_LIMIT_MS }).status === 0) return true;
  return new Promise((resolve) => {
    const child = spawn(browser, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

async function open(args: Args): Promise<number> {
  const browser = args.browser as string;
  const profile = args.profile as string;
  const port = args.port as string;
  const url = args.url as string;
  if (typeof url !== "string") return usage();
  let had = readMarker(profile).ports[port];
  // Nothing ever tried for this port, and the browser on the profile is closed: install it now.
  if (!had && !runningPid(profile) && args["no-install"] !== true) {
    if ((await install(args, { auto: true, closeRunning: false, quiet: true })) !== 0) return 10;
    had = readMarker(profile).ports[port];
  }
  if (had?.state !== "installed" || had.browser !== browser) return 10;
  if (!stillInstalled(profile, had.appId)) {
    writeMarker(profile, port, { state: "removed", appId: had.appId, browser, at: new Date().toISOString() });
    return 10;
  }
  return (await launchApp(browser, profile, had.appId, url)) ? 0 : 10;
}

function usage(): number {
  process.stderr.write("usage: mac-app.ts install|open --browser <exe> --profile <dir> --port <n> [--url <u>] [--token-file <f>] [--close-running] [--auto] [--no-install]\n");
  return 2;
}

async function main(): Promise<number> {
  let cmd: string, args: Args;
  try {
    ({ cmd, args } = parseArgs(process.argv.slice(2)));
  } catch {
    return usage();
  }
  for (const k of ["browser", "profile", "port"]) if (typeof args[k] !== "string") return usage();
  if (!/^\d+$/.test(args.port as string)) return usage();
  const how = { auto: args.auto === true, closeRunning: args["close-running"] === true };
  if (cmd === "check") return precheck(args, how) ?? 1;
  if (cmd === "install") return install(args, how);
  if (cmd === "open") return open(args);
  return usage();
}

if (import.meta.main) process.exit(await main());

