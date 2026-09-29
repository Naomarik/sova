// Run: npx tsx --test server/resource-monitor-proc.test.ts
// Pure parsers and argv classification (§app/resource-monitor); no I/O.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyArgv, parseBootTime, parseCmdline, parseEnviron, parseKeyValues, parseLoadavg, parseMeminfo, parsePressure,
  parseSelfCgroup, parseStat, parseStatusSwap, pressureOf,
} from "./resource-monitor-proc";

/** A stat line with fields 3.. as given (field 3 = state). */
const statLine = (pid: number, comm: string, o: Partial<Record<"ppid" | "pgid" | "sid" | "utime" | "stime" | "cutime" | "cstime" | "starttime" | "rss", number>> = {}) => {
  const f = Array.from({ length: 50 }, () => "0");
  f[0] = "S";
  const set = (field: number, v: number | undefined) => { if (v !== undefined) f[field - 3] = String(v); };
  set(4, o.ppid); set(5, o.pgid); set(6, o.sid); set(14, o.utime); set(15, o.stime); set(16, o.cutime); set(17, o.cstime);
  set(22, o.starttime); set(24, o.rss);
  return `${pid} (${comm}) ${f.join(" ")}\n`;
};

describe("parseStat", () => {
  test("reads the fields after the LAST paren, so a comm with spaces and parens parses", () => {
    const s = parseStat(statLine(42, "a (weird) ) name", { ppid: 7, pgid: 8, sid: 9, utime: 10, stime: 11, cutime: 12, cstime: 13, starttime: 999, rss: 321 }))!;
    assert.equal(s.pid, 42);
    assert.equal(s.comm, "a (weird) ) name");
    assert.deepEqual([s.ppid, s.pgid, s.sid, s.utime, s.stime, s.cutime, s.cstime, s.starttime, s.rss], [7, 8, 9, 10, 11, 12, 13, 999, 321]);
    assert.equal(s.state, "S");
  });
  test("a real kernel line", () => {
    const real = "3283333 (node) S 1511 3283333 3283333 0 -1 4194560 64335196 2147137 30 1 874233 177377 102033 43119 20 0 11 0 118745391 1995730944 105217 18446744073709551615 1 1 0 0 0 0 0 16781312 17610 0 0 0 17 21 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
    const s = parseStat(real)!;
    assert.deepEqual([s.ppid, s.sid, s.utime, s.stime, s.cutime, s.cstime, s.starttime, s.rss], [1511, 3283333, 874233, 177377, 102033, 43119, 118745391, 105217]);
  });
  test("malformed input is null, never a half-filled record", () => {
    for (const bad of ["", "12 no-parens S 1 2 3", "12 (x) S 1 2", "x (y) " + "0 ".repeat(40)]) assert.equal(parseStat(bad), null, bad);
  });
});

test("VmSwap from status, 0 when absent", () => {
  assert.equal(parseStatusSwap("Name:\tnode\nVmRSS:\t  1000 kB\nVmSwap:\t   256 kB\n"), 256 * 1024);
  assert.equal(parseStatusSwap("Name:\tkthreadd\n"), 0);
});

test("cgroup key/value files, meminfo, loadavg, boot time", () => {
  const ms = parseKeyValues("anon 9980000000\nfile 7300000000\nshmem 730000000\n");
  assert.equal(ms.get("anon"), 9_980_000_000);
  assert.equal(ms.get("file"), 7_300_000_000);
  const mi = parseMeminfo("MemTotal:       65000000 kB\nMemAvailable:   30000000 kB\nHugePages_Total:       0\n");
  assert.equal(mi.get("MemTotal"), 65_000_000 * 1024);
  assert.equal(mi.get("HugePages_Total"), 0);
  assert.deepEqual(parseLoadavg("23.10 12.50 8.01 3/1200 99999\n"), [23.1, 12.5, 8.01]);
  assert.equal(parseBootTime("cpu  1 2 3\nbtime 1790000000\nprocesses 5\n"), 1_790_000_000);
});

test("pressure: avg10 of some and full; missing files leave their part out", () => {
  const text = "some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=4.25 avg60=0 avg300=0 total=0\n";
  assert.deepEqual(parsePressure(text), { some: 12.5, full: 4.25 });
  assert.deepEqual(pressureOf("some avg10=1.00 avg60=0 avg300=0 total=0\n", text, null), {
    cpu: { some: 1 }, memory: { some: 12.5, full: 4.25 },
  });
  assert.equal(pressureOf(null, null, null), undefined);
});

test("self cgroup: a .service leaf is a unit, anything else is not", () => {
  assert.deepEqual(parseSelfCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/sova-runtime.service\n"), {
    path: "/user.slice/user-1000.slice/user@1000.service/app.slice/sova-runtime.service", unit: "sova-runtime.service",
  });
  // A terminal's scope (dev, hermetic): not dedicated, even under user@1000.service.
  assert.deepEqual(parseSelfCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux-1.scope\n"), {
    path: "/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux-1.scope",
  });
  assert.equal(parseSelfCgroup("1:name=systemd:/\n"), null);
});

test("environ: PI_SESSION_FILE and the team member's ids; nothing else is kept", () => {
  const env = parseEnviron([
    "HOME=/home/u", "PI_SESSION_FILE=/s/a.jsonl", "SECRET=x",
    'PI_SUBAGENTS_TEAM_MEMBER={"version":1,"teamId":"team_01","workerId":"ag_03","role":"x"}',
  ].join("\0") + "\0");
  assert.deepEqual(env, { sessionFile: "/s/a.jsonl", team: { teamId: "team_01", workerId: "ag_03" } });
  assert.deepEqual(parseEnviron("PI_SUBAGENTS_TEAM_MEMBER={broken\0PI_SESSION_FILE=\0"), {});
});

test("cmdline: NUL-separated argv, and a retitled process's padded title", () => {
  assert.deepEqual(parseCmdline("node\0server/index.ts\0"), ["node", "server/index.ts"]);
  assert.deepEqual(parseCmdline("pi" + " ".repeat(200)), ["pi"]);
  assert.deepEqual(parseCmdline(""), []);
});

describe("classifyArgv", () => {
  const c = (...argv: string[]) => classifyArgv(argv);
  test("pi worker (retitled)", () => assert.deepEqual(c("pi"), { kind: "pi-worker", cmd: "pi" }));
  test("claude: worker or provider by argv alone is 'claude-worker', with its session uuid", () => {
    const uuid = "0287676D-8cba-4b8c-81a0-cf8a90cdd413";
    const r = c("claude", "-p", "--input-format", "stream-json", "--resume", uuid, "--settings", "{}", "--model", "opus[1m]");
    assert.equal(r.kind, "claude-worker");
    assert.equal(r.claudeSession, uuid.toLowerCase());
    assert.equal(r.cmd, "claude -p --resume 0287676D --model opus[1m]");
    const fresh = c("claude", "-p", "--model", "haiku");
    assert.equal(fresh.claudeSession, undefined);
    assert.equal(c("claude", "-p", "--session-id", "not-a-uuid").claudeSession, undefined);
  });
  test("member-mcp helper", () => {
    assert.deepEqual(c("/usr/bin/node", "/home/u/sova/pi-config/extensions/subagents/member-mcp.ts"), { kind: "member-mcp", cmd: "node member-mcp.ts" });
  });
  test("node: interpreter flags skipped, tsx named, paths shortened", () => {
    assert.equal(c("/x/bin/node", "--import", "tsx", "server/index.ts").cmd, "node server/index.ts");
    assert.equal(c("node", "/wt/node_modules/.pnpm/tsx@4/node_modules/tsx/dist/cli.mjs", "server/index.ts").cmd, "node tsx server/index.ts");
    assert.deepEqual(c("node", "/wt/node_modules/typescript/bin/tsc", "--noEmit"), { kind: "build", cmd: "node tsc --noEmit" });
  });
  test("java: classpath and -D/-X noise collapse to `java … <main>`", () => {
    const r = c("/usr/lib/jvm/bin/java", "-XX:+UseG1GC", "-Dfoo=bar", "-cp", "/a.jar:/b.jar:" + "x".repeat(500), "clojure.main", "-m", "app.test");
    assert.deepEqual(r, { kind: "java", cmd: "java … clojure.main -m app.test" });
    assert.equal(c("java", "-jar", "/opt/app/server.jar").cmd, "java -jar server.jar");
  });
  test("browser by --type, shell by its command (Claude's eval wrapper unwrapped)", () => {
    assert.deepEqual(c("/c/chrome", "--type=renderer", "--lang=en"), { kind: "browser", cmd: "chrome --type=renderer" });
    const wrapped = c("/usr/bin/zsh", "-c", "source /h/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'pnpm run typecheck' < /dev/null && pwd -P");
    assert.deepEqual(wrapped, { kind: "shell", cmd: "zsh -c pnpm run typecheck" });
    assert.equal(c("bash", "-c", "sleep   30").cmd, "bash -c sleep 30");
  });
  test("python -m, and anything is cut to 120 chars", () => {
    assert.equal(c("/usr/bin/python3", "-m", "http.server", "4877").cmd, "python3 -m http.server 4877");
    const long = c("some-tool", ...Array.from({ length: 80 }, (_, i) => `arg${i}`));
    assert.equal(long.cmd.length, 120);
    assert.ok(long.cmd.endsWith("…"));
  });
  test("an empty argv (kernel thread, zombie) falls back to comm", () => {
    assert.deepEqual(classifyArgv([], "kworker/0:1"), { kind: "other", cmd: "[kworker/0:1]" });
  });
});
