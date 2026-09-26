// Run: pnpm exec tsx --test server/mesh/details-collect.test.ts
// The per-OS readers against a fake machine: files, directories and commands are what each test says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { activityNow, browserAccessOf, fixedFacts, openOf } from "./details";
import {
  BatteryReader,
  buildCommit,
  ClaudeFinder,
  deviceType,
  linuxBattery,
  loadAverages,
  type Machine,
  modelName,
  onPath,
  parsePmset,
  parseTermuxBattery,
  TERMUX_BATTERY_TIMEOUT_MS,
} from "./details-collect";

function machine(platform: string, files: Record<string, string> = {}, commands: Record<string, string | null> = {}): Machine & { runs: Array<{ cmd: string; timeoutMs: number }>; clock: number } {
  const m = {
    platform,
    runs: [] as Array<{ cmd: string; timeoutMs: number }>,
    clock: 1_000_000,
    read: (p: string) => files[p] ?? null,
    list: (dir: string) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split("/")[0]!))],
    run: async (cmd: string, args: string[], timeoutMs: number) => {
      m.runs.push({ cmd: [cmd, ...args].join(" "), timeoutMs });
      return commands[[cmd, ...args].join(" ")] ?? null;
    },
    now: () => m.clock,
  };
  return m;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

describe("battery", () => {
  test("termux-battery-status: percent, and charging from status or a plug", () => {
    assert.deepEqual(parseTermuxBattery('{"percentage":81,"status":"CHARGING","plugged":"PLUGGED_USB"}'), { percent: 81, charging: true });
    assert.deepEqual(parseTermuxBattery('{"percentage":40,"status":"DISCHARGING","plugged":"UNPLUGGED"}'), { percent: 40, charging: false });
    assert.deepEqual(parseTermuxBattery('{"percentage":100,"status":"FULL","plugged":"PLUGGED_AC"}'), { percent: 100, charging: true });
    assert.equal(parseTermuxBattery("not json"), null);
    assert.equal(parseTermuxBattery('{"status":"CHARGING"}'), null);
  });

  test("pmset: a laptop's reading, and none on a desktop Mac", () => {
    assert.deepEqual(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t72%; discharging; 4:10 remaining present: true"), { percent: 72, charging: false });
    assert.deepEqual(parsePmset(" -InternalBattery-0 (id=1)\t95%; charging; 0:20 remaining present: true"), { percent: 95, charging: true });
    assert.deepEqual(parsePmset(" -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true"), { percent: 100, charging: true });
    assert.equal(parsePmset("Now drawing from 'AC Power'"), null);
  });

  test("linux: the laptop battery, never a peripheral's", () => {
    const m = machine("linux", {
      "/sys/class/power_supply/AC0/type": "Mains\n",
      "/sys/class/power_supply/hid-pen-battery/type": "Battery\n",
      "/sys/class/power_supply/hid-pen-battery/scope": "Device\n",
      "/sys/class/power_supply/hid-pen-battery/capacity": "5\n",
      "/sys/class/power_supply/BAT0/type": "Battery\n",
      "/sys/class/power_supply/BAT0/capacity": "57\n",
      "/sys/class/power_supply/BAT0/status": "Discharging\n",
    });
    assert.deepEqual(linuxBattery(m), { percent: 57, charging: false });
    assert.equal(linuxBattery(machine("linux", { "/sys/class/power_supply/AC0/type": "Mains\n" })), null);
  });

  test("Termux: a short timeout, a hint when Termux:API doesn't answer, retried minutes later, cached between", async () => {
    const m = machine("android");
    const r = new BatteryReader(m);
    assert.deepEqual(await r.read(), {}, "a request never waits for Termux:API");
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(await r.read(), { batteryHint: "termux-api" });
    assert.deepEqual(m.runs, [{ cmd: "termux-battery-status", timeoutMs: TERMUX_BATTERY_TIMEOUT_MS }]);
    assert.ok(TERMUX_BATTERY_TIMEOUT_MS <= 3000);
    m.clock += 60_000;
    await r.read();
    assert.equal(m.runs.length, 1, "a missing app is not asked again at every poll");
    m.clock += 5 * 60_000;
    await r.read(); // served stale while the retry runs
    await new Promise((res) => setImmediate(res));
    assert.equal(m.runs.length, 2);
  });

  test("a working reading is cached for a minute", async () => {
    const m = machine("android", {}, { "termux-battery-status": '{"percentage":50,"status":"DISCHARGING","plugged":"UNPLUGGED"}' });
    const r = new BatteryReader(m);
    assert.deepEqual(await r.read(true), { battery: { percent: 50, charging: false } });
    m.clock += 30_000;
    await r.read();
    assert.equal(m.runs.length, 1);
    m.clock += 31_000;
    await r.read();
    await new Promise((res) => setImmediate(res));
    assert.equal(m.runs.length, 2);
  });

  test("no command runs on Linux: sysfs only", async () => {
    const m = machine("linux");
    assert.deepEqual(await new BatteryReader(m).read(true), {});
    assert.deepEqual(m.runs, []);
  });
});

describe("identity", () => {
  test("device type per OS", () => {
    assert.equal(deviceType(machine("android"), false), "phone");
    assert.equal(deviceType(machine("darwin"), true), "laptop");
    assert.equal(deviceType(machine("darwin"), false), "desktop");
    assert.equal(deviceType(machine("linux", { "/sys/class/dmi/id/chassis_type": "10\n" }), false), "laptop");
    assert.equal(deviceType(machine("linux", { "/sys/class/dmi/id/chassis_type": "3\n" }), false), "desktop");
    assert.equal(deviceType(machine("linux", { "/sys/class/dmi/id/chassis_type": "23\n" }), false), "server");
    assert.equal(deviceType(machine("linux", { "/sys/class/dmi/id/chassis_type": "1\n", "/proc/cpuinfo": "processor\t: 0\nflags\t\t: fpu vme hypervisor lahf_lm\n" }), false), "server");
    assert.equal(deviceType(machine("linux", { "/sys/class/dmi/id/chassis_type": "1\n" }), true), "laptop");
    assert.equal(deviceType(machine("linux"), false), "unknown");
  });

  test("a Linux laptop whose firmware names no chassis is a laptop by its battery, from the first answer", async () => {
    const bat = { "/sys/class/power_supply/BAT0/type": "Battery\n", "/sys/class/power_supply/BAT0/capacity": "57\n" };
    const laptop = machine("linux", bat);
    assert.equal((await fixedFacts(laptop, new BatteryReader(laptop))).device, "laptop");
    const box = machine("linux");
    assert.equal((await fixedFacts(box, new BatteryReader(box))).device, "unknown");
  });

  test("a phone's device type never waits on Termux:API", async () => {
    const phone = machine("android");
    let settled = false;
    const run = phone.run;
    phone.run = (cmd, args, ms) => (cmd === "termux-battery-status" ? new Promise(() => {}) : run(cmd, args, ms));
    const facts = fixedFacts(phone, new BatteryReader(phone)).then((f) => ((settled = true), f));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(settled);
    assert.equal((await facts).device, "phone");
  });

  test("model: maker + model once, placeholders dropped", async () => {
    assert.equal(await modelName(machine("android", {}, { "getprop ro.product.manufacturer": "samsung\n", "getprop ro.product.model": "SM-F900\n" })), "Samsung SM-F900");
    assert.equal(await modelName(machine("linux", { "/sys/class/dmi/id/sys_vendor": "Acme Inc.\n", "/sys/class/dmi/id/product_name": "Acme Book 14\n" })), "Acme Book 14");
    assert.equal(await modelName(machine("linux", { "/sys/class/dmi/id/sys_vendor": "Acme\n", "/sys/class/dmi/id/product_name": "Book 14\n" })), "Acme Book 14");
    assert.equal(await modelName(machine("linux", { "/sys/class/dmi/id/product_name": "To Be Filled By O.E.M.\n" })), undefined);
    assert.equal(await modelName(machine("darwin", {}, { "sysctl -n hw.model": "Mac14,2\n" })), "Mac14,2");
  });

  test("commit: BUILD_COMMIT first, then HEAD through a worktree's .git file and packed refs", () => {
    assert.equal(buildCommit(machine("linux", { "/app/BUILD_COMMIT": JSON.stringify({ commit: SHA }) }), "/app"), SHA);
    assert.equal(buildCommit(machine("linux", { "/r/.git/HEAD": `${SHA}\n` }), "/r"), SHA, "a detached HEAD");
    assert.equal(buildCommit(machine("linux", { "/r/.git/HEAD": "ref: refs/heads/main\n", "/r/.git/refs/heads/main": `${SHA}\n` }), "/r"), SHA);
    const worktree = {
      "/w/.git": "gitdir: /r/.git/worktrees/w\n",
      "/r/.git/worktrees/w/HEAD": "ref: refs/heads/topic\n",
      "/r/.git/worktrees/w/commondir": "../..\n",
      "/r/.git/packed-refs": `# pack-refs\n${SHA} refs/heads/main\n${SHA2} refs/heads/topic\n`,
    };
    assert.equal(buildCommit(machine("linux", worktree), "/w"), SHA2);
    assert.equal(buildCommit(machine("linux", { "/app/BUILD_COMMIT": "{}" }), "/app"), undefined);
    assert.equal(buildCommit(machine("linux"), "/nothing"), undefined);
  });

  test("load: /proc/loadavg on Linux; absent where Android hides it", () => {
    assert.deepEqual(loadAverages(machine("linux", { "/proc/loadavg": "0.50 0.25 0.10 1/200 999\n" })), [0.5, 0.25, 0.1]);
    assert.equal(loadAverages(machine("android")), undefined);
  });
});

describe("activity and open", () => {
  test("turns and workers from fresh live records only; one file claimed twice counts once", () => {
    const now = 10_000_000;
    const rec = (file: string | null, state: string, working: number, heartbeat = now) => ({
      sessionFile: file,
      pid: 1,
      rec: { heartbeat, presence: { activity: { state, since: 0 }, workerCounts: { working, total: working } } },
    });
    assert.deepEqual(
      activityNow([rec("/a", "working", 2), rec("/a", "working", 3), rec("/b", "idle", 1), rec("/c", "working", 5, now - 60_000), rec(null, "working", 0)], now),
      { turnsRunning: 2, workers: 4 },
    );
  });

  test("open: its own address, the default serve port, or through this host for a phone", () => {
    assert.deepEqual(openOf({ serveUrl: "https://b.example:10443", dnsName: "b.example" }, undefined, false), { kind: "direct", url: "https://b.example:10443" });
    assert.deepEqual(openOf({ dnsName: "b.example" }, undefined, false), { kind: "direct", url: "https://b.example:8443" });
    assert.deepEqual(openOf({ dnsName: "b.example" }, undefined, true), { kind: "through" }, "left out of the front door, no details: no address of its own");
    const phone = { identity: { device: "phone" } } as Parameters<typeof openOf>[1];
    assert.deepEqual(openOf({ dnsName: "b.example" }, phone, false), { kind: "through" });
    assert.deepEqual(openOf(null, undefined, false), { kind: "through" });
  });

  test("Browser access: what the host says wins, over its device and its own address; an older phone has none", () => {
    const d = (device: string, browserAccess?: boolean) => ({ identity: { device }, ...(browserAccess !== undefined ? { browserAccess } : {}) }) as unknown as Parameters<typeof openOf>[1];
    assert.equal(browserAccessOf(d("phone"), undefined), false, "an older phone");
    assert.equal(browserAccessOf(d("laptop"), undefined), true, "an older computer");
    assert.equal(browserAccessOf(d("phone", true), undefined), true);
    assert.equal(browserAccessOf(d("server", false), undefined), false);
    assert.equal(browserAccessOf(undefined, false), false, "no details: what it last said");
    assert.equal(browserAccessOf(undefined, undefined), true);
    assert.deepEqual(openOf({ dnsName: "b.example" }, d("phone", true), false), { kind: "direct", url: "https://b.example:8443" });
    assert.deepEqual(openOf({ serveUrl: "https://b.example:10443", dnsName: "b.example" }, d("server", false), false, false), { kind: "through" });
  });
});

describe("Claude Code on the PATH", () => {
  test("onPath finds an executable file only, in absolute PATH entries, and runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sova-claude-path-"));
    try {
      const bin = join(dir, "bin");
      const plain = join(dir, "plain");
      mkdirSync(bin);
      mkdirSync(plain);
      mkdirSync(join(dir, "asdir", "claude"), { recursive: true });
      // A script that would leave a mark if it ran.
      writeFileSync(join(bin, "claude"), `#!/bin/sh\ntouch ${join(dir, "ran")}\n`);
      chmodSync(join(bin, "claude"), 0o755);
      writeFileSync(join(plain, "claude"), "not executable");
      chmodSync(join(plain, "claude"), 0o644);
      assert.equal(await onPath("claude", [plain, join(dir, "asdir"), "relative/bin", bin].join(delimiter)), true);
      assert.equal(await onPath("claude", [plain, join(dir, "asdir")].join(delimiter)), false, "not executable, or a directory");
      assert.equal(await onPath("claude", ""), false);
      assert.equal(await onPath("claude", `relative${delimiter}${join(dir, "missing")}`), false);
      assert.throws(() => rmSync(join(dir, "ran")), "the file was never run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ClaudeFinder never waits: nothing before the first lookup lands, then the cached answer for a minute", async () => {
    let clock = 1_000_000;
    let lookups = 0;
    let answer = true;
    let release!: () => void;
    const gate = () => new Promise<void>((r) => (release = r));
    let gated = gate();
    const finder = new ClaudeFinder(
      () => clock,
      async () => {
        lookups++;
        await gated;
        return answer;
      },
    );
    assert.equal(finder.read(), undefined, "the first read doesn't wait for the lookup");
    assert.equal(finder.read(), undefined);
    assert.equal(lookups, 1, "one lookup at a time");
    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(finder.read(), "found");
    clock += 59_000;
    answer = false;
    assert.equal(finder.read(), "found");
    assert.equal(lookups, 1, "cached");
    clock += 2_000;
    gated = gate();
    assert.equal(finder.read(), "found", "a stale answer is served while the next lookup runs");
    assert.equal(lookups, 2);
    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(finder.read(), "not-found");
    const failing = new ClaudeFinder(() => clock, async () => {
      throw new Error("EACCES");
    });
    failing.read();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(failing.read(), "not-found", "a failed lookup is not found, never a crash");
  });
});
