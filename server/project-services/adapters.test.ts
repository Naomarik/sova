import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ADAPTERS, SelectedDriver, selectDriver } from "./adapters";
import { type Exec } from "./drivers";
import { FakeHost } from "./fake-host";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-adapters-"));
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

/** A `systemctl` that answers (a user manager is there) or fails as it does with no bus; records its calls. */
function systemctl(up: boolean): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return up ? { code: 0, stdout: "Version=257\n", stderr: "" } : { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" };
    },
  };
}

test("the adapters: systemd and detached are built, launchd is a reserved slot", () => {
  assert.deepEqual(
    ADAPTERS.map((a) => [a.id, !!a.make]),
    [
      ["systemd", true],
      ["detached", true],
      ["launchd", false],
    ],
  );
});

test("SOVA_PROJECT_DRIVER forces an adapter, whatever the probe would say", async () => {
  const sd = systemctl(true);
  const forced = await selectDriver({ env: { SOVA_PROJECT_DRIVER: "detached" }, platform: "linux", exec: sd.exec });
  assert.equal(forced.id, "detached");
  assert.equal(forced.driver?.id, "detached");
  assert.match(forced.why, /forced by SOVA_PROJECT_DRIVER=detached/);
  assert.equal(sd.calls.length, 0, "no probe when forced");
  const down = systemctl(false);
  const sys = await selectDriver({ env: { SOVA_PROJECT_DRIVER: "systemd" }, platform: "linux", exec: down.exec });
  assert.equal(sys.id, "systemd", "forced systemd stays systemd with no bus: the verbs then answer unsupported");
  assert.equal((await sys.driver!.available()).ok, false);
});

test("forcing launchd or an unknown name leaves no supervisor, and says why", async () => {
  const l = new SelectedDriver({ env: { SOVA_PROJECT_DRIVER: "launchd" }, platform: "darwin", exec: systemctl(true).exec });
  const a = await l.available();
  assert.equal(a.ok, false);
  assert.match(a.detail, /launchd adapter \(launchd agents \(macOS\)\) is reserved and not built yet/);
  assert.equal(l.id, "launchd");
  await assert.rejects(l.start({ unit: "u", argv: ["true"], cwd: "/", env: {} }), /no supervisor/);
  assert.deepEqual(await l.status("u"), { state: "missing", pid: null });
  const bogus = await selectDriver({ env: { SOVA_PROJECT_DRIVER: "runit" }, platform: "linux", exec: systemctl(true).exec });
  assert.equal(bogus.id, "none");
  assert.equal(bogus.driver, null);
  assert.match(bogus.why, /names no adapter \(systemd, detached, launchd\)/);
});

test("unforced: systemd when its user manager answers", async () => {
  const sd = systemctl(true);
  const s = await selectDriver({ env: {}, platform: "linux", exec: sd.exec });
  assert.equal(s.id, "systemd");
  assert.equal(s.why, "the systemd user manager answers");
  assert.deepEqual(sd.calls, [["systemctl", "--user", "show", "--property=Version"]]);
});

test("unforced: the portable detached driver when systemd is absent, unreachable, or switched off for a test", async () => {
  const down = systemctl(false);
  const noBus = await selectDriver({ env: {}, platform: "linux", exec: down.exec });
  assert.equal(noBus.id, "detached");
  assert.match(noBus.why, /no systemd user manager reachable: Failed to connect to bus/);
  const mac = systemctl(true);
  const darwin = await selectDriver({ env: {}, platform: "darwin", exec: mac.exec });
  assert.equal(darwin.id, "detached");
  assert.equal(darwin.why, "no systemd on darwin");
  assert.equal(mac.calls.length, 0, "no systemctl off Linux");
  const off = systemctl(true);
  const sim = await selectDriver({ env: { SOVA_PROJECT_NO_SYSTEMD: "1" }, platform: "linux", exec: off.exec });
  assert.equal(sim.id, "detached");
  assert.equal(sim.why, "systemd treated as absent (SOVA_PROJECT_NO_SYSTEMD=1)");
  assert.equal(off.calls.length, 0, "the switch skips the probe: systemd itself is never touched");
});

test("the selected driver says which adapter and why, and passes verbs through", async () => {
  // The detached adapter as a driver in memory (fake-host.ts): the verbs pass through, no process starts.
  const fake = new FakeHost().driver;
  fake.detail = "detached sessions, processes read from /proc";
  const d = new SelectedDriver({ env: { SOVA_PROJECT_NO_SYSTEMD: "1" }, platform: "linux", detached: () => fake });
  assert.equal(d.id, "none", "before the choice is made");
  assert.deepEqual(d.pids("x"), []);
  const a = await d.available();
  assert.equal(d.id, "detached");
  assert.equal(a.ok, true);
  assert.match(a.detail, /^detached sessions, processes read from .+; chosen because systemd treated as absent \(SOVA_PROJECT_NO_SYSTEMD=1\)$/);
  const unit = `sova-svc-sel-${process.pid}-a`;
  await d.start({ unit, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } });
  const st = await d.status(unit);
  assert.equal(st.state, "active");
  assert.ok(d.owns(unit, st.pid!));
  assert.deepEqual(fake.running(), [unit], "the start reached the detached adapter");
  await d.stop(unit);
  assert.equal((await d.status(unit)).state, "missing");
});
