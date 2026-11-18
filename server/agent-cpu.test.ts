// The agents' CPU (server/agent-cpu.ts) against a stand-in systemctl: never the real user manager. When Sova leaves
// sova.slice alone, the lower weight at start, and the optional ceiling's set and removal (systemd first, then the
// file; a refusal changes neither), through the class and its two routes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { AGENTS_CPU_WEIGHT, AgentCpu, ownUnit, quotaProperty, registerAgentCpuRoutes, staticObstacle, timespanSeconds } from "./agent-cpu";
import { pageHeaders } from "./testing/page";
import type { Exec } from "./project-services/drivers";

const root = mkdtempSync(join(tmpdir(), "agent-cpu-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A user manager holding one slice's weight and quota; `failSet` refuses set-property, `down` answers nothing. */
function fakeSystemd(o: { weight?: string; quota?: string; failSet?: boolean; down?: boolean } = {}) {
  const calls: string[][] = [];
  const slice = { weight: o.weight ?? "[not set]", quota: o.quota ?? "infinity" };
  const exec: Exec = async (file, args) => {
    assert.equal(file, "systemctl");
    assert.equal(args[0], "--user");
    calls.push(args.slice(1));
    if (o.down) return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
    const [verb, ...rest] = args.slice(1);
    if (verb === "show" && rest[0] === "--property=Version") return { code: 0, stdout: "Version=258\n", stderr: "" };
    if (verb === "show") return { code: 0, stdout: `CPUWeight=${slice.weight}\nCPUQuotaPerSecUSec=${slice.quota}\n`, stderr: "" };
    if (verb === "set-property") {
      if (o.failSet) return { code: 1, stdout: "", stderr: "Access denied" };
      for (const a of rest.slice(2)) {
        const [k, v] = a.split("=") as [string, string];
        if (k === "CPUWeight") slice.weight = v;
        if (k === "CPUQuota") slice.quota = v === "" ? "infinity" : `${Number(v.replace("%", "")) / 100}s`;
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${verb}` };
  };
  const sets = () => calls.filter((c) => c[0] === "set-property");
  return { exec, calls, sets, slice };
}

function make(sd: ReturnType<typeof fakeSystemd>, o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cgroup?: string; saved?: unknown } = {}) {
  const file = join(root, `agent-cpu-${++n}.json`);
  if (o.saved !== undefined) writeFileSync(file, JSON.stringify(o.saved));
  const cpu = new AgentCpu({ exec: sd.exec, env: o.env ?? {}, platform: o.platform ?? "linux", cores: () => 16, ownCgroup: () => o.cgroup ?? "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sova-runtime.service\n", file: () => file });
  return { cpu, file };
}

describe("when Sova leaves sova.slice alone", () => {
  const app = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sova.service\n";
  test("only Sova's installed service touches it: a dev, hermetic, test or load-experiment server never does", () => {
    const at = (unit: string) => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
    assert.equal(staticObstacle({}, "linux", at("sova.service")), null);
    assert.equal(staticObstacle({}, "linux", at("sova-runtime.service")), null);
    for (const unit of ["sova-svc-ab12-server.service", "app-foot-1234.scope", "run-u77.service", "sova-perf-load.scope", "sova-runtime-copy.service"])
      assert.match(staticObstacle({ SOVA_AGENT_CPU: "on" }, "linux", at(unit))!, new RegExp(`Only Sova's installed service sets this; this copy runs as ${unit.replace(/[.]/g, "\\.")}\\.`), unit);
    assert.match(staticObstacle({}, "linux", null)!, /runs outside a systemd service\./);
    assert.match(staticObstacle({}, "linux", "12:cpu:/foo\n")!, /outside a systemd service/);
    assert.equal(ownUnit("1:name=systemd:/x\n0::/user.slice/a.slice/sova.service\n"), "sova.service");
  });

  test("on a scratch server nothing asks systemd, at start or on a change", async () => {
    const sd = fakeSystemd();
    const { cpu } = make(sd, { env: { SOVA_AGENT_CPU: "on" }, cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sova-svc-x-server.service\n", saved: { maxCores: 2 } });
    await cpu.applyAtStart();
    await assert.rejects(cpu.set(4), (e: Error & { status?: number }) => e.status === 409);
    assert.equal((await cpu.state()).available, false);
    assert.deepEqual(sd.calls, []);
  });

  test("every reason, and none on a real server's Linux", () => {
    assert.match(staticObstacle({}, "darwin", null)!, /needs Linux with systemd\. On macOS/);
    assert.match(staticObstacle({ SOVA_AGENT_CPU: "off" }, "linux", app)!, /SOVA_AGENT_CPU=off/);
    assert.match(staticObstacle({ SOVA_CHAT_DRIVER: "detached" }, "linux", app)!, /detached processes/);
    assert.match(staticObstacle({ SOVA_CHAT_SLICE: "sova_test_ab12.slice" }, "linux", app)!, /own slice \(sova_test_ab12\.slice\)/);
    assert.match(staticObstacle({ SOVA_JOBS_SLICE: "trial.slice" }, "linux", app)!, /own slice \(trial\.slice\)/);
    assert.match(staticObstacle({}, "linux", "0::/user.slice/user-1000.slice/user@1000.service/sova.slice/sova-x.service\n")!, /runs inside sova\.slice/);
    assert.equal(staticObstacle({ SOVA_CHAT_SLICE: "sova-chats.slice", SOVA_JOBS_SLICE: "sova-jobs.slice", SOVA_AGENT_CPU: "on" }, "linux", app), null);
  });

  test("on macOS nothing asks systemd, at start or on a change", async () => {
    const sd = fakeSystemd();
    const { cpu, file } = make(sd, { platform: "darwin" });
    await cpu.applyAtStart();
    const st = await cpu.state();
    assert.equal(st.available, false);
    assert.match(st.why!, /macOS/);
    await assert.rejects(cpu.set(4), (e: Error & { status?: number }) => e.status === 409 && /Nothing changed\.$/.test(e.message));
    assert.deepEqual(sd.calls, []);
    assert.equal(existsSync(file), false);
  });

  test("with no user manager answering, it is unavailable and never set", async () => {
    const sd = fakeSystemd({ down: true });
    const { cpu } = make(sd, { saved: { maxCores: 4 } });
    await cpu.applyAtStart();
    const st = await cpu.state();
    assert.deepEqual([st.available, st.maxCores, st.inForce], [false, 4, null]);
    assert.match(st.why!, /No systemd user manager/);
    assert.deepEqual(sd.sets(), []);
  });
});

describe("at a server's start", () => {
  test("the weight goes below the server's side, runtime only, and no ceiling by default", async () => {
    const sd = fakeSystemd();
    const { cpu } = make(sd);
    await cpu.applyAtStart();
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", `CPUWeight=${AGENTS_CPU_WEIGHT}`]]);
    assert.ok(AGENTS_CPU_WEIGHT < 100, "below app.slice's default 100");
  });

  test("a saved ceiling is put back; what systemd already holds is not set again", async () => {
    const sd = fakeSystemd({ weight: "18446744073709551615" });
    const { cpu } = make(sd, { saved: { maxCores: 6 } });
    await cpu.applyAtStart();
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", "CPUWeight=20", "CPUQuota=600%"]]);
    await cpu.applyAtStart();
    assert.equal(sd.sets().length, 1);
  });

  test("a ceiling systemd holds that Sova no longer has is removed", async () => {
    const sd = fakeSystemd({ weight: "20", quota: "4s" });
    const { cpu } = make(sd);
    await cpu.applyAtStart();
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", "CPUQuota="]]);
  });

  test("a file that isn't a whole number of cores counts as no ceiling", async () => {
    for (const saved of [{ maxCores: 0 }, { maxCores: 2.5 }, { maxCores: "4" }, "x"]) {
      const sd = fakeSystemd({ weight: "20" });
      const { cpu } = make(sd, { saved });
      await cpu.applyAtStart();
      assert.deepEqual(sd.sets(), [], JSON.stringify(saved));
      assert.equal((await cpu.state()).maxCores, null);
    }
  });

  test("a refusal is logged, never thrown", async () => {
    const sd = fakeSystemd({ failSet: true });
    const { cpu } = make(sd);
    await cpu.applyAtStart();
    assert.equal(sd.sets().length, 1);
  });
});

describe("the ceiling", () => {
  test("set: systemd first, then the file; the state says it is in force", async () => {
    const sd = fakeSystemd({ weight: "20" });
    const { cpu, file } = make(sd);
    const st = await cpu.set(4);
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", "CPUQuota=400%"]]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { maxCores: 4 });
    assert.deepEqual(st, { available: true, why: null, cores: 16, maxCores: 4, inForce: 4 });
  });

  test("off: the quota is removed and the file goes", async () => {
    const sd = fakeSystemd({ weight: "20", quota: "4s" });
    const { cpu, file } = make(sd, { saved: { maxCores: 4 } });
    const st = await cpu.set(null);
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", "CPUQuota="]]);
    assert.equal(existsSync(file), false);
    assert.deepEqual([st.maxCores, st.inForce], [null, null]);
  });

  test("the rule's edges: 1 and the computer's cores pass, 0, one more and non-numbers are refused untouched", async () => {
    for (const ok of [1, 16, "8"]) {
      const sd = fakeSystemd();
      assert.equal((await make(sd).cpu.set(ok)).maxCores, Number(ok));
    }
    for (const bad of [0, 17, -1, 2.5, "x", "", true]) {
      const sd = fakeSystemd();
      const { cpu, file } = make(sd);
      await assert.rejects(cpu.set(bad), (e: Error & { status?: number }) => e.status === 400 && /Cores must be a whole number from 1 to 16\./.test(e.message), String(bad));
      assert.deepEqual(sd.sets(), []);
      assert.equal(existsSync(file), false);
    }
  });

  test("a file that can't be written puts systemd back as it was", async () => {
    const sd = fakeSystemd({ weight: "20", quota: "2s" });
    // The file's folder is a file: the write fails after systemd took the change.
    const blocker = join(root, `blocker-${++n}`);
    writeFileSync(blocker, "");
    const cpu = new AgentCpu({ exec: sd.exec, env: {}, platform: "linux", cores: () => 16, ownCgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sova.service\n", file: () => join(blocker, "agent-cpu.json") });
    await assert.rejects(cpu.set(8), (e: Error & { status?: number }) => e.status === 502 && /Couldn't save the setting/.test(e.message) && /Nothing changed\.$/.test(e.message));
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", "CPUQuota=800%"], ["set-property", "--runtime", "sova.slice", "CPUQuota="]]);
    assert.equal(sd.slice.quota, "infinity", "the file had no ceiling, so systemd holds none");
  });

  test("matchFile: systemd follows a file someone else put back", async () => {
    const sd = fakeSystemd({ weight: "20", quota: "4s" });
    const { cpu } = make(sd, { saved: { maxCores: 2 } });
    await cpu.matchFile();
    assert.deepEqual(sd.sets(), [["set-property", "--runtime", "sova.slice", "CPUQuota=200%"]]);
    await cpu.matchFile();
    assert.equal(sd.sets().length, 1, "already so: nothing set");
  });

  test("systemd's refusal keeps the saved ceiling", async () => {
    const sd = fakeSystemd({ failSet: true });
    const { cpu, file } = make(sd, { saved: { maxCores: 2 } });
    await assert.rejects(cpu.set(8), (e: Error & { status?: number }) => e.status === 502 && /Access denied/.test(e.message) && /Nothing changed\.$/.test(e.message));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { maxCores: 2 });
  });
});

test("systemd's timespans in seconds", () => {
  assert.equal(timespanSeconds("infinity"), null);
  assert.equal(timespanSeconds(""), null);
  assert.equal(timespanSeconds("4s"), 4);
  assert.equal(timespanSeconds("1.500000s"), 1.5);
  assert.equal(timespanSeconds("500ms"), 0.5);
  assert.equal(timespanSeconds("1min 4s"), 64);
  assert.equal(timespanSeconds("4 parsecs"), null);
  assert.equal(quotaProperty(3), "CPUQuota=300%");
  assert.equal(quotaProperty(null), "CPUQuota=");
});

describe("GET and PUT /api/settings/agent-cpu", () => {
  const sd = fakeSystemd({ weight: "20" });
  const { cpu } = make(sd);
  const app = new Hono();
  registerAgentCpuRoutes(app, () => cpu);
  const put = (body: string, headers: Record<string, string> = pageHeaders()) => app.request("/api/settings/agent-cpu", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body });

  test("reads the state, sets and removes the ceiling", async () => {
    const got = await app.request("/api/settings/agent-cpu");
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("cache-control"), "no-store");
    assert.deepEqual(await got.json(), { available: true, why: null, cores: 16, maxCores: null, inForce: null });
    const on = await put(JSON.stringify({ maxCores: 3 }));
    assert.equal(on.status, 200);
    assert.equal(((await on.json()) as { maxCores: number }).maxCores, 3);
    const off = await put(JSON.stringify({ maxCores: null }));
    assert.equal(((await off.json()) as { maxCores: null }).maxCores, null);
  });

  test("only the user's own page changes it: a chat, a script or no page at all is refused, nothing changed", async () => {
    const before = sd.sets().length;
    for (const [who, headers] of [
      ["a chat", { "x-sova-token": "t", "x-sova-caller": "k" }],
      ["a script", { "x-sova-token": "t" }],
      ["no page", {}],
    ] as const) {
      const r = await put(JSON.stringify({ maxCores: 2 }), headers);
      assert.equal(r.status, 403, who);
      const body = (await r.json()) as { error: string; yourClick: boolean };
      assert.equal(body.error, "Only the user changes how much CPU agents may use. Ask them to do it in Settings → General. Nothing was changed.", who);
      assert.equal(body.yourClick, true);
    }
    assert.equal(sd.sets().length, before);
    assert.equal((await cpu.state()).maxCores, null);
  });

  test("a body without maxCores, or no JSON, is a 400 that changes nothing", async () => {
    const before = sd.sets().length;
    for (const body of ["{}", "nope", JSON.stringify({ maxCores: 99 })]) {
      const r = await put(body);
      assert.equal(r.status, 400, body);
      assert.match(((await r.json()) as { error: string }).error, /maxCores|Cores must be/);
    }
    assert.equal(sd.sets().length, before);
  });
});
