// The Transport agent (§app.transport/agent): the setup checks first, an agent only for what they
// show missing, once per device, its model, and the private files still holding the source's paths.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { onboardModels } from "../projects/onboard";
import { agentBrief } from "./agent-prompt";
import { type AgentDeps, agentModel, cleanRemote, needsAnswer, agentOf, afterArrival, isTransportAgent, prepareDestination, preflight, type PrepareRequest, projectNeeds, sameRemote, sourceValuesIn } from "./agent";

after(dropScratchAgentDir);

const REMOTE = "git@github.com:acme/motors.git";

test("what a project's files say it needs, per kind", () => {
  const needs = (...files: string[]) => projectNeeds((f) => files.includes(f));
  assert.deepEqual(needs("package.json", "pnpm-lock.yaml"), { programs: ["node", "pnpm"], deps: [{ dir: "node_modules", how: "pnpm install" }] });
  assert.deepEqual(needs("Cargo.toml").programs, ["cargo"]);
  assert.deepEqual(needs("go.mod").programs, ["go"]);
  assert.deepEqual(needs("deps.edn", "bb.edn", "mise.toml").programs, ["mise", "clojure", "bb"]);
  assert.deepEqual(needs("README.md"), { programs: [], deps: [] });
  assert.ok(sameRemote(REMOTE, "https://github.com/acme/motors"));
  assert.ok(!sameRemote(REMOTE, "https://github.com/acme/other.git"));
});

/** A device where `git` answers as a repository of the project in every existing folder, and programs are as given. */
function device(root: string, over: Partial<AgentDeps> = {}) {
  const started: { cwd: string; prompt: string; model: string }[] = [];
  const told: string[] = [];
  const linked: string[][] = [];
  let busyPolls = 0;
  let clock = 0;
  const deps: AgentDeps = {
    stateRoot: () => join(root, "state"),
    home: () => root,
    protectedRoots: () => [join(root, "state")],
    device: () => "laptop-b",
    which: () => true,
    git: async (args) => (args[0] === "remote" ? { code: 0, stdout: `origin\t${REMOTE} (fetch)\n` } : { code: 0, stdout: "" }),
    doctor: async () => null,
    offeredModels: async () => ["zai/glm-5.3", ...onboardModels()],
    startChat: async (i) => {
      started.push(i);
      busyPolls = 2;
      return { id: `agent-${started.length}`, path: join(root, `agent-${started.length}.jsonl`) };
    },
    link: async (a, peer, chat) => {
      linked.push([a, peer, chat]);
      return { linkId: "lk_1" };
    },
    tell: async (_p, text) => {
      told.push(text);
      busyPolls = 2;
    },
    busy: () => busyPolls-- > 0,
    sleep: async () => undefined,
    now: () => (clock += 5_000),
    ...over,
  };
  return { deps, started, told, linked };
}

const request = (root: string, tid = "tr_1", model?: string): PrepareRequest => ({
  tid,
  sourcePeer: "sova-laptop",
  sourceLabel: "laptop",
  sourceChatId: "chat-1",
  title: "Fix the motors",
  project: { remotes: [REMOTE], path: join(root, "webapps", "motors") },
  worktrees: [{ name: "motors-fix", branch: "feat/fix" }],
  ...(model ? { model } : {}),
});

test("the checks: a missing folder says clone; a folder of another repository is asked about; missing tools and dependencies named", async () => {
  const root = scratchRoot("transport-agent-");
  const d = device(root);
  const req = request(root);
  assert.deepEqual(await preflight(req.project, d.deps), [{ id: "folder", ok: false, detail: `${req.project.path} doesn't exist: clone ${REMOTE} there` }]);
  mkdirSync(req.project.path, { recursive: true });
  writeFileSync(join(req.project.path, "package.json"), "{}");
  writeFileSync(join(req.project.path, "pnpm-lock.yaml"), "");
  assert.deepEqual((await preflight({ remotes: [], path: req.project.path }, d.deps)).map((c) => [c.id, c.ok]), [["folder", false]], "nothing to know it by: not taken as the project");
  const other = device(root, { git: async (args) => (args[0] === "remote" ? { code: 0, stdout: "origin\tgit@github.com:acme/else.git (fetch)\n" } : { code: 0, stdout: "" }) });
  assert.deepEqual((await preflight(req.project, other.deps)).map((c) => [c.id, c.ok]), [["folder", false]]);
  const noPnpm = device(root, { which: (p) => p !== "pnpm" });
  assert.deepEqual((await preflight(req.project, noPnpm.deps)).filter((c) => !c.ok).map((c) => c.id), ["tool:pnpm", "deps:node_modules"]);
});

test("nothing missing: ready at once, no agent; something missing: one agent, briefed with it, linked, until its turn ends with the checks green; later transports skip it", async () => {
  const root = scratchRoot("transport-agent-");
  const req = request(root);
  const d = device(root, {
    // The agent's turn clones the project and installs it.
    busy: () => {
      mkdirSync(join(req.project.path, "node_modules"), { recursive: true });
      writeFileSync(join(req.project.path, "package.json"), "{}");
      return false;
    },
  });
  assert.deepEqual(await prepareDestination(req, d.deps), { ready: true });
  assert.equal(d.started.length, 1);
  const s = d.started[0]!;
  assert.match(s.prompt, /doesn't exist: clone git@github\.com:acme\/motors\.git there/);
  assert.match(s.prompt, /What you ask first/);
  assert.equal(s.model, onboardModels()[0], "the strongest model this device offers");
  assert.equal(s.cwd, join(root, "webapps"), "it starts in the nearest folder that exists");
  assert.deepEqual(d.linked, [["agent-1", "sova-laptop", "chat-1"]]);
  assert.equal(agentOf(d.deps.stateRoot(), "tr_1")?.state, "ready");
  assert.ok(isTransportAgent(d.deps.stateRoot(), "agent-1"));

  const later = device(root, { stateRoot: d.deps.stateRoot });
  assert.deepEqual(await prepareDestination(request(root, "tr_2"), later.deps), { ready: true });
  assert.equal(later.started.length, 0, "prepared once per device");
});

test("still missing after its turn: Needs you; a Retry hands the same agent what is left; the dialog's model wins", async () => {
  const root = scratchRoot("transport-agent-");
  const d = device(root);
  const r = await prepareDestination(request(root, "tr_1", "zai/glm-5.3"), d.deps);
  assert.ok("needsYou" in r && /laptop-b still needs 1 thing .*Transport: Fix the motors/.test(r.needsYou));
  assert.equal(d.started[0]!.model, "zai/glm-5.3");
  assert.equal(agentOf(d.deps.stateRoot(), "tr_1")?.state, "needs-you");
  await prepareDestination(request(root, "tr_1"), d.deps);
  assert.equal(d.started.length, 1, "the same agent");
  assert.match(d.told[0]!, /Still missing:/);
  assert.equal(agentModel(undefined, ["zai/glm-5.3"]), null);
  const none = device(root, { offeredModels: async () => ["zai/glm-5.3"] });
  const nr = await prepareDestination(request(root, "tr_9"), none.deps);
  assert.ok("needsYou" in nr && /no model for the Transport agent/.test(nr.needsYou));
});

test("after arrival: private files still holding the source's paths go to the agent, longest match first", async () => {
  const root = scratchRoot("transport-agent-");
  const env = join(root, ".env");
  writeFileSync(env, "DATABASE_URL=postgres://localhost/motors\nDATA=/Users/omar/webapps/motors/data\n");
  writeFileSync(join(root, "clean.edn"), "{:port 3000}\n");
  assert.deepEqual(sourceValuesIn([env, join(root, "clean.edn")], ["/Users/omar", "/Users/omar/webapps/motors"]), [{ file: env, found: ["/Users/omar/webapps/motors"] }]);
  const d = device(root);
  const req = { ...request(root), privateFiles: [env], sourceValues: ["/Users/omar/webapps/motors"] };
  // The device was prepared already, so no agent ran: one starts for these files alone.
  assert.deepEqual(await afterArrival(req, d.deps), [env]);
  assert.match(d.started[0]!.prompt, /still holds laptop's \/Users\/omar\/webapps\/motors/);
  await afterArrival(req, d.deps);
  assert.equal(d.started.length, 1);
  assert.match(d.told[0]!, /still hold that computer's values/);
});

test("a remote's credentials never reach the brief, a check or the dialog's answer", async () => {
  const root = scratchRoot("transport-agent-");
  const d = device(root);
  const tokenUrl = "https://x-access-token:ghp_SECRET@github.com/acme/motors.git";
  assert.equal(cleanRemote(tokenUrl), "https://github.com/acme/motors.git");
  assert.equal(cleanRemote("ssh://git@host/o/r.git"), "ssh://git@host/o/r.git");
  assert.equal(cleanRemote("ssh://me:pw@host/o/r.git"), "ssh://host/o/r.git");
  const req = { ...request(root), project: { remotes: [tokenUrl], path: join(root, "webapps", "motors") } };
  const answer = await needsAnswer(req.project, d.deps);
  assert.ok(answer.needs.length && !JSON.stringify(answer).includes("SECRET"));
  await prepareDestination(req, d.deps);
  assert.ok(!d.started[0]!.prompt.includes("SECRET"));
  assert.ok(!agentBrief({ title: "t", device: "d", source: "s", folder: "/f", remotes: [cleanRemote(tokenUrl)], branches: [], checks: [] }).includes("SECRET"));
});

test("a folder outside the home or inside Sova's own folders is refused before anything is made or started", async () => {
  const root = scratchRoot("transport-agent-");
  const d = device(root);
  mkdirSync(join(root, "state"), { recursive: true });
  symlinkSync(join(root, "state"), join(root, "projects"));
  for (const path of ["/etc/motors", join(root, "state", "x", "y"), "relative/motors", root, join(root, "projects", "motors")]) {
    const r = await prepareDestination({ ...request(root), project: { remotes: [REMOTE], path } }, d.deps);
    assert.ok("needsYou" in r, path);
  }
  assert.equal(d.started.length, 0);
  assert.match((await needsAnswer({ remotes: [REMOTE], path: "/etc/motors" }, d.deps)).needs[0]!, /isn't a folder inside your home/);
  // The source's "~/…" is this device's home.
  assert.deepEqual((await needsAnswer({ remotes: [REMOTE], path: "~/webapps/motors" }, d.deps)).needs, [`${join(root, "webapps", "motors")} doesn't exist: clone ${REMOTE} there`]);
});
