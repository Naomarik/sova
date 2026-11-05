#!/usr/bin/env bun
// A manual check, with the Mac's real Chrome and real mic, that the window Sova starts really gets
// the mic (§app.installer/mac-app, §app.installer/app-entry). macOS only; in no test tier, because it
// opens the real microphone for a moment and shows Chrome windows. Run it yourself, in a terminal
// outside any sandbox (inside one, macOS's launcher and log are closed, and it says so):
//
//   bun scripts/mac-mic-launch-check.ts [--browser <exe>]
//
// What Sova does on a Mac, it does from a launchd job running Bun, because a program started from a
// terminal would have the terminal answer for its mic and hide the bug. Each case starts Chrome on a
// throwaway profile with the site's mic permission seeded, at a page on a scratch port that reports
// its own getUserMedia result:
//   - the app, opened by this tree's scripts/mac-app.ts: must go live, on the unlock link, with no
//     "Policy disallows prompt" from tccd;
//   - that app opened again while its browser runs (the handover);
//   - the bare window, by the launcher's arguments;
//   - the old launch, the control: a detached child of Bun, as launchApp did. It must hang with that
//     denial, or the check can't tell the bug from its fix on this Mac.
// Exit 0 all held · 1 a case failed · 2 the check couldn't run or the control proves nothing.
//
// Nothing lands in the real ~/Applications (CFFIXED_USER_HOME, checked at the end). The only browser
// it ever stops is the one named by its own profile's lock. It prints no token: the link's is fake.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundleOf, runningPid } from "./mac-app";

const EXE = process.argv[2] === "--browser" ? process.argv[3]! : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_APP = resolve(import.meta.dirname, "mac-app.ts");
const ICON = resolve(import.meta.dirname, "..", "public", "icons", "pwa-512.png");
/** How long the page waits on getUserMedia before it reports it pending; the launch's limit adds to it. */
const PENDING_MS = 8000;
const REPORT_MS = PENDING_MS + 25_000;
const OFF_SCREEN = "--use-mock-keychain --window-position=-3000,-3000 --window-size=400,300";

interface JobPlan {
  argv: string[];
  env: Record<string, string>;
  detached: boolean;
  done: string;
}

// ---- the launchd job: starts one launch, then waits to be removed (launchctl submit restarts what exits) ----

if (process.argv[2] === "--job") {
  const planFile = process.argv[3]!;
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as JobPlan;
  if (!existsSync(plan.done)) {
    writeFileSync(plan.done, "");
    const [cmd, ...args] = plan.argv;
    const child = spawn(cmd!, args, { detached: plan.detached, stdio: "ignore", env: plan.env });
    child.on("error", () => {});
    child.on("exit", (code) => writeFileSync(plan.done, String(code)));
    if (plan.detached) child.unref();
  }
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

// ---- the check ----

if (process.platform !== "darwin") stop("this check is for macOS");
const bundle = bundleOf(EXE);
if (!bundle || !existsSync(EXE)) stop(`no browser at ${EXE} (--browser <exe> names another)`);
// Before anything starts: in a sandbox `log` refuses to run. Its launchd jobs would run outside that
// sandbox, which isn't this check's to get around, and macOS's launcher is closed in there anyway.
if (spawnSync("/usr/bin/log", ["show", "--last", "1s", "--style", "compact"], { stdio: "ignore" }).status !== 0) stop("macOS's log can't be read here; run this in a terminal outside any sandbox");

function stop(why: string): never {
  console.error(`mac-mic-launch-check: ${why}`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "sova mic check-")); // a space, as in Application Support
const fakeHome = join(root, "home");
mkdirSync(join(fakeHome, "Applications"), { recursive: true });
const realShims = join(homedir(), "Applications", "Chrome Apps.localized");
const listShims = () => (existsSync(realShims) ? readdirSync(realShims).sort().join("\n") : "");
const shimsBefore = listShims();

type Report = { url: string; standalone: boolean; permission: string; gum: { result: string; ms?: number; label?: string; state?: string; error?: string } };
const reports: Report[] = [];
const PAGE = `<!doctype html><meta charset=utf-8><title>mic check</title><link rel=manifest href=/manifest.webmanifest><body>mic check<script>
(async () => {
  if (!location.hash.startsWith("#t=check-")) return; // the install's own visit is no case
  const t0 = performance.now();
  const out = { url: location.href, standalone: matchMedia("(display-mode: standalone)").matches };
  out.permission = (await navigator.permissions.query({ name: "microphone" })).state;
  const asked = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  out.gum = await Promise.race([
    asked.then((s) => { const t = s.getAudioTracks()[0]; const r = { result: "resolved", ms: Math.round(performance.now() - t0), label: t.label, state: t.readyState }; s.getTracks().forEach((x) => x.stop()); return r; },
      (e) => ({ result: "rejected", error: e.name + ": " + e.message })),
    new Promise((r) => setTimeout(() => r({ result: "pending" }), ${PENDING_MS})),
  ]);
  asked.then((s) => s.getTracks().forEach((x) => x.stop()), () => {});
  await fetch("/report", { method: "POST", body: JSON.stringify(out) });
})();
</script>`;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(r) {
    const path = new URL(r.url).pathname;
    if (path === "/report") {
      reports.push((await r.json()) as Report);
      return new Response("ok");
    }
    if (path === "/manifest.webmanifest") {
      return Response.json({ name: "Sova mic check", short_name: "miccheck", id: "/", start_url: "/", scope: "/", display: "standalone", icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }] }, { headers: { "content-type": "application/manifest+json" } });
    }
    if (path === "/icon.png") return new Response(Bun.file(ICON));
    return new Response(PAGE, { headers: { "content-type": "text/html" } });
  },
});
const port = String(server.port);
const origin = `http://127.0.0.1:${port}`;

// The launch's own `open` keeps the shim out of ~/Applications and the window in the background;
// what it passes on is what launchApp gave it.
const openDir = join(root, "open-bin");
mkdirSync(openDir);
writeFileSync(join(openDir, "open"), `#!/bin/sh\nexec /usr/bin/open --env "CFFIXED_USER_HOME=${fakeHome}" -g "$@"\n`, { mode: 0o755 });
const env = (): Record<string, string> => ({
  HOME: homedir(),
  PATH: `${openDir}:/usr/bin:/bin`,
  CFFIXED_USER_HOME: fakeHome,
  SOVA_APP_BROWSER_ARGS: OFF_SCREEN,
});

function seedProfile(name: string): string {
  const profile = join(root, name);
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(join(profile, "First Run"), "");
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ profile: { content_settings: { exceptions: { media_stream_mic: { [`${origin},*`]: { setting: 1, last_modified: "13438000000000000" } } } } } }));
  return profile;
}

/** Runs one launch from a launchd job of Bun's, as the Sova service is, until `settled`. */
async function fromLaunchd(tag: string, plan: Omit<JobPlan, "done" | "env">): Promise<void> {
  const label = `io.github.naomarik.sova.mic-check.${process.pid}.${tag}`;
  const planFile = join(root, `${tag}.job.json`);
  const done = `${planFile}.done`;
  writeFileSync(planFile, JSON.stringify({ ...plan, env: env(), done }));
  const sub = spawnSync("launchctl", ["submit", "-l", label, "--", process.execPath, resolve(import.meta.filename), "--job", planFile], { encoding: "utf8" });
  if (sub.status !== 0) throw new Fatal(`launchctl submit failed (${sub.stderr.trim() || sub.status}): is this a sandbox?`);
  jobs.push(label);
  const end = Date.now() + 20_000;
  while (!existsSync(done) || (!plan.detached && !readFileSync(done, "utf8"))) {
    if (Date.now() > end) throw new Fatal(`the launchd job ${tag} never started its launch`);
    await Bun.sleep(100);
  }
  if (!plan.detached && readFileSync(done, "utf8") !== "0") throw new Fatal(`${tag}: its launch exited ${readFileSync(done, "utf8")}`);
}
class Fatal extends Error {}
const jobs: string[] = [];
const removeJobs = () => {
  for (const label of jobs.splice(0)) spawnSync("launchctl", ["remove", label], { stdio: "ignore" });
};

async function nextReport(from: number): Promise<Report | null> {
  const end = Date.now() + REPORT_MS;
  while (Date.now() < end) {
    if (reports.length > from) return reports[from]!;
    await Bun.sleep(100);
  }
  return null;
}

// tccd's denials as they happen. `log show` can't be the instrument: a hanging launch draws over a
// thousand of them and macOS keeps next to none, so it reads the bug as clean.
const denialLog = spawn("/usr/bin/log", ["stream", "--style", "compact", "--predicate", 'process == "tccd" AND composedMessage CONTAINS "kTCCServiceMicrophone" AND composedMessage CONTAINS "Policy disallows prompt"'], { stdio: ["ignore", "pipe", "ignore"] });
denialLog.on("error", () => {});
let denialLogLines = 0;
let denials = 0;
let denialLogRest = "";
denialLog.stdout.on("data", (d) => {
  const lines = (denialLogRest + d).split("\n");
  denialLogRest = lines.pop()!;
  denialLogLines += lines.length;
  denials += lines.filter((l) => l.includes("Policy disallows prompt") && !l.startsWith("Filtering")).length;
});

/** Its first line says the stream is on: a denial logged from then on is delivered. */
async function denialLogOn(): Promise<void> {
  const end = Date.now() + 10_000;
  while (!denialLogLines) {
    if (denialLog.exitCode !== null || Date.now() > end) throw new Fatal("log stream didn't start: is this a sandbox?");
    await Bun.sleep(20);
  }
}

/** Denials after a count taken before the launch, once any still on their way have arrived. */
async function denialsSince(seen: number): Promise<number> {
  await Bun.sleep(1000);
  if (denialLog.exitCode !== null) throw new Fatal("log stream stopped during the check");
  return denials - seen;
}

/** Quits the browser named by this check's own profile's lock, by that pid and nothing else. */
async function quit(profile: string): Promise<void> {
  const pid = runningPid(profile);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && runningPid(profile) === pid; i++) await Bun.sleep(200);
  if (runningPid(profile) === pid) process.kill(pid, "SIGKILL");
  rmSync(join(profile, "SingletonLock"), { force: true });
}

/** Waits without blocking: the install fetches the page from this process's server, which a spawnSync would keep from answering. */
function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => done({ status: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

let failed = 0;
const held = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const live = (r: Report | null) => r?.gum.result === "resolved" && r.gum.state === "live";
const said = (r: Report | null) => (r ? `permission ${r.permission}, getUserMedia ${r.gum.result}${r.gum.ms !== undefined ? ` in ${r.gum.ms} ms` : ""}${r.gum.error ? ` (${r.gum.error})` : ""}${r.gum.label ? `, track "${r.gum.label}"` : ""}` : "no report");
const appIdIn = (profile: string) => (JSON.parse(readFileSync(join(profile, "sova-app.json"), "utf8")) as { ports: Record<string, { appId: string }> }).ports[port]!.appId;

let controlProves = false;
try {
  await denialLogOn();
  console.log(`install, over its pipe, on a throwaway profile (port ${port})`);
  const profile = seedProfile("app profile");
  const inst = await run(process.execPath, [MAC_APP, "install", "--browser", EXE, "--profile", profile, "--port", port], env());
  held(inst.status === 0, `installed the app (${inst.stdout.trim().split("\n").at(-1) ?? ""})`);
  if (inst.status !== 0) throw new Fatal(`the install failed: ${inst.stdout}${inst.stderr}`);
  const appId = appIdIn(profile);
  const openApp = (hash: string) => ({ argv: [process.execPath, MAC_APP, "open", "--browser", EXE, "--profile", profile, "--port", port, "--url", `${origin}/#t=check-${hash}`], detached: false });

  console.log("the app, opened by this tree's mac-app.ts, from a launchd job of Bun's");
  let seen = denials;
  let from = reports.length;
  await fromLaunchd("app", openApp("app"));
  let r = await nextReport(from);
  console.log(`       ${said(r)}`);
  held(live(r), "the mic went live");
  held(r?.url === `${origin}/#t=check-app`, "the unlock link reached the window");
  held(r?.standalone === true, "in the installed app's own window");
  held((await denialsSince(seen)) === 0, 'no "Policy disallows prompt" from tccd');

  console.log("opened again while that browser runs: the handover");
  const running = runningPid(profile);
  from = reports.length;
  await fromLaunchd("again", openApp("again"));
  r = await nextReport(from);
  console.log(`       ${said(r)}`);
  held(running !== null && runningPid(profile) === running, "the running browser took it: no second browser on the profile");
  // Chrome may bring the app's open window forward instead of opening another: then no page reports.
  if (!r) console.log("  NOTE no new page reported: the running browser kept the window it had");
  else {
    held(live(r), "its new window's mic went live");
    held(r.url === `${origin}/#t=check-again`, "the new unlock link reached it");
  }
  await quit(profile);
  removeJobs();

  console.log("the bare window, by the launcher's arguments");
  const bareProfile = seedProfile("bare profile");
  from = reports.length;
  const bare = spawnSync(join(openDir, "open"), ["-n", "-a", bundle!, "--args", `--app=${origin}/#t=check-bare`, `--user-data-dir=${bareProfile}`, "--no-first-run", "--no-default-browser-check", ...OFF_SCREEN.split(" ")], { env: env() });
  held(bare.status === 0, "open accepted it");
  r = await nextReport(from);
  console.log(`       ${said(r)}`);
  held(live(r), "the mic went live");
  await quit(bareProfile);

  console.log("the control, the old launch: a detached child of Bun, on the app's profile");
  seen = denials;
  from = reports.length;
  await fromLaunchd("old", {
    argv: [EXE, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", ...OFF_SCREEN.split(" "), `--app-id=${appId}`, `--app-launch-url-for-shortcuts-menu-item=${origin}/#t=check-old`],
    detached: true,
  });
  r = await nextReport(from);
  const denied = await denialsSince(seen);
  console.log(`       ${said(r)}; ${denied} denial(s) from tccd`);
  controlProves = r?.gum.result === "pending" && denied > 0;
  console.log(controlProves ? "  ok   it hangs with the denial, so this check can tell the bug from its fix" : "  NOTE it didn't hang with the denial, so on this Mac the cases above don't prove the fix");
  await quit(profile);
  removeJobs();

  held(listShims() === shimsBefore, "nothing landed in the real ~/Applications");
} catch (e) {
  if (!(e instanceof Fatal)) throw e;
  console.error(`mac-mic-launch-check: ${e.message}`);
  failed = -1;
} finally {
  removeJobs();
  denialLog.kill();
  await Promise.allSettled(["app profile", "bare profile"].map((n) => quit(join(root, n))));
  void server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
if (failed === -1) process.exit(2);
console.log(failed ? `${failed} failed` : "all held");
process.exit(failed ? 1 : controlProves ? 0 : 2);
