import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * The chat supervisor on real processes: a stand-in server (supervisor-standin.ts) starts a stand-in
 * chat, the stand-in server goes away, and the chat must still run and be adopted by the next one.
 * - detached test driver (no user bus needed): the server is a plain process killed outright;
 * - systemd (only with SOVA_TEST_SYSTEMD=1 and a user manager answering): the server is a stand-in
 *   unit (KillMode=control-group, Restart=always, as the live one) restarted with systemctl, the chat
 *   a unit in a top-level test slice (no dash: a dash nests a slice under its prefix). Never
 *   sova-runtime.service, never sova-chats.slice.
 */

const FIXTURE = join(import.meta.dirname, "supervisor-standin.ts");
const BUN = process.execPath;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "sova-sup-int-"));
  dirs.push(root);
  return { agent: join(root, "agent"), out: root };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
  } catch {
    return false;
  }
};
const chatPid = (out: string) => Number(/^pid (\d+)$/m.exec(readFileSync(join(out, "chat.txt"), "utf8"))?.[1] ?? 0);
const beats = (out: string) => (readFileSync(join(out, "chat.txt"), "utf8").match(/^beat /gm) ?? []).length;

function runFixture(mode: string, env: NodeJS.ProcessEnv, out: string): string {
  const r = spawnSync(BUN, [FIXTURE, mode, out], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
  return r.stdout.trim();
}

async function waitFor(what: string, fn: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

test("a chat started by a server outlives it and is adopted by the next one; its death is reported once (detached driver)", { skip: process.platform !== "linux" }, async () => {
  const { agent, out } = scratch();
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_CHAT_DRIVER: "detached" };
  const server = spawn(BUN, [FIXTURE, "start", out], { env, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  server.stdout.on("data", (d) => (said += d));
  await waitFor("the chat's record", () => said.includes("\n"));
  const rec = JSON.parse(said);
  await waitFor("the chat's heartbeat", () => existsSync(join(out, "chat.txt")) && beats(out) > 0);
  const pid = chatPid(out);
  assert.equal(rec.pid, pid);
  // The server dies outright.
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  const before = beats(out);
  await sleep(600);
  assert.ok(alive(pid), "the chat process outlived its server");
  assert.ok(beats(out) > before, "and kept working");
  // The next server adopts it, same process.
  const adopted = JSON.parse(runFixture("adopt", env, out));
  assert.deepEqual(adopted.adopted.map((r: { pid: number }) => r.pid), [pid]);
  assert.deepEqual(adopted.died, []);
  // It crashes while no server watches: the next start reports it, once.
  process.kill(pid, "SIGKILL");
  await waitFor("the chat's end", () => !alive(pid));
  const after1 = JSON.parse(runFixture("adopt", env, out));
  assert.deepEqual(after1.adopted, []);
  assert.deepEqual(after1.died.map((d: { chatId: string; cause: string }) => [d.chatId, d.cause]), [["standin-chat-1", "lost"]]);
  assert.equal(JSON.parse(runFixture("adopt", env, out)).died.length, 0);
  assert.equal(readFileSync(join(agent, "sova", "chats", "deaths.jsonl"), "utf8").trim().split("\n").length, 1);
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

test("systemd: a chat unit survives a restart of the stand-in server unit, outside its cgroup, and stops in order", { skip: systemd ? false : "set SOVA_TEST_SYSTEMD=1 with a user manager (run by the coordinator from a plain shell)" }, async () => {
  const { agent, out } = scratch();
  const tag = `${process.pid}`;
  const parent = `sova-standin-sup-${tag}`;
  const slice = `sovasupint${tag}.slice`;
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_CHAT_SLICE: slice };
  const sh = (...a: string[]) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });
  try {
    const r = spawnSync(
      "systemd-run",
      ["--user", `--unit=${parent}`, "--collect", "--property=KillMode=control-group", "--property=Restart=always", `--working-directory=${process.cwd()}`, `--setenv=PI_CODING_AGENT_DIR=${agent}`, `--setenv=SOVA_CHAT_SLICE=${slice}`, `--setenv=PATH=${process.env.PATH}`, `--setenv=HOME=${process.env.HOME}`, "--", BUN, FIXTURE, "start", out],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    await waitFor("the chat's heartbeat", () => existsSync(join(out, "chat.txt")) && beats(out) > 0, 30_000);
    const pid = chatPid(out);
    const cg = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    assert.match(cg, new RegExp(`/${slice.replace(/\./g, "\\.")}/`));
    assert.doesNotMatch(cg, new RegExp(parent), "outside the server's cgroup");
    // Restart the stand-in server (its start would start the chat again: it is already running, so nothing new).
    assert.equal(sh("restart", `${parent}.service`).status, 0);
    await sleep(1_500);
    assert.ok(alive(pid), "the chat outlived its server's restart");
    assert.equal(chatPid(out), pid, "the same process, not a new one");
    const unit = JSON.parse(readFileSync(join(agent, "sova", "chats", "registry", "standin-chat-1.json"), "utf8")).unit as string;
    assert.match(sh("show", `${unit}.service`, "--property=KillMode").stdout, /KillMode=mixed/);
    assert.match(sh("show", `${unit}.service`, "--property=Restart").stdout, /Restart=no/);
    // Stop the server, then the chat through a fresh supervisor: an orderly end.
    sh("stop", `${parent}.service`);
    runFixture("stop", env, out);
    await waitFor("the chat's end", () => !alive(pid));
    assert.match(readFileSync(join(out, "chat.txt"), "utf8"), /^disposed$/m);
  } finally {
    sh("stop", `${parent}.service`);
    for (const u of sh("list-units", "--all", "--plain", "--no-legend", "sova-chat-*").stdout.split("\n"))
      if (u.includes(".service") && spawnSync("systemctl", ["--user", "show", u.split(/\s+/)[0]!, "--property=Slice"], { encoding: "utf8" }).stdout.includes(slice)) sh("stop", u.split(/\s+/)[0]!);
    sh("stop", slice);
  }
});

test("systemd: with no server running, a chat killed is one death (KILL, from the journal); a chat stopped cleanly is none", { skip: systemd ? false : "set SOVA_TEST_SYSTEMD=1 with a user manager (run by the coordinator from a plain shell)" }, async () => {
  const { agent, out } = scratch();
  const slice = `sovasupint${process.pid}d.slice`;
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_CHAT_SLICE: slice };
  const sh = (...a: string[]) => spawnSync("systemctl", ["--user", ...a], { encoding: "utf8" });
  const unitFile = () => JSON.parse(readFileSync(join(agent, "sova", "chats", "registry", "standin-chat-1.json"), "utf8")).unit as string;
  /** A stand-in server starts the chat, then is killed outright. */
  async function startThenLoseServer(): Promise<{ pid: number; unit: string }> {
    rmSync(join(out, "chat.txt"), { force: true });
    const server = spawn(BUN, [FIXTURE, "start", out], { env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    server.stdout.on("data", (d) => (said += d));
    await waitFor("the chat's record", () => said.includes("\n"), 30_000);
    await waitFor("the chat's heartbeat", () => existsSync(join(out, "chat.txt")) && beats(out) > 0, 30_000);
    server.kill("SIGKILL");
    await new Promise((r) => server.once("exit", r));
    return { pid: chatPid(out), unit: unitFile() };
  }
  try {
    const killed = await startThenLoseServer();
    assert.equal(sh("kill", "--signal=SIGKILL", `${killed.unit}.service`).status, 0);
    await waitFor("the killed chat's end", () => !alive(killed.pid));
    await sleep(500);
    const a1 = JSON.parse(runFixture("adopt", env, out));
    assert.deepEqual(a1.died.map((d: { cause: string; signal: string | null }) => [d.cause, d.signal]), [["crashed", "KILL"]], "the journal says how it ended");
    const stopped = await startThenLoseServer();
    assert.equal(sh("stop", `${stopped.unit}.service`).status, 0);
    await waitFor("the stopped chat's end", () => !alive(stopped.pid));
    assert.match(readFileSync(join(out, "chat.txt"), "utf8"), /^disposed$/m);
    const a2 = JSON.parse(runFixture("adopt", env, out));
    assert.deepEqual(a2, { adopted: [], died: [] }, "a clean stop (exit 0, deactivated) is no death");
  } finally {
    for (const u of sh("list-units", "--all", "--plain", "--no-legend", "sova-chat-*").stdout.split("\n"))
      if (u.includes(".service") && spawnSync("systemctl", ["--user", "show", u.split(/\s+/)[0]!, "--property=Slice"], { encoding: "utf8" }).stdout.includes(slice)) sh("stop", u.split(/\s+/)[0]!);
    sh("stop", slice);
  }
});
