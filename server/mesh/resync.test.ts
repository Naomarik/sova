// Run: pnpm test -- server/mesh/resync.test.ts
// Mesh version resync (§mesh.peers/resync), in-process: relation over an in-memory history (the
// questions relationOf asks git, answered as git would), recipe parsing, and the job service with
// every outside part injected: a fake mesh, a fake probe, a fake peer details endpoint and a fake
// deploy script (a child in-process). No network, no ssh, no real peer, no process. With a real
// checkout and the script as a real child: resync.integration.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ResyncJob } from "../../shared/mesh-resync";
import { derivedRecipes, localEnvs, mountResync, parseLocalEnv, parseRecipes, type Recipe, readRecipes, recipeArgv, recipeProblem, relationOf } from "./resync";
import { config, fakeScript, memoryHistory, PROTO, resyncKit, skewed, until, type World } from "./resync-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-resync-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const repo = join(tmp, "repo");
const history = memoryHistory(repo);
const { A, B, C, D, git } = history;
const MISSING = "f".repeat(40);

describe("relation", () => {
  test("behind, ahead, same, diverged and unknown, by the history git reports", async () => {
    assert.deepEqual(await relationOf(C, A, repo, git), { relation: "behind", distance: 2 });
    assert.deepEqual(await relationOf(A, C, repo, git), { relation: "ahead", distance: 2 });
    assert.deepEqual(await relationOf(B, B, repo, git), { relation: "same" });
    assert.deepEqual(await relationOf(C, D, repo, git), { relation: "diverged" });
    assert.deepEqual(await relationOf(C, MISSING, repo, git), { relation: "unknown" }, "a commit this checkout lacks");
    assert.deepEqual(await relationOf(C, undefined, repo, git), { relation: "unknown" }, "a peer that says no commit");
    assert.deepEqual(await relationOf(undefined, A, repo, git), { relation: "unknown" }, "no boot commit here");
  });

  test("only 40-hex commits reach git: an option-shaped commit is unknown, and git is never asked", async () => {
    const asked: string[][] = [];
    const spy = async (args: string[]) => {
      asked.push(args);
      return null;
    };
    assert.deepEqual(await relationOf(C, "--output=/tmp/x", repo, spy), { relation: "unknown" });
    assert.deepEqual(await relationOf(C, "HEAD", repo, spy), { relation: "unknown" });
    assert.deepEqual(asked, []);
  });
});

describe("recipes", () => {
  test("a vps and a termux recipe parse; the args are kept as given", () => {
    const { recipes, errors } = parseRecipes({
      hosts: { vps: { kind: "vps" }, phone: { kind: "termux", ssh: "u0_a1@phone", sshPort: 8022, args: ["--node-id", "n1", "--dns", "phone.example.ts.net"] } },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(recipes.get("vps"), { kind: "vps", args: [] });
    assert.deepEqual(recipes.get("phone"), { kind: "termux", args: ["--node-id", "n1", "--dns", "phone.example.ts.net"], ssh: "u0_a1@phone", sshPort: 8022 });
  });

  test("a bad entry is left out with its reason; the others stay", () => {
    const { recipes, errors } = parseRecipes({
      hosts: {
        ok: { kind: "vps" },
        shell: { kind: "shell", command: "rm -rf /" },
        rev: { kind: "vps", args: ["--rev", "HEAD"] },
        src: { kind: "termux", args: ["--source-url=https://x"] },
        ssh: { kind: "termux", ssh: "-oProxyCommand=evil" },
        vpsssh: { kind: "vps", ssh: "a@b" },
        nl: { kind: "termux", args: ["a\nb"] },
        "Not An Id": { kind: "vps" },
      },
    });
    assert.deepEqual([...recipes.keys()], ["ok"]);
    assert.equal(errors.length, 7);
    assert.ok(errors.some((e) => e.startsWith("rev:") && /--rev/.test(e)));
    assert.ok(errors.some((e) => e.startsWith("src:") && /--source-url/.test(e)));
    assert.ok(errors.some((e) => e.startsWith("ssh:")));
  });

  test("the file: missing is no recipe and no error; malformed is no recipe and says so", () => {
    const file = join(tmp, "mesh-resync.json");
    assert.deepEqual(readRecipes(file, new Map()), { recipes: new Map() });
    writeFileSync(file, "{ not json");
    assert.equal(readRecipes(file, new Map()).recipes.size, 0);
    assert.match(readRecipes(file, new Map()).error!, /valid JSON/);
    writeFileSync(file, JSON.stringify({ vps: { kind: "vps" } }));
    assert.match(readRecipes(file, new Map()).error!, /"hosts"/);
  });

  test("local.env: plain KEY=value lines, quotes dropped, comments and anything else skipped", () => {
    const env = parseLocalEnv(
      [
        "# the phone",
        "",
        "PHONE=100.64.0.3",
        'PHONE_ID="host-b"',
        "PHONE_LABEL='Host B'",
        "export VPS_ID=vps # trailing",
        "  PHONE_PORT = 8022",
        "echo $(rm -rf /)",
        "LAPTOP_IP=",
      ].join("\n"),
    );
    assert.deepEqual(Object.fromEntries(env), { PHONE: "100.64.0.3", PHONE_ID: "host-b", PHONE_LABEL: "Host B", VPS_ID: "vps", LAPTOP_IP: "" });
  });

  test("derived: VPS_ID is a vps recipe, PHONE_ID a termux one taking its ssh from local.env; nothing from a missing file or a bad id", () => {
    assert.deepEqual(
      derivedRecipes({ vps: "VPS_SSH=u@v\nVPS_ID=cloud\n", termux: "PHONE=100.64.0.3\nPHONE_ID=host-b\n" }),
      new Map([
        ["cloud", { kind: "vps", args: [] }],
        ["host-b", { kind: "termux", args: [] }],
      ]),
    );
    assert.deepEqual(derivedRecipes({ vps: null, termux: null }), new Map());
    assert.deepEqual(derivedRecipes({ vps: "VPS_SSH=u@v\n", termux: "PHONE_ID=Not An Id\n" }), new Map(), "no VPS_ID, and an id no peer can have");
    assert.deepEqual(localEnvs(join(tmp, "no-checkout")), { vps: null, termux: null }, "an unreadable local.env is no text");
  });

  test("the file and derived recipes: a missing file gives the derived; an entry the file names wins, even a bad one; a malformed file gives none", () => {
    const file = join(tmp, "mesh-resync-derived.json");
    const derived = derivedRecipes({ vps: "VPS_ID=vps\n", termux: "PHONE_ID=phone\n" });
    rmSync(file, { force: true });
    assert.deepEqual(readRecipes(file, derived), { recipes: derived });
    writeFileSync(file, JSON.stringify({ hosts: { phone: { kind: "termux", ssh: "u@p", args: ["--dns", "p.ts.net"] } } }));
    assert.deepEqual(readRecipes(file, derived), {
      recipes: new Map<string, Recipe>([
        ["phone", { kind: "termux", args: ["--dns", "p.ts.net"], ssh: "u@p" }],
        ["vps", { kind: "vps", args: [] }],
      ]),
    });
    writeFileSync(file, JSON.stringify({ hosts: { vps: { kind: "shell" } } }));
    const bad = readRecipes(file, derived);
    assert.deepEqual([...bad.recipes.keys()], ["phone"], "the bad vps entry is left out, not replaced by the derived one");
    assert.match(bad.error!, /^vps: kind/);
    writeFileSync(file, "{ not json");
    assert.deepEqual(readRecipes(file, derived), { recipes: new Map(), error: "mesh-resync.json isn't valid JSON" });
    writeFileSync(file, JSON.stringify({ vps: { kind: "vps" } }));
    const shape = readRecipes(file, derived);
    assert.equal(shape.recipes.size, 0);
    assert.match(shape.error!, /"hosts"/);
  });

  test("argv: the script, then the recipe's args, and the boot commit where nothing can override it", () => {
    assert.deepEqual(recipeArgv({ kind: "vps", args: ["--claude-bin", "/x/claude"] }, C, "/r"), ["/r/scripts/mesh-vps/deploy.sh", "--claude-bin", "/x/claude", "--rev", C]);
    assert.deepEqual(recipeArgv({ kind: "termux", args: ["--dns", "p.ts.net"], ssh: "u@p", sshPort: 8022 }, C, "/r"), [
      "/r/scripts/mesh-termux/deploy.sh",
      "--ssh",
      "u@p",
      "--ssh-port",
      "8022",
      "--rev",
      C,
      "--",
      "--dns",
      "p.ts.net",
    ]);
  });

  test("a recipe whose settings are missing says which", () => {
    const none = () => false;
    assert.match(recipeProblem({ kind: "vps", args: [] }, "/r", none)!, /mesh-vps\/local\.env/);
    assert.match(recipeProblem({ kind: "termux", args: [] }, "/r", none)!, /ssh/);
    assert.equal(recipeProblem({ kind: "termux", args: [], ssh: "u@p" }, "/r", none), undefined);
    assert.equal(recipeProblem({ kind: "vps", args: [] }, "/r", () => true), undefined);
  });
});

// ---- the service ------------------------------------------------------------------------------

const { world, service: kitService } = resyncKit(history, fakeScript);
const service = (w: ReturnType<typeof world>, logDir = join(tmp, "logs"), timeouts?: Parameters<typeof kitService>[2]) => kitService(w, logDir, timeouts);

const json = "application/json";

describe("the service", () => {
  test("info: each skewed host placed against this host's boot commit, with its recipe and activity", async () => {
    const w = world();
    const info = (await service(w).info())!;
    assert.deepEqual(info.self, { id: "desk", label: "Desk", commit: C });
    const by = Object.fromEntries(info.hosts.map((h) => [h.id, h]));
    assert.deepEqual(by.vps, { id: "vps", label: "VPS", state: "skewed", recipe: "vps", commit: A, activity: { turnsRunning: 1, workers: 2 }, relation: "behind", distance: 2 });
    assert.equal(by.phone!.commit, A, "the hello's commit wins over the details'");
    assert.equal(by.new!.relation, "diverged");
    assert.equal(by.new!.recipe, null);
    assert.deepEqual(by.gone, { id: "gone", label: "GONE", state: "down", recipe: null, relation: "unknown" });
  });

  test("info: a build that can't be named is said once, on self", async () => {
    const w = world({ build: { commit: C, protocol: PROTO, dirty: true, verified: true, blocked: "uncommitted changes" } });
    assert.equal((await service(w).info())!.self.blocked, "uncommitted changes");
    assert.match((await service(world({ build: null })).info())!.self.blocked!, /wasn't recorded/);
  });

  test("start: JSON only, a 40-hex commit, a known host", async () => {
    const s = service(world());
    assert.equal((await s.start("vps", { commit: C }, "text/plain")).status, 415);
    assert.equal((await s.start("vps", { commit: C }, undefined)).status, 415);
    assert.equal((await s.start("vps", { commit: "HEAD" }, json)).status, 400);
    assert.equal((await s.start("nobody", { commit: C }, json)).status, 404);
  });

  test("start: refused when the commit isn't this host's boot commit (the sheet was older than the server)", async () => {
    const w = world();
    const r = await service(w).start("vps", { commit: B }, json);
    assert.equal(r.status, 409);
    assert.match((r.body as { error: string }).error, new RegExp(`Desk runs ${C.slice(0, 12)}, not ${B.slice(0, 12)}`));
    assert.deepEqual(w.spawned, [], "nothing ran");
  });

  test("start: refused while this host's build can't be named", async () => {
    const w = world({ build: { commit: C, protocol: PROTO, dirty: true, verified: true, blocked: "This host booted with uncommitted changes" } });
    const r = await service(w).start("vps", { commit: C }, json);
    assert.equal(r.status, 409);
    assert.match((r.body as { error: string }).error, /uncommitted/);
    assert.deepEqual(w.spawned, []);
  });

  test("start: refused with no recipe, naming the host and this host", async () => {
    const w = world();
    w.details.new = { commit: A, turnsRunning: 0, workers: 0 };
    const r = await service(w).start("new", { commit: C }, json);
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, "No resync recipe for NEW on Desk: set VPS_ID in scripts/mesh-vps/local.env (or PHONE_ID in scripts/mesh-termux/local.env) to new, or add new to mesh-resync.json");
    assert.deepEqual(w.spawned, []);
  });

  test("start: never a downgrade, a branch jump, an unknown commit or a host that isn't skewed", async () => {
    const cases: Array<[Partial<World>, RegExp]> = [
      [{ details: { vps: { commit: MISSING, turnsRunning: 0, workers: 0 } } }, /isn't known/],
      [{ details: { vps: { commit: D, turnsRunning: 0, workers: 0 } } }, /another branch/],
      [{ build: { commit: A, protocol: PROTO, dirty: false, verified: true }, details: { vps: { commit: C, turnsRunning: 0, workers: 0 } } }, /newer build than Desk; update Desk instead/],
      [{ probes: { vps: { state: "up", hello: skewed().hello! } } }, /already runs/],
      [{ probes: { vps: { state: "down" } } }, /isn't answering/],
    ];
    for (const [over, why] of cases) {
      const w = world(over);
      const commit = w.build!.commit!;
      const r = await service(w).start("vps", { commit }, json);
      assert.equal(r.status, 409, String(why));
      assert.match((r.body as { error: string }).error, why);
      assert.deepEqual(w.spawned, []);
    }
  });

  test("a job: the script with the boot commit, its output teed to the log, then the peer's hello until it matches", async () => {
    const w = world();
    const logs = join(tmp, "logs-ok");
    const s = service(w, logs);
    const r = await s.start("vps", { commit: C }, json);
    assert.equal(r.status, 202);
    assert.equal((r.body as ResyncJob).state, "running");
    assert.deepEqual(w.spawned, [[join(repo, "scripts/mesh-vps/deploy.sh"), "--rev", C]]);
    await until(() => s.job("vps")!.state === "waiting");
    // the peer comes back on this host's protocol
    w.probes.vps = { state: "up", hello: { ...skewed().hello!, protocol: PROTO } };
    await until(() => s.job("vps")!.state === "done");
    const job = s.job("vps")!;
    assert.match(job.tail, /deploying/);
    assert.match(job.tail, /to stderr/);
    // The log is written through a stream: its last line lands just after the job reads done.
    const logFile = join(logs, "vps.log");
    await until(() => readFileSync(logFile, "utf8").includes("# done"));
    const log = readFileSync(logFile, "utf8");
    assert.match(log, new RegExp(`# resync vps to ${C}`));
    assert.match(log, /deploying/);
    assert.match(log, /# done/);
  });

  test("409 while a job runs for that host; another host may start", async () => {
    const w = world({ hang: true });
    const s = service(w);
    assert.equal((await s.start("vps", { commit: C }, json)).status, 202);
    const again = await s.start("vps", { commit: C }, json);
    assert.equal(again.status, 409);
    assert.match((again.body as { error: string }).error, /already running/);
    assert.equal((await s.start("phone", { commit: C }, json)).status, 202, "one job per host, not one in all");
    assert.equal(w.spawned.length, 2);
    s.dispose();
    assert.equal(s.job("vps")!.state, "failed");
    assert.match(s.job("vps")!.error!, /stopped the job/);
  });

  test("a script that fails, or never finishes, or a peer that doesn't come back, fails the job with the reason", async () => {
    const w1 = world({ exit: 3 });
    const s1 = service(w1);
    await s1.start("vps", { commit: C }, json);
    await until(() => s1.job("vps")!.state === "failed");
    assert.match(s1.job("vps")!.error!, /exit 3/);

    const w2 = world({ hang: true });
    // A script that never finishes meets the recipe's limit (shortened here; the reason is the check).
    const s2 = service(w2, undefined, { vps: 50 });
    await s2.start("vps", { commit: C }, json);
    await until(() => s2.job("vps")!.state === "failed");
    assert.match(s2.job("vps")!.error!, /ran past/);

    const w3 = world();
    const s3 = service(w3);
    await s3.start("vps", { commit: C }, json);
    await until(() => s3.job("vps")!.state === "failed");
    assert.match(s3.job("vps")!.error!, /doesn't answer with this host's version yet/);
  });

  test("routes: 404 while the mesh is off; the JSON rule holds through Hono", async () => {
    const app = new Hono();
    let on = false;
    mountResync(app, { enabled: () => on, config: () => (on ? config : null), self: () => ({ id: "desk", label: "Desk" }), peerFetch: async () => new Response("{}") } as never, {
      build: () => null,
      buildChecked: async () => null,
      probe: async () => ({ state: "down" }),
      recipes: () => ({ recipes: new Map() }),
    });
    assert.equal((await app.request("/api/mesh/resync")).status, 404);
    assert.equal((await app.request("/api/mesh/resync/vps", { method: "POST", headers: { "content-type": json }, body: JSON.stringify({ commit: C }) })).status, 404);
    on = true;
    assert.equal((await app.request("/api/mesh/resync")).status, 200);
    const form = await app.request("/api/mesh/resync/vps", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `commit=${C}` });
    assert.equal(form.status, 415, "a cross-site form can't start a job");
  });
});
