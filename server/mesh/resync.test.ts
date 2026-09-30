// Run: pnpm exec tsx --test server/mesh/resync.test.ts
// Mesh version resync (§mesh.peers/resync): relation by a throwaway git repo's history, recipe
// parsing, and the job service with every outside part injected: a fake mesh, a fake probe, a
// fake peer details endpoint and a fake deploy script (node). No network, no ssh, no real peer.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ResyncJob } from "../../shared/mesh-resync";
import type { BootBuild } from "./build-id";
import { realGit } from "./build-id";
import type { ProbeResult } from "./hello";
import type { PeerEntry, PeersConfig } from "./peers";
import { mountResync, parseRecipes, readRecipes, type Recipe, recipeArgv, recipeProblem, relationOf, ResyncService } from "./resync";

const tmp = mkdtempSync(join(tmpdir(), "sova-resync-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- a repo: a - b - c on main, d branching from a ----------------------------------------------

const repo = join(tmp, "repo");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
const commitFile = (name: string) => {
  writeFileSync(join(repo, name), name);
  git("add", name);
  git("commit", "-q", "-m", name);
  return git("rev-parse", "HEAD");
};
const A = commitFile("a");
const B = commitFile("b");
const C = commitFile("c");
git("checkout", "-q", "-b", "side", A);
const D = commitFile("d");
const MISSING = "f".repeat(40);

describe("relation", () => {
  test("behind, ahead, same, diverged and unknown, by this checkout's history", async () => {
    assert.deepEqual(await relationOf(C, A, repo, realGit), { relation: "behind", distance: 2 });
    assert.deepEqual(await relationOf(A, C, repo, realGit), { relation: "ahead", distance: 2 });
    assert.deepEqual(await relationOf(B, B, repo, realGit), { relation: "same" });
    assert.deepEqual(await relationOf(C, D, repo, realGit), { relation: "diverged" });
    assert.deepEqual(await relationOf(C, MISSING, repo, realGit), { relation: "unknown" }, "a commit this checkout lacks");
    assert.deepEqual(await relationOf(C, undefined, repo, realGit), { relation: "unknown" }, "a peer that says no commit");
    assert.deepEqual(await relationOf(undefined, A, repo, realGit), { relation: "unknown" }, "no boot commit here");
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
    assert.deepEqual(readRecipes(file), { recipes: new Map() });
    writeFileSync(file, "{ not json");
    assert.equal(readRecipes(file).recipes.size, 0);
    assert.match(readRecipes(file).error!, /valid JSON/);
    writeFileSync(file, JSON.stringify({ vps: { kind: "vps" } }));
    assert.match(readRecipes(file).error!, /"hosts"/);
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

const PROTO = "1111111111111111";
const peer = (id: string, port: number): PeerEntry => ({ id, label: id.toUpperCase(), nodeId: `n${id}`, dnsName: `${id}.lab`, url: `http://127.0.0.1:${port}` });
const config: PeersConfig = { self: { id: "desk", label: "Desk" }, peers: [peer("vps", 1), peer("phone", 2), peer("new", 3), peer("gone", 4)], sync: {}, frontDoor: null };

interface World {
  build: BootBuild | null;
  /** Each peer's hello answer. */
  probes: Record<string, ProbeResult>;
  /** Each peer's details commit and activity. */
  details: Record<string, { commit?: string; turnsRunning: number; workers: number }>;
  recipes: Map<string, Recipe>;
  spawned: string[][];
  /** The fake deploy script's exit code, and whether it hangs. */
  exit: number;
  hang?: boolean;
}

const skewed = (commit?: string): ProbeResult => ({ state: "skewed", hello: { mesh: 1, id: "x", label: "X", hostname: "x", version: "0.1.0", protocol: "0000000000000000", pi: "0", now: 0, ...(commit ? { commit } : {}) } });

function world(over: Partial<World> = {}): World {
  return {
    build: { commit: C, protocol: PROTO, dirty: false, verified: true },
    probes: { vps: skewed(), phone: skewed(A), new: skewed(), gone: { state: "down", error: "ECONNREFUSED" } },
    details: { vps: { commit: A, turnsRunning: 1, workers: 2 }, phone: { commit: B, turnsRunning: 0, workers: 0 }, new: { commit: D, turnsRunning: 0, workers: 0 } },
    recipes: new Map<string, Recipe>([
      ["vps", { kind: "vps", args: [] }],
      ["phone", { kind: "termux", args: [], ssh: "u@p" }],
    ]),
    spawned: [],
    exit: 0,
    ...over,
  };
}

function service(w: World, logDir = join(tmp, "logs")) {
  const byUrl = (url: string) => config.peers.find((p) => p.url === url)!.id;
  return new ResyncService({
    mesh: {
      enabled: () => true,
      config: () => config,
      self: () => ({ id: "desk", label: "Desk" }),
      peerFetch: async (id: string) => {
        const d = w.details[id];
        if (!d) throw new Error("ECONNREFUSED");
        const body = { details: 1, identity: {}, versions: { sova: "0.1.0", ...(d.commit ? { commit: d.commit } : {}), pi: "0", node: "v22", protocol: "0" }, activity: { sessions: 1, turnsRunning: d.turnsRunning, workers: d.workers } };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    } as never,
    root: repo,
    git: realGit,
    build: () => w.build,
    buildChecked: async () => w.build,
    probe: async (p) => w.probes[p.id]!,
    hello: async (url) => w.probes[byUrl(url)]!,
    protocol: () => PROTO,
    recipes: () => ({ recipes: w.recipes }),
    logDir: () => logDir,
    exists: () => true,
    spawn: (argv) => {
      w.spawned.push(argv);
      const script = w.hang ? "setInterval(() => {}, 1000)" : `console.log("deploying"); console.error("to stderr"); process.exit(${w.exit})`;
      return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    },
    timeouts: { vps: 2_000, termux: 2_000, wait: 300, poll: 20 },
  });
}

const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

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
    assert.equal((r.body as { error: string }).error, "No resync recipe for NEW on Desk");
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
    const log = readFileSync(join(logs, "vps.log"), "utf8");
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
    const s2 = service(w2);
    await s2.start("vps", { commit: C }, json);
    await until(() => s2.job("vps")!.state === "failed", 5000);
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
