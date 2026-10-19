// Run: pnpm test:int -- server/scenarios.integration.test.ts
// Every scenario in scenarios/ (scripts/sova-scenario.mjs), each on a throwaway server of its own
// (server/testing/hermetic-server.ts: a free port, a throwaway agent dir, the scripted stand-in
// model, a sentinel HOME), driven only through scripts/sova.mjs. The same files run by hand with
// `pnpm run scenario`. Then the runner itself, against scenarios made to fail: a wrong title, a wrong
// exit class, an await that times out (with the watch's log), a write into the sentinel HOME. Each
// must fail, and say why, or a green scenario would prove nothing.
//
// All of it runs at once (each server is its own), so the file takes about as long as its longest
// scenario. Each server's boot is measured and held to 5 s, the whole file to 60 s.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadScenario, runScenario, scenarioFiles, type Scenario, type ScenarioResult } from "../scripts/sova-scenario.mjs";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

const BOOT_BUDGET_MS = 5_000;
const SUITE_BUDGET_MS = 60_000;
const t0 = performance.now();

// A key in this process's environment that the servers must never see (the check below reads theirs).
process.env.ANTHROPIC_API_KEY = "fake-key-0000-scenario-must-not-pass";
process.env.SOVA_PORT = "4800";

const files = scenarioFiles([]);
const run = (doc: Scenario, opts: Parameters<typeof runScenario>[1] = {}): Promise<ScenarioResult> => runScenario(doc, opts);

// Started at import, all at once; each test awaits its own.
const scenarios = files.map((file) => {
  const doc = loadScenario(file);
  return { file, doc, result: run(doc) };
});

/** A scenario with its steps. */
const scenario = (name: string, steps: unknown[]): Scenario => ({ name, steps });
const create = { name: "a new session", sova: ["run", "session.create", "--cwd", "."], save: "s" };

const mutants = {
  wrongTitle: run(
    scenario("wrong title", [
      create,
      { name: "rename it", sova: ["run", "session.title.set", "--session", "{{s.id}}", "--title", "What it is called"] },
      { name: "expect another title", sova: ["run", "session.get", "--session", "{{s.id}}"], json: { title: "What it is not called" } },
    ]),
  ),
  wrongExit: run(scenario("wrong exit class", [{ name: "an unknown command, expected to pass", sova: ["run", "no.such.command"], exit: 0 }])),
  awaitTimeout: run(
    scenario("await times out", [
      { name: "watch", watch: "w" },
      create,
      { name: "rename it", sova: ["run", "session.title.set", "--session", "{{s.id}}", "--title", "Seen title"] },
      { name: "await a rename that never happens", await: "w", event: { event: "renamed", title: "Never this title" }, timeoutMs: 1500 },
    ]),
  ),
  awaitTwice: run(
    scenario("one rename, awaited twice", [
      { name: "watch", watch: "w" },
      create,
      { name: "a message, so it is listed", sova: ["run", "session.send", "--session", "{{s.path}}", "--text", "Hello."] },
      { name: "it is listed", await: "w", event: { event: "created", id: "{{s.id}}" } },
      { name: "rename it", sova: ["run", "session.title.set", "--session", "{{s.id}}", "--title", "Renamed once"] },
      { name: "the rename", await: "w", event: { event: "renamed", title: "Renamed once" } },
      { name: "the same rename again", await: "w", event: { event: "renamed", title: "Renamed once" }, timeoutMs: 1500 },
    ]),
  ),
  sentinel: run(scenario("a write into the sentinel home", [create]), {
    afterBoot: (server: HermeticServer) => writeFileSync(join(server.home, ".pi", "agent", "written-by-a-test.json"), "{}"),
  }),
};

// One more server, only to read the environment it runs with: a sentinel check means nothing if the
// server never saw the sentinel as its HOME.
const envCheck = (async () => {
  const server = await startHermeticServer();
  try {
    const env = process.platform === "linux" ? readFileSync(`/proc/${server.pid}/environ`, "utf8").split("\0") : null;
    return { server: { home: server.home, agentDir: server.agentDir, bootMs: server.bootMs }, env };
  } finally {
    await server.stop();
  }
})();

for (const s of scenarios) {
  test(`scenario ${s.doc.name} (${s.file.split("/").pop()})`, { timeout: 120_000 }, async () => {
    const r = await s.result;
    assert.ok(r.ok, r.failure);
    assert.equal(r.homeChanges.length, 0, `the sentinel HOME changed: ${r.homeChanges.join(", ")}`);
    assert.ok(r.bootMs <= BOOT_BUDGET_MS, `the server took ${r.bootMs} ms to boot (budget ${BOOT_BUDGET_MS} ms)`);
    console.log(`scenario ${r.name}: ${r.ms} ms, boot ${r.bootMs} ms; steps: ${r.steps.map((x) => `${x.name} ${x.ms}`).join(", ")}`);
  });
}

test("a scenario expecting the wrong title fails, naming both titles", { timeout: 120_000 }, async () => {
  const r = await mutants.wrongTitle;
  assert.equal(r.ok, false);
  assert.match(r.failure ?? "", /^step 3 \(expect another title\): \$\.title: wanted "What it is not called", got "What it is called"/);
  assert.equal(r.steps.length, 2, "the steps before it passed");
});

test("an exit-class mismatch fails, naming both classes", { timeout: 120_000 }, async () => {
  const r = await mutants.wrongExit;
  assert.equal(r.ok, false);
  assert.match(r.failure ?? "", /^step 1 \(an unknown command, expected to pass\): exit 3, wanted 0/);
  assert.match(r.failure ?? "", /no command no\.such\.command/, "the CLI's own sentence is in the report");
});

test("an await that times out fails and prints the watch's log", { timeout: 120_000 }, async () => {
  const r = await mutants.awaitTimeout;
  assert.equal(r.ok, false);
  assert.match(r.failure ?? "", /^step 4 \(await a rename that never happens\): no event matching \{"event":"renamed","title":"Never this title"\} within 1500 ms/);
  assert.match(r.failure ?? "", /watch w printed \d+ event\(s\) and [1-9]\d* feed frame\(s\)/);
});

test("each await takes its own line: one rename awaited twice times out the second time", { timeout: 120_000 }, async () => {
  const r = await mutants.awaitTwice;
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 6, r.failure);
  assert.match(r.failure ?? "", /^step 7 \(the same rename again\): no event matching/);
});

// A parent killed outright (SIGKILL: no handler runs) leaves nothing behind: the watchdog ends the
// server, the stand-in and every process naming the agent dir.
const orphanCheck = (async () => {
  if (process.platform !== "linux") return null;
  const child = spawn("node", ["-e", `import("${join(import.meta.dirname, "testing", "hermetic-server.ts")}").then(async (m) => { const s = await m.startHermeticServer(); console.log(JSON.stringify({ pid: s.pid, mockPid: s.mockPid, agentDir: s.agentDir })); setInterval(() => {}, 1000); })`], { stdio: ["ignore", "pipe", "ignore"] });
  const info = await new Promise<{ pid: number; mockPid: number; agentDir: string }>((ok, fail) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      const line = buf.split("\n").find((l) => l.startsWith("{"));
      if (line) ok(JSON.parse(line));
    });
    child.once("exit", (c) => fail(new Error(`the child exited ${c} before its server was up`)));
  });
  child.kill("SIGKILL");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const naming = () => [
    ...(alive(info.mockPid) ? [`${info.mockPid} (the stand-in model)`] : []),
    ...readdirSync("/proc").filter((d) => {
      try {
        return /^\d+$/.test(d) && readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes(`PI_CODING_AGENT_DIR=${info.agentDir}`);
      } catch {
        return false;
      }
    }),
  ];
  const end = Date.now() + 10_000;
  while (naming().length && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  const left = naming();
  // What a failure leaves is cleaned up here, so a broken watchdog fails this test and leaks nothing.
  for (const pid of [...left.map((p) => parseInt(p, 10)), info.pid, info.mockPid])
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  return { left, serverPid: info.pid };
})();

test("a parent killed with SIGKILL leaves no server or chat running", { timeout: 120_000 }, async (t) => {
  const r = await orphanCheck;
  if (!r) return t.skip("reads /proc (Linux only)");
  assert.deepEqual(r.left, [], `still running after the parent died: ${r.left.join(", ")}`);
});

test("a write into the sentinel HOME fails the scenario", { timeout: 120_000 }, async () => {
  const r = await mutants.sentinel;
  assert.equal(r.ok, false);
  assert.deepEqual(r.homeChanges, ["added .pi/agent/written-by-a-test.json"]);
  assert.match(r.failure ?? "", /the sentinel HOME changed: added \.pi\/agent\/written-by-a-test\.json/);
});

test("the server runs with the sentinel HOME, the throwaway agent dir, and none of the caller's keys", { timeout: 120_000 }, async (t) => {
  const { server, env } = await envCheck;
  if (!env) return t.skip("reads /proc (Linux only)");
  assert.ok(env.includes(`HOME=${server.home}`), `HOME is not the sentinel: ${env.find((e) => e.startsWith("HOME="))}`);
  assert.notEqual(server.home, homedir());
  assert.ok(env.includes(`PI_CODING_AGENT_DIR=${server.agentDir}`));
  assert.ok(!env.some((e) => e.startsWith("ANTHROPIC_API_KEY=")), "the caller's key reached the server");
  assert.ok(!env.some((e) => e.startsWith("SOVA_PORT=")), "the caller's SOVA_* reached the server");
  assert.ok(env.includes("PORT=0"));
});

test(`the whole file within ${SUITE_BUDGET_MS / 1000} s, every boot within ${BOOT_BUDGET_MS / 1000} s`, { timeout: 120_000 }, async () => {
  const all = await Promise.all([...scenarios.map((s) => s.result), ...Object.values(mutants)]);
  const ms = Math.round(performance.now() - t0);
  console.log(`scenarios: ${scenarios.length} + ${Object.keys(mutants).length} runner checks in ${ms} ms; boots ${all.map((r) => r.bootMs).join(", ")} ms`);
  assert.ok(scenarios.length >= 3, `scenarios/ holds ${scenarios.length} scenarios`);
  for (const r of all) assert.ok(r.bootMs <= BOOT_BUDGET_MS, `${r.name}: boot ${r.bootMs} ms`);
  assert.ok(ms <= SUITE_BUDGET_MS, `${ms} ms`);
});
