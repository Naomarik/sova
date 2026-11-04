// Run: pnpm test:int -- scripts/mac-app.integration.test.ts. scripts/mac-app.ts end to end
// (§app.installer/app-entry) against a stand-in browser: a Bun script that speaks DevTools over
// --remote-debugging-pipe (fds 3 and 4, NUL-ended JSON), holds the profile's SingletonLock while it
// runs, and on PWA.install writes the profile's web-app store as Chrome would (one app record, its
// title-bar setting off). Started any other way it logs its arguments and exits: that is the app
// launch. No real browser runs; what Chrome itself does with these calls is checked by hand, against
// a real Chrome on a throwaway profile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../server/test-scratch";
import { appIdOf, appRecord, frameLogRecord, loadStore, putVarint, recordKey, storeDir, wcoOf } from "./mac-app-store";

const REPO = resolve(import.meta.dirname, "..");
const MAC_APP = join(REPO, "scripts", "mac-app.ts");
const root = scratchRoot("sova-mac-app-");
after(() => rmSync(root, { recursive: true, force: true }));

const PORT = "4931";
const MID = `http://127.0.0.1:${PORT}/`;

const fakeTs = join(root, "fake-browser.ts");
writeFileSync(
  fakeTs,
  `
import { appendFileSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { appIdOf, frameLogRecord, putBatch, putVarint, recordKey } from ${JSON.stringify(join(REPO, "scripts", "mac-app-store.ts"))};
const log = (s: string) => appendFileSync(process.env.FAKE_BROWSER_LOG!, s + "\\n");
const argv = process.argv.slice(2);
const ud = argv.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
if (!argv.includes("--remote-debugging-pipe")) { log("launch " + JSON.stringify(argv)); process.exit(0); }
log("piped " + JSON.stringify(argv));
mkdirSync(ud, { recursive: true });
const lock = join(ud, "SingletonLock");
rmSync(lock, { force: true });
symlinkSync(hostname() + "-" + process.pid, lock);
const out = createWriteStream("", { fd: 4 });
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const lp = (b: Uint8Array) => cat(putVarint(b.length), b);
let unlocked = false;
const reply = (id: number, result: unknown, error?: string) => out.write(JSON.stringify(error ? { id, error: { code: -32000, message: error } } : { id, result }) + "\\0");
let buf = "";
createReadStream("", { fd: 3 }).on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\0")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log("cdp " + m.method + " " + JSON.stringify(m.params));
    if (process.env.FAKE_FAIL === m.method) { reply(m.id, null, "refused by the stand-in"); continue; }
    switch (m.method) {
      case "Browser.getVersion": reply(m.id, { product: "FakeChrome/155.0.1" }); break;
      case "Target.createTarget": unlocked = /#t=/.test(m.params.url); reply(m.id, { targetId: "t1" }); break;
      case "Storage.getCookies": reply(m.id, { cookies: unlocked ? [{ name: "sova_token_ab12cd34", domain: "127.0.0.1" }] : [] }); break;
      case "PWA.install": {
        if (process.env.FAKE_STORE !== "none") {
          const db = join(ud, "Default", "Sync Data", "LevelDB");
          mkdirSync(db, { recursive: true });
          const mid = m.params.manifestId as string;
          const origin = new URL(mid).origin;
          const sync = cat(putVarint(10), lp(enc(origin + "/")), putVarint(74), lp(enc(mid.slice(origin.length + 1))));
          const rec = cat(putVarint(10), lp(sync), putVarint(34 << 3), putVarint(0));
          if (!existsSync(join(db, "CURRENT"))) {
            writeFileSync(join(db, "CURRENT"), "MANIFEST-000001\\n");
            writeFileSync(join(db, "MANIFEST-000001"), frameLogRecord(cat(putVarint(1), lp(enc("leveldb.BytewiseComparator")), putVarint(2), putVarint(3), putVarint(3), putVarint(4), putVarint(4), putVarint(0)), 0));
            writeFileSync(join(db, "000003.log"), new Uint8Array(0));
          }
          const logf = join(db, "000003.log");
          const size = statSync(logf).size;
          appendFileSync(logf, frameLogRecord(putBatch(Date.now() % 1000000, enc(recordKey(appIdOf(mid))), rec), size));
        }
        reply(m.id, {});
        break;
      }
      case "PWA.changeAppUserSettings": reply(m.id, {}); break;
      case "Browser.close": reply(m.id, {}); rmSync(lock, { force: true }); setTimeout(() => process.exit(0), 50); break;
      default: reply(m.id, null, "unknown method " + m.method);
    }
  }
});
process.on("SIGTERM", () => { rmSync(lock, { force: true }); process.exit(0); });
`,
);
const fakeBrowser = join(root, "Fake Chrome");
writeFileSync(fakeBrowser, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeTs)} "$@"\n`);
chmodSync(fakeBrowser, 0o755);

let caseN = 0;
function newCase() {
  const dir = join(root, `case${++caseN}`);
  const profile = join(dir, "sova-browser");
  mkdirSync(profile, { recursive: true });
  const token = join(dir, "auth-token");
  writeFileSync(token, "tok-123\n");
  const log = join(dir, "browser.log");
  writeFileSync(log, "");
  return { dir, profile, token, log };
}

function run(c: ReturnType<typeof newCase>, cmd: string, extra: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [MAC_APP, cmd, "--browser", fakeBrowser, "--profile", c.profile, "--port", PORT, "--token-file", c.token, ...extra], {
    encoding: "utf8",
    env: { ...process.env, FAKE_BROWSER_LOG: c.log, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const marker = (c: { profile: string }) => JSON.parse(readFileSync(join(c.profile, "sova-app.json"), "utf8")).ports[PORT];
const calls = (c: { log: string }) => readFileSync(c.log, "utf8").split("\n").filter(Boolean);
const wco = (c: { profile: string }) => wcoOf(appRecord(loadStore(storeDir(join(c.profile, "Default"))), appIdOf(MID))!);

test("install: over the pipe, a window of its own, unlocked, the browser closed, then the title bar hidden in the store", () => {
  const c = newCase();
  const r = run(c, "install");
  assert.equal(r.status, 0, r.out);
  const log = calls(c);
  const piped = JSON.parse(log[0]!.slice("piped ".length)) as string[];
  assert.ok(piped.includes("--remote-debugging-pipe") && piped.includes(`--user-data-dir=${c.profile}`), log[0]);
  assert.ok(!piped.some((a) => a.startsWith("--remote-debugging-port")), "no debugging port");
  const methods = log.filter((l) => l.startsWith("cdp ")).map((l) => l.split(" ")[1]);
  assert.deepEqual(methods.filter((m) => m !== "Storage.getCookies"), ["Browser.getVersion", "Target.createTarget", "PWA.install", "PWA.changeAppUserSettings", "Browser.close"]);
  assert.ok(log.some((l) => l.includes(`"url":"${MID}#t=tok-123"`)), "the unlock link, once");
  assert.ok(log.some((l) => l.includes(`PWA.install {"manifestId":"${MID}","installUrlOrBundleUrl":"${MID}"}`)));
  assert.ok(log.some((l) => l.includes(`PWA.changeAppUserSettings {"manifestId":"${MID}","displayMode":"standalone"}`)));
  assert.equal(wco(c), true, "the hide-title-bar setting is on in the store");
  const m = marker(c);
  assert.equal(m.state, "installed");
  assert.equal(m.appId, appIdOf(MID));
  assert.equal(m.wco, true);
  assert.equal(m.version, "155.0.1");
  assert.ok(!existsSync(`${storeDir(join(c.profile, "Default"))}.sova-backup`), "the store's copy is gone");
  assert.match(r.out, /installed Sova as an app/);
});

test("re-running: check and install find it installed and start nothing; open launches the app by id with the unlock link", () => {
  const c = newCase();
  assert.equal(run(c, "install").status, 0);
  const n = calls(c).length;
  const storeBytes = readFileSync(join(storeDir(join(c.profile, "Default")), "000003.log"));
  assert.equal(run(c, "check", ["--auto"]).status, 0);
  const again = run(c, "install", ["--auto"]);
  assert.equal(again.status, 0);
  assert.match(again.out, /already installed/);
  assert.equal(calls(c).length, n, "the browser wasn't started");
  assert.deepEqual(readFileSync(join(storeDir(join(c.profile, "Default")), "000003.log")), storeBytes, "the store is untouched");
  const url = `${MID}#t=tok-123`;
  const o = run(c, "open", ["--url", url]);
  assert.equal(o.status, 0, o.out);
  for (let i = 0; i < 50 && !calls(c).some((l) => l.startsWith("launch ")); i++) spawnSync("sleep", ["0.1"]);
  const launch = JSON.parse(calls(c).find((l) => l.startsWith("launch "))!.slice("launch ".length)) as string[];
  assert.ok(launch.includes(`--app-id=${appIdOf(MID)}`), launch.join(" "));
  assert.ok(launch.includes(`--app-launch-url-for-shortcuts-menu-item=${url}`));
  assert.ok(launch.includes(`--user-data-dir=${c.profile}`));
  assert.ok(!launch.some((a) => a.startsWith("--remote-debugging")), "no debugging port or pipe on the launch");
});

test("open with nothing tried and the browser closed installs first; another port is another app", () => {
  const c = newCase();
  const o = run(c, "open", ["--url", `${MID}#t=tok-123`]);
  assert.equal(o.status, 0, o.out);
  assert.equal(marker(c).state, "installed");
  const other = spawnSync(process.execPath, [MAC_APP, "check", "--browser", fakeBrowser, "--profile", c.profile, "--port", "4932", "--auto"], { encoding: "utf8" });
  assert.equal(other.status, 1, "port 4932 still needs its own install");
});

test("open --no-install: nothing installed stays that way (the bare window); an app installed by name still opens", () => {
  const c = newCase();
  const refused = run(c, "open", ["--url", `${MID}#t=tok-123`, "--no-install"]);
  assert.equal(refused.status, 10, refused.out);
  assert.deepEqual(calls(c), [], "no browser started");
  assert.equal(existsSync(join(c.profile, "sova-app.json")), false, "nothing recorded: it was never tried");
  assert.equal(run(c, "install").status, 0);
  const opened = run(c, "open", ["--url", `${MID}#t=tok-123`, "--no-install"]);
  assert.equal(opened.status, 0, opened.out);
  for (let i = 0; i < 50 && !calls(c).some((l) => l.startsWith("launch ")); i++) spawnSync("sleep", ["0.1"]);
  assert.ok(calls(c).some((l) => l.startsWith("launch ")), "the installed app was launched");
});

test("a running browser on the profile: skipped without --close-running (nothing started); closed first with it", async () => {
  const c = newCase();
  // An orphan, as a browser is to this test: a child of ours would linger as a zombie once killed,
  // and a zombie still answers kill(pid, 0).
  const sleeper = Number(spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
  symlinkSync(`${hostname()}-${sleeper}`, join(c.profile, "SingletonLock"));
  const skipped = run(c, "install", ["--auto"]);
  assert.equal(skipped.status, 3, skipped.out);
  assert.match(skipped.out, /window is open/);
  assert.equal(calls(c).length, 0);
  assert.ok(!existsSync(join(c.profile, "sova-app.json")), "a skip records nothing, so sova app finishes it later");
  assert.equal(run(c, "open", ["--url", `${MID}#t=tok-123`]).status, 10, "open with the browser running and nothing installed: the bare window");
  const closed = run(c, "install", ["--auto", "--close-running"]);
  assert.equal(closed.status, 0, closed.out);
  assert.match(closed.out, /closing Sova's browser window/);
  assert.equal(isAlive(sleeper), false, "the running browser was asked to quit, and did");
  assert.equal(marker(c).state, "installed");
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a stale SingletonLock (a browser that was killed) doesn't count as running", () => {
  const c = newCase();
  symlinkSync(`${hostname()}-999999`, join(c.profile, "SingletonLock"));
  assert.equal(run(c, "install").status, 0);
});

test("a failed step: recorded, exit 1, and open doesn't retry (the bare window); the installer's run retries", () => {
  const c = newCase();
  const r = run(c, "install", ["--auto"], { FAKE_FAIL: "PWA.install" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /install the app: PWA.install: refused by the stand-in/);
  assert.equal(marker(c).state, "failed");
  assert.equal(marker(c).step, "install the app");
  const n = calls(c).length;
  assert.equal(run(c, "open", ["--url", `${MID}#t=tok-123`]).status, 10);
  assert.equal(calls(c).length, n, "open started nothing");
  assert.equal(run(c, "check", ["--auto"]).status, 1, "the installer tries again");
  assert.equal(run(c, "install", ["--auto"]).status, 0);
  assert.equal(marker(c).state, "installed");
});

test("a store not in the shape it knows: installed with the title bar, said so, store untouched", () => {
  const c = newCase();
  const r = run(c, "install", [], { FAKE_STORE: "none" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /keeps the browser's title bar/);
  assert.equal(marker(c).wco, false);
});

test("removed from the browser: open falls back and records it; --auto leaves it removed; a plain install puts it back", () => {
  const c = newCase();
  assert.equal(run(c, "install").status, 0);
  // The browser deleting the app's record, as an uninstall does.
  const db = storeDir(join(c.profile, "Default"));
  const key = new TextEncoder().encode(recordKey(appIdOf(MID)));
  const batch = new Uint8Array([...le64(BigInt(loadStore(db).maxSeq + 1)), 1, 0, 0, 0, 0, ...putVarint(key.length), ...key]);
  const logf = join(db, "000003.log");
  appendFileSync(logf, frameLogRecord(batch, statSync(logf).size));
  assert.equal(run(c, "open", ["--url", `${MID}#t=tok-123`]).status, 10);
  assert.equal(marker(c).state, "removed");
  const auto = run(c, "install", ["--auto"]);
  assert.equal(auto.status, 3);
  assert.match(auto.out, /stays removed/);
  assert.equal(run(c, "install").status, 0);
  assert.equal(marker(c).state, "installed");
  assert.equal(wco(c), true);
});

function le64(n: bigint): number[] {
  return Array.from({ length: 8 }, (_, k) => Number((n >> BigInt(8 * k)) & 0xffn));
}

test("usage: a missing or non-numeric port is refused", () => {
  const r = spawnSync(process.execPath, [MAC_APP, "install", "--browser", fakeBrowser, "--profile", root, "--port", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
