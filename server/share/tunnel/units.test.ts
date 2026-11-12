import assert from "node:assert/strict";
import { test } from "node:test";
import { systemdRunArgv } from "../../project-services/drivers";
import { cloudflaredArgv, exitReason, FORBIDDEN_TARGETS, keyOfRecordId, maskSecrets, parseExitLine, plainPath, recordIdOf, tunnelUnitOf, unitProperties } from "./units";

const TOKEN = "eyJhIjoi" + "x".repeat(60);
const base = { cloudflared: "/usr/bin/cloudflared", targetPort: 4802, metricsPort: 41873, pidfile: "/s/tunnels/u.pid" };

test("cloudflared's argv: updater off in every mode, Free forwards to loopback, Account runs from its env token", () => {
  for (const mode of ["quick", "account"] as const) {
    const argv = cloudflaredArgv({ ...base, mode });
    assert.ok(argv.includes("--no-autoupdate"), mode);
    assert.deepEqual(argv.slice(argv.indexOf("--metrics"), argv.indexOf("--metrics") + 2), ["--metrics", "127.0.0.1:41873"]);
    assert.ok(argv.includes("--pidfile"));
    assert.ok(!argv.some((a) => a.includes("token") || a.startsWith("eyJ")), "no token in argv");
  }
  assert.deepEqual(cloudflaredArgv({ ...base, mode: "quick" }).slice(-2), ["--url", "http://127.0.0.1:4802"]);
  assert.equal(cloudflaredArgv({ ...base, mode: "account" }).at(-1), "run");
  for (const port of FORBIDDEN_TARGETS) assert.throws(() => cloudflaredArgv({ ...base, mode: "quick", targetPort: port }));
});

test("the unit: a Free tunnel is never restarted by systemd, an Account one is; the stop hook runs on every end; the token stays out of systemd-run's argv", () => {
  const hook = "/home/u/.pi/agent/sova/tunnels/hook.sh";
  for (const mode of ["quick", "account"] as const) {
    const unit = tunnelUnitOf({ kind: "share" }, "abc123");
    const argv = systemdRunArgv(
      { unit, argv: cloudflaredArgv({ ...base, mode }), cwd: "/s/tunnels", env: { PATH: "/usr/bin", ...(mode === "account" ? { TUNNEL_TOKEN: TOKEN } : {}) } },
      undefined,
      { slice: "sova-tunnels.slice", restart: false, envFile: (u) => `/s/tunnels/env/${u}.env`, properties: (u) => unitProperties(mode, u, hook) },
    );
    assert.ok(argv.includes(`--property=ExecStopPost=${hook} exited ${unit}`), mode);
    assert.ok(argv.includes("--slice=sova-tunnels.slice"));
    assert.equal(argv.includes("--property=Restart=always"), mode === "account", mode);
    assert.ok(!argv.includes("--property=Restart=on-failure"), "systemd's on-failure restart never applies");
    assert.ok(!argv.join(" ").includes(TOKEN), "token only in the env file");
  }
  assert.throws(() => unitProperties("quick", "u", "/home/a b/hook.sh"), /can't be given to systemd/);
  for (const bad of ["/a b", "/a%b", "/a$b", "/a\"b", "/a\\b", "rel/hook.sh"]) assert.equal(plainPath(bad), false, bad);
});

test("unit names and record ids: the state root's prefix, one per kind, and back", () => {
  assert.equal(tunnelUnitOf({ kind: "share" }, "abc123"), "sova-tunnel-abc123-share");
  assert.equal(tunnelUnitOf({ kind: "preview", port: 5173 }, "abc123"), "sova-tunnel-abc123-pv5173");
  for (const key of [{ kind: "share" as const }, { kind: "preview" as const, port: 5173 }]) assert.deepEqual(keyOfRecordId(recordIdOf(key)), key);
  for (const bad of ["preview:0", "preview:70000", "preview:x", "shares", ""]) assert.equal(keyOfRecordId(bad), null, bad);
});

test("the hook's end line: systemd's result, the wrapper's, an empty status; anything else is no line", () => {
  assert.deepEqual(parseExitLine("success exited 0 1794000000\n"), { result: "success", code: "exited", status: "0", at: 1794000000000 });
  assert.deepEqual(parseExitLine("signal killed 9 1794000000"), { result: "signal", code: "killed", status: "9", at: 1794000000000 });
  assert.deepEqual(parseExitLine("unknown unknown  1794000000"), { result: "unknown", code: "unknown", status: "", at: 1794000000000 });
  for (const bad of ["", "success exited 0", "success exited 0 x", "a b c d e"]) assert.equal(parseExitLine(bad), null, bad);
  assert.match(exitReason(parseExitLine("oom-kill killed 9 1")!), /memory/);
  assert.match(exitReason(parseExitLine("exit-code exited 1 1")!), /exit 1/);
});

test("log lines never carry a connector token", () => {
  const out = maskSecrets([`TUNNEL_TOKEN=${TOKEN}`, `token ${TOKEN} here`, `--token ${TOKEN}`, "plain line"]).join("\n");
  assert.ok(!out.includes(TOKEN.slice(0, 30)));
  assert.match(out, /plain line/);
});

test("an Account candidate is never restarted by systemd (Sova's hourly budget applies), and is named apart", () => {
  const unit = tunnelUnitOf({ kind: "candidate" }, "abc123");
  assert.equal(unit, "sova-tunnel-abc123-candidate");
  assert.deepEqual(keyOfRecordId(recordIdOf({ kind: "candidate" })), { kind: "candidate" });
  const props = unitProperties("account", unit, "/s/tunnels/hook.sh");
  assert.ok(!props.some((p) => p.startsWith("Restart=")));
  assert.ok(props.includes(`ExecStopPost=/s/tunnels/hook.sh exited ${unit}`));
});
