import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * The tunnel manager on real processes (§mesh.tunnel/lifetime), with the fake cloudflared
 * (server/testing/fake-cloudflared.mjs, which counts every metrics request it answers) and a stand-in
 * server (tunnel-standin.ts). Never the network, never a real cloudflared.
 * - detached driver: the stand-in server is a plain process killed outright; the tunnel outlives it
 *   and is adopted with the same address; its end reaches the next server as an event, with no
 *   request to the tunnel in between (the proof of no polling).
 * - systemd (only with SOVA_TEST_SYSTEMD=1 and a user manager answering): the server is a stand-in
 *   unit (KillMode=control-group, Restart=always, as sova-runtime.service) restarted with systemctl;
 *   the tunnel is a unit in a top-level test slice and keeps its pid and address.
 */

const STANDIN = join(import.meta.dirname, "tunnel-standin.ts");
const FAKE = join(import.meta.dirname, "..", "..", "testing", "fake-cloudflared.mjs");
const BUN = process.execPath;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "sova-tun-int-"));
  dirs.push(root);
  const agent = join(root, "agent");
  const log = join(root, "fake.log");
  return { root, agent, log, tunnels: join(agent, "sova", "tunnels") };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
  } catch {
    return false;
  }
};
const fakeLog = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const fakePids = (log: string) => fakeLog(log).flatMap((l) => (/^start (\d+) /.exec(l) ? [Number(/^start (\d+)/.exec(l)![1])] : []));
const requests = (log: string) => fakeLog(log).filter((l) => /^\d+ \//.test(l)).length;

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

type Status = { what: string; state: string; origin: string | null; epoch: number | null; previous?: { origin: string } };

/** A stand-in server in start mode; its status lines as they come. */
function startServer(env: NodeJS.ProcessEnv) {
  const p = spawn(BUN, [STANDIN, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  const lines: Status[] = [];
  let buf = "";
  let err = "";
  p.stdout!.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
  });
  p.stderr!.on("data", (d) => (err += d));
  return { p, lines, err: () => err };
}

function runStandin(mode: string, env: NodeJS.ProcessEnv): Status {
  const r = spawnSync(BUN, [STANDIN, mode], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

const envFor = (s: ReturnType<typeof scratch>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PI_CODING_AGENT_DIR: s.agent,
  SOVA_CLOUDFLARED: FAKE,
  SOVA_TUNNEL_VERIFY: "off",
  FAKE_CF_LOG: s.log,
  ...extra,
});

test("detached: a tunnel outlives its server, is adopted with the same address, its end arrives as an event (no request to the tunnel between), and stop leaves nothing", { skip: process.platform !== "linux" && process.platform !== "darwin" }, async () => {
  const s = scratch();
  const env = envFor(s, { SOVA_TUNNEL_DRIVER: "detached", STANDIN_WANTED: "1" });
  const first = startServer(env);
  const up = await waitFor("the first address", () => first.lines.find((l) => l.what === "ensured"));
  assert.equal(up.state, "up", first.err());
  assert.match(up.origin ?? "", /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  const [pid] = fakePids(s.log);
  // The server dies outright; the tunnel doesn't.
  first.p.kill("SIGKILL");
  await new Promise((r) => first.p.once("exit", r));
  await sleep(300);
  assert.ok(alive(pid!), "cloudflared outlived its server");
  // The next server adopts it: same process, same address and epoch.
  const adopted = runStandin("adopt", env);
  assert.deepEqual([adopted.state, adopted.origin, adopted.epoch], ["up", up.origin, up.epoch]);
  assert.deepEqual(fakePids(s.log), [pid], "nothing new started");
  // A server holding it: cloudflared is killed. The end comes from the hook's file, not from asking.
  const second = startServer(env);
  await waitFor("the second server's adopt", () => second.lines.find((l) => l.what === "ensured"));
  const asked = requests(s.log);
  process.kill(pid!, "SIGKILL");
  const restarted = await waitFor("a new address after the end", () => second.lines.find((l) => l.what === "changed" && l.state === "up" && l.origin !== up.origin));
  const pids = fakePids(s.log);
  assert.equal(pids.length, 2, "started again once, from the end event");
  // Every request after the kill went to the new cloudflared (its address and readiness): none to the dead one.
  const after = fakeLog(s.log).filter((l) => /^\d+ \//.test(l)).slice(asked);
  assert.ok(after.every((l) => l.startsWith(`${pids[1]} `)), `no request to the ended tunnel: ${after.join(" | ")}`);
  assert.equal(restarted.previous?.origin, up.origin, "the old address is kept for the broken-links notice");
  // Idle for a while: no request at all (nothing polls).
  const idle = requests(s.log);
  await sleep(1_500); // proves only that nothing happens: no event is due in this window
  assert.equal(requests(s.log), idle, "nothing asks a running tunnel while idle");
  second.p.kill("SIGKILL");
  await new Promise((r) => second.p.once("exit", r));
  // Stop for good: the process and every file go.
  const stopped = runStandin("stop", env);
  assert.equal(stopped.state, "stopped");
  await waitFor("cloudflared's end", () => !alive(pids[1]!));
  assert.deepEqual(readdirSync(s.tunnels).filter((f) => !["hook.sh", "procs", "logs", "env"].includes(f)), []);
  assert.deepEqual(readdirSync(join(s.tunnels, "procs")), []);
});

test("detached: a start that cloudflared fails reports it with cloudflared's own line and starts nothing more while unwanted", async () => {
  const s = scratch();
  const env = envFor(s, { SOVA_TUNNEL_DRIVER: "detached", FAKE_CF_FAIL: "start" });
  const srv = startServer(env);
  const r = await waitFor("the failed start", () => srv.lines.find((l) => l.what === "ensured"));
  assert.equal(r.state, "failed", srv.err());
  assert.match(JSON.stringify(r), /FAKE_CF_FAIL=start/, "its own last line is in detail");
  srv.p.kill("SIGKILL");
  assert.equal(existsSync(join(s.tunnels, "tunnels.json")), false, "no record left");
});

test("detached: scripts/stop-tunnels.ts stops a tunnel whose server is gone, through its record", async () => {
  const s = scratch();
  const env = envFor(s, { SOVA_TUNNEL_DRIVER: "detached" });
  const srv = startServer(env);
  const up = await waitFor("the address", () => srv.lines.find((l) => l.what === "ensured"));
  assert.equal(up.state, "up", srv.err());
  srv.p.kill("SIGKILL");
  await new Promise((r) => srv.p.once("exit", r));
  const [pid] = fakePids(s.log);
  const r = spawnSync(BUN, [join(import.meta.dirname, "..", "..", "..", "scripts", "stop-tunnels.ts"), "--agent-dir", s.agent], { env: { ...env, PI_CODING_AGENT_DIR: "" }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 tunnel stopped/);
  await waitFor("cloudflared's end", () => !alive(pid!));
  assert.equal(existsSync(join(s.tunnels, "tunnels.json")), false);
});

test("detached Account: the token reaches cloudflared only in its env, its record is 0600 in 0700 folders; an ingress to another port is stopped", async () => {
  const s = scratch();
  const token = "eyJhIjoi" + "k".repeat(60);
  const env = envFor(s, { SOVA_TUNNEL_DRIVER: "detached", STANDIN_ACCOUNT_TOKEN: token, FAKE_CF_INGRESS: "http://127.0.0.1:4899" });
  const srv = startServer(env);
  const up = await waitFor("the Account tunnel", () => srv.lines.find((l) => l.what === "ensured"));
  assert.deepEqual([up.state, up.origin], ["up", "https://share.example.com"], srv.err());
  const log = fakeLog(s.log).join("\n");
  assert.match(log, /^token-env yes$/m);
  assert.doesNotMatch(log, /token-in-argv/);
  assert.ok(!log.includes(token.slice(0, 24)), "the fake never logs it, and nothing put it in argv");
  for (const d of [s.tunnels, join(s.tunnels, "procs")]) assert.equal(statSync(d).mode & 0o077, 0, `${d} is the owner's only`);
  const [rec] = readdirSync(join(s.tunnels, "procs"));
  assert.equal(statSync(join(s.tunnels, "procs", rec!)).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(s.tunnels, "tunnels.json"), "utf8").includes(token.slice(0, 24)));
  srv.p.kill("SIGKILL");
  await new Promise((r) => srv.p.once("exit", r));
  runStandin("stop", env);
  // The same tunnel routed (in the dashboard) to Sova's app port: stopped at once, failed with the fix.
  const bad = scratch();
  const badEnv = envFor(bad, { SOVA_TUNNEL_DRIVER: "detached", STANDIN_ACCOUNT_TOKEN: token, FAKE_CF_INGRESS: "http://127.0.0.1:4800" });
  const b = startServer(badEnv);
  const refused = await waitFor("the refusal", () => b.lines.find((l) => l.what === "ensured"));
  assert.equal(refused.state, "failed", b.err());
  assert.match(JSON.stringify(refused), /point its public hostname at http:\/\/127\.0\.0\.1:4899/);
  const [pid] = fakePids(bad.log);
  await waitFor("its cloudflared's end", () => !alive(pid!));
  b.p.kill("SIGKILL");
  // Routes pushed after it connects, pointing at Sova's app: caught by the one-shot look 3 s on, with no demand.
  const late = scratch();
  const lateEnv = envFor(late, { SOVA_TUNNEL_DRIVER: "detached", STANDIN_ACCOUNT_TOKEN: token, FAKE_CF_INGRESS: "http://127.0.0.1:4800", FAKE_CF_INGRESS_AFTER_MS: "500" });
  const l = startServer(lateEnv);
  const first = await waitFor("the first look", () => l.lines.find((x) => x.what === "ensured"));
  assert.equal(first.state, "degraded", "not up while its routes are unread");
  const caught = await waitFor("the later look's refusal", () => l.lines.find((x) => x.what === "changed" && x.state === "failed"), 15_000);
  assert.match(JSON.stringify(caught), /point its public hostname/);
  const [latePid] = fakePids(late.log);
  await waitFor("its cloudflared's end", () => !alive(latePid!));
  l.p.kill("SIGKILL");
});

const userBus = () => {
  try {
    execFileSync("systemctl", ["--user", "show", "--property=Version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};
const systemd = process.env.SOVA_TEST_SYSTEMD === "1" && process.platform === "linux" && userBus();

test("systemd: a tunnel unit survives a restart of the stand-in server unit (KillMode=control-group): same pid, same address", { skip: systemd ? false : "set SOVA_TEST_SYSTEMD=1 with a user manager (run by the coordinator from a plain shell)" }, async () => {
  const s = scratch();
  const tag = `${process.pid}`;
  const parent = `sova-standin-tun-${tag}`;
  const slice = `sovatunint${tag}.slice`;
  const env = envFor(s, { SOVA_TUNNEL_SLICE: slice });
  const sh = (...a: string[]) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });
  const set = (k: string) => `--setenv=${k}=${env[k] ?? ""}`;
  try {
    const r = spawnSync(
      "systemd-run",
      ["--user", `--unit=${parent}`, "--collect", "--property=KillMode=control-group", "--property=Restart=always", `--working-directory=${process.cwd()}`, ...["PI_CODING_AGENT_DIR", "SOVA_CLOUDFLARED", "SOVA_TUNNEL_VERIFY", "FAKE_CF_LOG", "SOVA_TUNNEL_SLICE", "PATH", "HOME"].map(set), "--", BUN, STANDIN, "start"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const rec = await waitFor("the tunnel's record", () => {
      try {
        const t = JSON.parse(readFileSync(join(s.tunnels, "tunnels.json"), "utf8")).tunnels.share;
        return t?.origin ? t : undefined;
      } catch {
        return undefined;
      }
    }, 30_000);
    const [pid] = fakePids(s.log);
    const cg = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    assert.match(cg, new RegExp(`/${slice.replace(/\./g, "\\.")}/`));
    assert.doesNotMatch(cg, new RegExp(parent), "outside the server's cgroup");
    assert.match(sh("show", `${rec.unit}.service`, "--property=Restart").stdout, /Restart=no/, "never restarted by systemd (Free)");
    // Restart the stand-in server: control-group kill takes everything in ITS cgroup, not the tunnel.
    assert.equal(sh("restart", `${parent}.service`).status, 0);
    await sleep(1_500);
    assert.ok(alive(pid!), "the tunnel outlived its server's restart");
    assert.deepEqual(fakePids(s.log), [pid], "the same process, not a new one");
    sh("stop", `${parent}.service`);
    const adopted = runStandin("adopt", env);
    assert.deepEqual([adopted.state, adopted.origin], ["up", rec.origin], "same address after the restart");
    // The hook writes its end: a stop through the manager leaves no unit and no file.
    runStandin("stop", env);
    await waitFor("the tunnel's end", () => !alive(pid!));
    assert.match(sh("show", `${rec.unit}.service`, "--property=LoadState").stdout, /not-found|LoadState=$/m);
  } finally {
    sh("stop", `${parent}.service`);
    for (const u of sh("list-units", "--all", "--plain", "--no-legend", "sova-tunnel-*").stdout.split("\n"))
      if (u.includes(".service") && spawnSync("systemctl", ["--user", "show", u.split(/\s+/)[0]!, "--property=Slice"], { encoding: "utf8" }).stdout.includes(slice)) sh("stop", u.split(/\s+/)[0]!);
    sh("stop", slice);
  }
});
