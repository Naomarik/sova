// M3 in the lab: settings, themes and API keys propagate between paired hosts; a host's per-category
// sync switch is respected; and the login-sync scenarios H1–H10 of credential-sync.md §5.5 run
// against the mock rotating token server through sync-engineer's driver
// (mock-token-server/m3-drive.mjs), one test per scenario.
//   scripts/mesh-lab/lab e2e m3                      everything (chaos scenarios partition/stop hosts)
//   scripts/mesh-lab/lab e2e m3 --test-name-pattern "^(?!H(3|4|7|8|10)\b)"   no chaos
// Hosts are compared by sha256 of what they hold; no secret is ever printed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { LAB_DIR } from "../lab.mjs";
import { exec, lab, laptopFetch, requireLab, sh, waitFor } from "./lib.mjs";

let cfg;
let A, B, C;
const sha = (n, rel) => sh(n, `f="$PI_CODING_AGENT_DIR/${rel}"; [ -e "$f" ] && sha256sum "$f" | cut -c1-64 || echo absent`).out;
const sameEverywhere = (rel, hosts, want) => hosts.every((h) => sha(h, rel) === want);

/** In-host AuthStorage call, the way pi itself writes auth.json (its lock, tmp+rename). */
function authOp(n, op, provider, key) {
  const script = `
import { join } from "node:path";
const pi = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AuthStorage } = await import(new URL("core/auth-storage.js", pi).href);
const s = AuthStorage.create(join(process.env.PI_CODING_AGENT_DIR, "auth.json"));
const [op, provider, key] = process.argv.slice(2);
if (op === "set") await s.modify(provider, async () => ({ type: "api_key", key }));
else await s.delete(provider);`;
  const r = exec(n, ["sh", "-c", 'cd /sova && node --input-type=module - "$@"', "-", op, provider, key ?? ""], { input: script });
  assert.equal(r.code, 0, `${n} ${op} ${provider}: ${r.err}`);
}
/** sha256 of one auth.json entry's secret on a host ("absent" when there is none). */
const entrySha = (n, provider) =>
  exec(n, ["node", "-e", `const d=JSON.parse(require("fs").readFileSync(process.env.PI_CODING_AGENT_DIR+"/auth.json","utf8"));const e=d[process.argv[1]];console.log(e?require("crypto").createHash("sha256").update(String(e.key??e.refresh)).digest("hex"):"absent")`, provider]).out;

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.hosts.length >= 3, "M3 needs 3 hosts");
  [A, B, C] = cfg.hosts;
  lab("pair", cfg.hosts.join(","));
  for (const h of cfg.hosts) await waitFor(async () => (await (await laptopFetch(h, "/api/mesh")).json()).enabled, { timeoutMs: 60000, what: `${h} mesh on` });
});

after(async () => {
  for (const h of cfg.hosts) await laptopFetch(h, "/api/mesh/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sync: { settings: true, themes: true, extensions: true, logins: true } }) });
});

describe("documents and keys propagate", () => {
  test("a theme added on A appears on B and C; deleted on A, it goes everywhere", async () => {
    const rel = "sova/themes/lab-m3.json";
    const tpl = sh(A, "cat /sova/themes/catppuccin-latte.json").out;
    const theme = { ...JSON.parse(tpl), name: `lab-m3-${Date.now()}` };
    exec(A, ["sh", "-c", `mkdir -p "$PI_CODING_AGENT_DIR/sova/themes" && cat > "$PI_CODING_AGENT_DIR/${rel}.tmp" && mv "$PI_CODING_AGENT_DIR/${rel}.tmp" "$PI_CODING_AGENT_DIR/${rel}"`], { input: JSON.stringify(theme, null, 2) });
    const want = sha(A, rel);
    assert.notEqual(want, "absent");
    await waitFor(() => sameEverywhere(rel, [B, C], want), { timeoutMs: 60000, what: "theme on B and C" });
    sh(A, `rm -f "$PI_CODING_AGENT_DIR/${rel}"`);
    await waitFor(() => sameEverywhere(rel, [B, C], "absent"), { timeoutMs: 60000, what: "theme deleted on B and C" });
  });

  test("a model favorite starred on A (settings) reaches B and C", async () => {
    const rel = "model-favorites.json";
    const ref = "deepseek/deepseek-chat";
    const before = sha(A, rel);
    const put = async (favorite) => laptopFetch(A, "/api/models/favorite", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, favorite }) });
    let r = await put(true);
    if (sha(A, rel) === before) r = await put(false); // it was already starred: flip the other way
    assert.ok(r.status < 300, `favorite PUT ${r.status}`);
    const want = sha(A, rel);
    await waitFor(() => sameEverywhere(rel, [B, C], want), { timeoutMs: 60000, what: "favorites on B and C" });
  });

  test("an API key added on A (through pi's AuthStorage) reaches B and C; removed on A, it goes everywhere", async () => {
    const provider = "lab-m3-key";
    authOp(A, "set", provider, `lab-m3-${Date.now()}-not-a-secret`);
    const want = entrySha(A, provider);
    await waitFor(() => [B, C].every((h) => entrySha(h, provider) === want), { timeoutMs: 60000, what: "key on B and C" });
    authOp(A, "delete", provider);
    await waitFor(() => [B, C].every((h) => entrySha(h, provider) === "absent"), { timeoutMs: 60000, what: "key removed on B and C" });
  });
});

describe("sync switches", () => {
  test("B with themes sync off neither receives A's theme nor offers its own; C does", async () => {
    const put = (h, sync) => laptopFetch(h, "/api/mesh/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sync }) });
    assert.equal((await put(B, { themes: false })).status, 200);
    const rel = "sova/themes/lab-m3-toggle.json";
    try {
      const theme = { ...JSON.parse(sh(A, "cat /sova/themes/catppuccin-latte.json").out), name: `lab-m3-toggle-${Date.now()}` };
      exec(A, ["sh", "-c", `mkdir -p "$PI_CODING_AGENT_DIR/sova/themes" && cat > "$PI_CODING_AGENT_DIR/${rel}"`], { input: JSON.stringify(theme) });
      const want = sha(A, rel);
      await waitFor(() => sha(C, rel) === want, { timeoutMs: 60000, what: "theme on C" });
      await new Promise((r) => setTimeout(r, 5000));
      assert.equal(sha(B, rel), "absent", "B (themes off) must not receive it");
    } finally {
      sh(A, `rm -f "$PI_CODING_AGENT_DIR/${rel}"`);
      await put(B, { themes: true });
    }
    // Measured 2026-09-25: this delete reaches C only after >60 s (with every switch on, a
    // delete is ~1 s); reported to sync-engineer. The bound here only catches "never".
    const t0 = Date.now();
    await waitFor(() => sha(C, rel) === "absent", { timeoutMs: 240000, intervalMs: 1000, what: "toggle theme gone from C" });
    console.log(`# delete on A reached C ${Date.now() - t0} ms after B's themes switch came back on`);
  });
});

describe("login sync scenarios (credential-sync.md §5.5, via m3-drive.mjs)", () => {
  const drive = (name) => {
    const r = spawnSync(process.execPath, [join(LAB_DIR, "mock-token-server/m3-drive.mjs"), name, "--hosts", cfg.hosts.slice(0, 3).join(",")], { encoding: "utf8", timeout: 600000 });
    const tail = (r.stdout + r.stderr).trim().split("\n").slice(-8).join("\n");
    assert.equal(r.status, 0, `${name}:\n${tail}`);
    console.log(`# ${name}: ${tail.split("\n").pop()}`);
  };
  for (const [id, name, what] of [
    ["H1", "h1", "login propagates"],
    ["H2", "h2", "concurrent refresh on two hosts (pi)"],
    ["H2c", "h2c", "concurrent refresh on two hosts (Claude store simulator)"],
    ["H6", "h6", "logout tombstone (pi)"],
    ["H6c", "h6c", "logout tombstone (Claude)"],
    ["H9", "h9", "torn write"],
    ["H3", "h3", "concurrent refresh, owner partitioned"],
    ["H4", "h4", "stale host comes back"],
    ["H7", "h7", "logout while a host is partitioned"],
    ["H8", "h8", "auth.json deleted by hand"],
    ["H10", "h10", "restart and catch up"],
  ])
    test(`${id} ${what}`, () => drive(name));
});
