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
import { type AgentDeps, preparedAt as preparedAtOf, agentModel, agentModelChoices, strongestRunnable, cleanRemote, needsAnswer, agentOf, afterArrival, isTransportAgent, prepareDestination, preflight, type PrepareRequest, projectNeeds, sameRemote, sourceValuesIn } from "./agent";

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
  const ended: string[] = [];
  let busyPolls = 0;
  let clock = 0;
  const deps: AgentDeps = {
    stateRoot: () => join(root, "state"),
    home: () => root,
    protectedRoots: () => [join(root, "state")],
    device: () => "laptop-b",
    which: async (ps) => new Set(ps),
    git: async (args) => (args[0] === "remote" ? { code: 0, stdout: `origin\t${REMOTE} (fetch)\n` } : { code: 0, stdout: "" }),
    doctor: async () => null,
    offeredModels: async () => ["zai/glm-5.3", ...onboardModels()],
    claudeUsable: () => true,
    startChat: async (i) => {
      started.push(i);
      busyPolls = 2;
      return { id: `agent-${started.length}`, path: join(root, `agent-${started.length}.jsonl`) };
    },
    link: async (a, peer, chat) => {
      linked.push([a, peer, chat]);
      return { linkId: "lk_1" };
    },
    endLink: async (id) => void ended.push(id),
    tell: async (_p, text) => {
      told.push(text);
      busyPolls = 2;
    },
    busy: () => busyPolls-- > 0,
    sleep: async () => undefined,
    now: () => (clock += 5_000),
    ...over,
  };
  return { deps, started, told, linked, ended };
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
  const noPnpm = device(root, { which: async (ps) => new Set(ps.filter((p) => p !== "pnpm")) });
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
  assert.match(s.prompt, /check out feat\/fix and leave the tracked files exactly as they are/);
  assert.ok(s.prompt.includes(`look only under this device's home (${root}), never elsewhere on the disk`));
  const bare = agentBrief({ title: "t", device: "d", source: "s", folder: "/f", remotes: [], branches: [], checks: [], home: root });
  assert.ok(bare.includes("No remote is recorded: don't search the disk for a copy. Ask the user (align)"));
  assert.equal(s.model, onboardModels()[0], "the strongest model this device offers");
  assert.equal(s.cwd, join(root, "webapps"), "it starts in the nearest folder that exists");
  assert.deepEqual(d.linked, [["agent-1", "sova-laptop", "chat-1"]]);
  assert.deepEqual(d.ended, ["lk_1"], "its link ends once the device is ready: no report bounces between the two chats");
  assert.match(s.prompt, /at most three messages/);
  assert.ok(s.prompt.includes(`Never write into Sova's own folders (${join(root, "state")})`));
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
  assert.equal(agentModel(undefined, ["zai/glm-5.3"], { claudeUsable: true }), null);
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
  assert.match(d.started[0]!.prompt, /you have no link to it/);
  assert.deepEqual(d.linked, [], "the chat is here now: no link");
  assert.equal(agentOf(d.deps.stateRoot(), "tr_1")?.state, "needs-you", "its turn ended with the file unchanged");
  // The agent fixes the file this time: once its turn ends, the transport's agent reads as ready.
  const fixing = device(root, { stateRoot: d.deps.stateRoot, tell: async () => writeFileSync(env, "DATABASE_URL=postgres://localhost/motors\nDATA=/home/me/webapps/motors/data\n") });
  await afterArrival(req, fixing.deps);
  assert.equal(fixing.started.length, 0, "the same agent");
  assert.equal(agentOf(d.deps.stateRoot(), "tr_1")?.state, "ready");
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

test("the default model is the strongest this device can run: Claude Code only with a usable login, else gpt-6-astra, else the chat's own", async () => {
  const [opus, astra] = onboardModels();
  const all = ["zai/glm-5.3", opus!, astra!];
  assert.equal(strongestRunnable(all, { claudeUsable: true }), opus);
  // Claude Code is listed on every device (always on), signed in or not: without a login it is never the default.
  assert.equal(strongestRunnable(all, { claudeUsable: false }), astra);
  assert.equal(strongestRunnable(["zai/glm-5.3", opus!], { claudeUsable: false, chatModel: "zai/glm-5.3" }), "zai/glm-5.3");
  assert.equal(strongestRunnable(["zai/glm-5.3", opus!], { claudeUsable: false }), null);
  assert.deepEqual(agentModelChoices(["zai/glm-5.3", opus!], { claudeUsable: false, chatModel: "zai/glm-5.3" }), { models: ["zai/glm-5.3", opus!], default: "zai/glm-5.3" });
  assert.equal(agentModel(opus, ["zai/glm-5.3", opus!], { claudeUsable: false })?.model, opus, "the dialog's pick still wins");
  // The prepare: a device with only a zai key and no Claude login starts the agent on the chat's model.
  const root = scratchRoot("transport-agent-");
  const d = device(root, { claudeUsable: () => false, offeredModels: async () => ["zai/glm-5.3", opus!] });
  await prepareDestination({ ...request(root), chatModel: "zai/glm-5.3" }, d.deps);
  assert.equal(d.started[0]!.model, "zai/glm-5.3");
  const nd = device(root, { claudeUsable: () => false, offeredModels: async () => ["zai/glm-5.3", opus!] });
  assert.equal((await needsAnswer({ remotes: [REMOTE], path: join(root, "webapps", "x") }, nd.deps)).modelDefault, null);
});

test("the project from the source: no agent before arrival, an earlier one's link ends; after arrival one starts only for what the checks find missing, never told to clone", async () => {
  const root = scratchRoot("transport-agent-");
  const d = device(root, { which: async (ps) => new Set(ps.filter((p) => p !== "pnpm")) });
  const req = { ...request(root), fromSource: true };
  assert.deepEqual(await prepareDestination(req, d.deps), { ready: true });
  assert.equal(d.started.length, 0, "nothing to clone, nothing to check before it arrives");
  // It arrived: the project's folder is there now, without pnpm on this device.
  mkdirSync(req.project.path, { recursive: true });
  writeFileSync(join(req.project.path, "package.json"), "{}");
  writeFileSync(join(req.project.path, "pnpm-lock.yaml"), "");
  await afterArrival({ ...req, privateFiles: [], sourceValues: [] }, d.deps);
  const brief = d.started[0]!.prompt;
  assert.match(brief, /pnpm isn't installed for this user/);
  assert.match(brief, /Never clone it, fetch it or look for another copy/);
  assert.doesNotMatch(brief, /clone the repository|When you clone it|doesn't exist: clone/);
  // A device where everything is there: recorded as prepared, no agent.
  mkdirSync(join(req.project.path, "node_modules"));
  const fine = device(root, { stateRoot: () => join(root, "state2") });
  await afterArrival({ ...req, tid: "tr_2", privateFiles: [], sourceValues: [] }, fine.deps);
  assert.equal(fine.started.length, 0);
  assert.ok(preparedAtOf(fine.deps.stateRoot(), req.project));
  // A Retry after the agent's clone failed: it stops reporting over its link, and none starts.
  const tried = device(join(root, "t3"));
  const r3 = request(join(root, "t3"), "tr_3");
  assert.ok("needsYou" in (await prepareDestination(r3, tried.deps)));
  assert.deepEqual(await prepareDestination({ ...r3, fromSource: true }, tried.deps), { ready: true });
  assert.deepEqual(tried.ended, ["lk_1"]);
  assert.equal(tried.started.length, 1);
});
