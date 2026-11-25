// What the Transport agent asks you on its card (§app.transport/agent "Downloads, on your click", "Administrator rights
// stay yours", "Ready only when it is"): its network widens only on your Allow, to exactly the hosts listed; a command
// needing administrator rights is never run, only shown; and Ready waits for every check and every answer.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { onboardModels } from "../projects/onboard";
import { hostAllowed } from "../../pi-config/extensions/sandbox/proxy.ts";
import { parseParentScope } from "../../pi-config/extensions/sandbox/policy.ts";
import { type AgentScope, agentLaunchFlags, agentTidOf, preparedFile } from "./agent-scope";
import { cleanDownloads, downloadsAllowed } from "./agent-asks";
import { afterArrival, type AgentCheck, type AgentDeps, agentOf, allowDownloads, askAdmin, askDownloads, markAdminDone, preflight, preparedAt, prepareDestination, type PrepareRequest, readyNow } from "./agent";
import { agentViewOf } from "./wire";

after(dropScratchAgentDir);

const REMOTE = "git@github.com:acme/expansion.git";
/** What the sandbox's network reaches before any list is allowed (the policy file's allowlist, as networkBase reads it). */
const BASE = ["github.com", "registry.npmjs.org", "repo.clojars.org"];
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A device with the project's folder there (its git answering as the project), every program found, and a recorder of
    every call that could run something: git, which, doctor, the tool-version check, the agent's messages. */
function device(root: string, over: Partial<AgentDeps> = {}) {
  const told: string[] = [];
  const reopened: string[] = [];
  const confined: AgentScope[] = [];
  const ran: string[][] = [];
  let busy = 0;
  let clock = 0;
  const deps: AgentDeps = {
    stateRoot: () => join(root, "state"),
    home: () => root,
    protectedRoots: () => [join(root, "state")],
    device: () => "laptop-b",
    which: async (ps) => (ran.push(["which", ...ps]), new Set(ps)),
    git: async (args) => (ran.push(["git", ...args]), args[0] === "remote" ? { code: 0, stdout: `origin\t${REMOTE} (fetch)\n` } : { code: 0, stdout: "" }),
    doctor: async () => null,
    toolResolves: async (t) => (ran.push(["toolResolves", t]), true),
    networkBase: () => [...BASE],
    offeredModels: async () => [...onboardModels()],
    claudeUsable: () => true,
    agentHidden: async () => [],
    confine: async (s) => (confined.push(s), null),
    startChat: async () => ((busy = 2), { id: "agent-1", path: join(root, "agent-1.jsonl") }),
    link: async () => ({ linkId: "lk_1" }),
    endLink: async () => undefined,
    tell: async (_p, text) => void (told.push(text), (busy = 2)),
    busy: () => busy-- > 0,
    reopen: async (p) => void reopened.push(p),
    sleep: tick,
    now: () => (clock += 5_000),
    ...over,
  };
  return { deps, told, reopened, confined, ran, setBusy: (n: number) => (busy = n) };
}

const request = (root: string): PrepareRequest => ({
  tid: "tr_asks1",
  sourcePeer: "sova-laptop",
  sourceLabel: "laptop",
  sourceChatId: "chat-1",
  title: "Expansion",
  project: { remotes: [REMOTE], path: join(root, "webapps", "expansion") },
  worktrees: [{ name: "expansion", branch: "main" }],
});

/** A JavaScript project pinning node and java in its mise file, without its dependencies installed. */
function project(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), "{}");
  writeFileSync(join(path, "pnpm-lock.yaml"), "");
  writeFileSync(join(path, "mise.toml"), '[tools]\nnode = "22.11.0"\njava = "corretto-21"\n');
}

const scopeOf = (root: string, sessionId = "agent-1"): AgentScope | undefined =>
  (JSON.parse(readFileSync(preparedFile(join(root, "state")), "utf8")) as { agents: Record<string, { scope?: AgentScope }> }).agents[sessionId]?.scope;

/** The allowlist the agent's chat opens with: its launch flags' sandbox scope, as the sandbox parses it. */
function openedAllow(root: string): string[] | undefined {
  const flags = agentLaunchFlags(join(root, "state"), "agent-1");
  assert.ok(flags && "extra" in flags);
  const parsed = parseParentScope(flags.extra["sandbox-parent"]);
  assert.ok(parsed.ok);
  return parsed.value.proxyAllow;
}

async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000 && !f(); i++) await tick();
  assert.ok(f(), "it never happened");
}

const ITEMS = [
  { tool: "node", version: "22.11.0", host: "nodejs.org" },
  { tool: "java", version: "corretto-21", host: "corretto.aws" },
];

test("a download list widens nothing before your Allow; Allow widens the agent's network by exactly the listed hosts, and a host not listed stays blocked", async () => {
  const root = scratchRoot("transport-asks-");
  const req = request(root);
  project(req.project.path);
  let asked = false;
  let allowedTurn = false;
  const d = device(root, {
    busy: () => {
      // Its first turn: mise install fails on hosts the proxy refuses, so it lists them and ends its turn.
      if (!asked) {
        asked = true;
        const r = askDownloads(d.deps, "agent-1", { items: ITEMS, why: "mise install node and java" });
        assert.ok(r.ok && /Nothing is reachable yet/.test(r.text));
        return true;
      }
      // Its turn after the Allow: it installs, and the dependencies are there.
      if (d.told.some((t) => t.startsWith("The user allowed")) && !allowedTurn) {
        allowedTurn = true;
        mkdirSync(join(req.project.path, "node_modules"), { recursive: true });
        return true;
      }
      return false;
    },
  });
  const prepared = prepareDestination(req, d.deps);
  await until(() => agentOf(join(root, "state"), req.tid)?.downloads?.state === "asked");
  const a = agentOf(join(root, "state"), req.tid)!;

  // Before your click: the list is on the card, the agent reads Needs you, and its network is exactly what it was.
  assert.equal(a.state, "needs-you");
  assert.deepEqual(agentViewOf(a).downloads?.items, ITEMS, "the card shows each tool, its version and its site");
  assert.equal(scopeOf(root)?.proxyAllow, undefined, "no widening before the click");
  assert.equal(openedAllow(root), undefined, "its chat opens with the policy's own allowlist");
  assert.deepEqual(d.confined.filter((s) => s.proxyAllow), [], "no widened scope was even probed");
  assert.equal(preparedAt(join(root, "state"), req.project), null);

  // A stale or made-up list id allows nothing.
  assert.deepEqual(await allowDownloads(d.deps, req.tid, "dl_000000000000"), { ok: false, status: 409, error: "That download list isn't the agent's current one. Nothing was allowed." });
  assert.equal(scopeOf(root)?.proxyAllow, undefined);

  // Your Allow: exactly the listed hosts join what it reached before.
  const res = await allowDownloads(d.deps, req.tid, a.downloads!.id);
  assert.ok(res.ok);
  const allow = scopeOf(root)?.proxyAllow ?? [];
  assert.deepEqual(new Set(allow.filter((h) => !BASE.includes(h))), new Set(["nodejs.org", "corretto.aws"]), "exactly the listed hosts were added");
  assert.deepEqual(new Set(allow), new Set([...BASE, "nodejs.org", "corretto.aws"]), "nothing it reached before was lost, nothing else gained");
  assert.deepEqual(openedAllow(root), allow, "its next open takes that allowlist");
  assert.deepEqual(d.confined.at(-1)?.proxyAllow, allow, "the sandbox probed the widened scope before it was recorded");
  for (const h of ["nodejs.org", "corretto.aws", "github.com"]) assert.ok(hostAllowed(h, allow), `${h} is let through`);
  for (const h of ["mise-versions.jdx.dev", "evil.example.com", "sub.nodejs.org", "nodejs.org.evil.example"]) assert.ok(!hostAllowed(h, allow), `${h} stays blocked`);

  // It is reopened (a running chat keeps its scope) and told what it may now fetch, then its next turn is waited for.
  await res.handed;
  assert.deepEqual(d.reopened, [join(root, "agent-1.jsonl")]);
  assert.equal(d.told.at(-1), downloadsAllowed(ITEMS));
  assert.deepEqual(await prepared, { ready: true });
  assert.equal(agentOf(join(root, "state"), req.tid)?.state, "ready");
});

test("after arrival, your Allow before the asking turn has ended: the turn it hands on is waited for, and the tool it installs there clears", async () => {
  const root = scratchRoot("transport-asks-");
  const req = request(root);
  project(req.project.path);
  mkdirSync(join(req.project.path, "node_modules"), { recursive: true });
  const state = join(root, "state");
  let installed = false;
  let phase: "asking" | "allowed" | "installing" | "idle" = "asking";
  let installTurn = 0;
  let allowing: Promise<unknown> | null = null;
  const d = device(root, {
    // node isn't at its pinned version until the turn after the Allow installs it.
    toolResolves: async (t) => t !== "node" || installed,
    busy: () => {
      if (phase === "asking") {
        // Its first turn lists node's site, and you press Allow while that turn is still running.
        const a = agentOf(state, req.tid);
        if (a && !a.downloads) {
          assert.ok(askDownloads(d.deps, a.sessionId, { items: ITEMS.slice(0, 1) }).ok);
          allowing = allowDownloads(d.deps, req.tid, agentOf(state, req.tid)!.downloads!.id);
          phase = "allowed";
        }
        return true;
      }
      if (phase === "allowed") {
        if (agentOf(state, req.tid)?.downloads?.state !== "allowed") return true;
        // The asking turn ends just after your Allow.
        if (d.told.some((t) => t.startsWith("The user allowed"))) phase = "installing";
        return false;
      }
      if (phase === "installing") {
        if (++installTurn < 3) return true;
        installed = true;
        phase = "idle";
      }
      return false;
    },
  });
  await afterArrival({ ...req, fromSource: true, privateFiles: [], sourceValues: [] }, d.deps);
  await allowing;
  assert.ok(installed, "its install turn ran before the checks were read");
  const a = agentOf(state, req.tid)!;
  assert.deepEqual(a.checks.filter((c) => !c.ok), [], "node, installed by that turn, no longer reads missing");
  assert.equal(a.state, "ready");
  assert.ok(preparedAt(state, req.project) !== null);
});

test("after arrival, an answer once its wait has ended (it read Needs you): the checks are read again after the turn it hands on, and a tool installed there clears", async () => {
  const root = scratchRoot("transport-asks-");
  const req = request(root);
  project(req.project.path);
  mkdirSync(join(req.project.path, "node_modules"), { recursive: true });
  const state = join(root, "state");
  let installed = false;
  const d = device(root, { toolResolves: async (t) => t !== "node" || installed });
  await afterArrival({ ...req, fromSource: true, privateFiles: [], sourceValues: [] }, d.deps);
  assert.equal(agentOf(state, req.tid)?.state, "needs-you");
  // Later (a message of yours reached it) it asks you to run a command, and you press Done: its turn installs node.
  assert.ok(askAdmin(d.deps, agentOf(state, req.tid)!.sessionId, { command: "sudo apt-get install -y gnupg" }).ok);
  const step = agentOf(state, req.tid)!.admin![0]!;
  let turn = 0;
  d.deps.busy = () => (d.told.some((t) => t.includes("sudo apt-get install -y gnupg")) && turn < 3 ? (++turn === 3 ? ((installed = true), false) : true) : false);
  const done = await markAdminDone(d.deps, req.tid, step.id);
  assert.ok(done.ok);
  await done.handed;
  await done.checked;
  assert.ok(installed);
  const a = agentOf(state, req.tid)!;
  assert.deepEqual(a.checks.filter((c) => !c.ok), []);
  assert.equal(a.state, "ready");
});

test("a listed site is one plain public host: wildcards, addresses, schemes, ports and local names are refused, and nothing is put on the card", () => {
  for (const host of ["*.nodejs.org", "127.0.0.1", "localhost", "https://nodejs.org", "nodejs.org:443", "nodejs.org/dist", "user@nodejs.org", "printer.local", "", "org"])
    assert.equal(typeof cleanDownloads([{ tool: "node", version: "22", host }]), "string", `${JSON.stringify(host)} is refused`);
  assert.deepEqual(cleanDownloads([{ tool: "node", version: "22.11.0", host: "NodeJS.org." }]), [{ tool: "node", version: "22.11.0", host: "nodejs.org" }]);
  assert.equal(typeof cleanDownloads([]), "string");
  const root = scratchRoot("transport-asks-");
  const d = device(root);
  assert.deepEqual(askDownloads(d.deps, "not-an-agent", { items: ITEMS }), { ok: false, error: "transport_setup is the Transport agent's, and this chat isn't one." });
});

test("a command needing administrator rights is never run: the card shows it, and only your Done tells the agent to go on", async () => {
  const root = scratchRoot("transport-asks-");
  const req = request(root);
  project(req.project.path);
  mkdirSync(join(req.project.path, "node_modules"), { recursive: true });
  const COMMAND = "sudo apt-get install -y libpq-dev";
  let asked = false;
  const d = device(root, {
    // The checks find something missing first, so an agent starts.
    toolResolves: async (t) => asked || t !== "java",
    busy: () => {
      if (!asked) {
        asked = true;
        const r = askAdmin(d.deps, "agent-1", { command: COMMAND, why: "the postgres driver builds against it" });
        assert.ok(r.ok && /Never run it, or anything else with sudo/.test(r.text));
        assert.ok(askAdmin(d.deps, "agent-1", { command: COMMAND }).ok, "asked again while it waits: the same step");
        return true;
      }
      return false;
    },
  });
  const prepared = prepareDestination(req, d.deps);
  await until(() => !!agentOf(join(root, "state"), req.tid)?.admin?.length);
  const a = agentOf(join(root, "state"), req.tid)!;
  assert.equal(a.admin!.length, 1);
  assert.deepEqual(agentViewOf(a).admin, [{ id: a.admin![0]!.id, command: COMMAND, why: "the postgres driver builds against it", state: "asked" }], "the card shows the exact command");
  assert.equal(a.state, "needs-you");
  // Waiting on you, the agent isn't nagged and nothing runs: no call anywhere carries the command.
  for (let i = 0; i < 50; i++) await tick();
  assert.equal(d.told.length, 0);
  assert.ok(!d.ran.some((call) => call.join(" ").includes("apt-get") || call.includes("sudo")), "nothing ran the command");
  assert.equal(preparedAt(join(root, "state"), req.project), null, "not ready while it waits");

  const done = await markAdminDone(d.deps, req.tid, a.admin![0]!.id);
  assert.ok(done.ok);
  await done.handed;
  assert.deepEqual(d.reopened, [], "Done changes nothing about its sandbox");
  assert.match(d.told.at(-1)!, /The user says they ran this themselves on this device: sudo apt-get install -y libpq-dev/);
  assert.deepEqual(await prepared, { ready: true });
  assert.ok(!d.ran.some((call) => call.join(" ").includes("apt-get")), "nothing here ever ran it");
});

test("Ready is refused while an item is missing: a tool not installed at the version the project pins, or anything still asked of you", async () => {
  const root = scratchRoot("transport-asks-");
  const req = request(root);
  project(req.project.path);
  mkdirSync(join(req.project.path, "node_modules"), { recursive: true });
  // node and java are found as programs (an older system copy), but java isn't installed at the version mise pins.
  const d = device(root, { toolResolves: async (t) => t !== "java" });
  const checks = await preflight(req.project, d.deps);
  assert.deepEqual(
    checks.filter((c) => !c.ok),
    [{ id: "tool:java", ok: false, detail: "java isn't installed at the version the project pins: mise install" }],
  );
  // The agent's turn ends with java still unresolvable: Needs you over it, never Ready, and the project isn't recorded.
  assert.deepEqual(await prepareDestination(req, d.deps), { needsYou: `laptop-b still needs 1 thing the Transport agent couldn't finish. Open "Transport: Expansion" on laptop-b to answer it, then press Retry` });
  const a = agentOf(join(root, "state"), req.tid)!;
  assert.equal(a.state, "needs-you");
  assert.deepEqual(a.checks.filter((c) => !c.ok).map((c) => c.id), ["tool:java"]);
  assert.equal(preparedAt(join(root, "state"), req.project), null);

  // Every check green but something it asked you still waiting: not ready either.
  const green: AgentCheck[] = [{ id: "folder", ok: true, detail: "" }];
  assert.equal(readyNow(green, { admin: [{ id: "ad_1", command: "sudo x", state: "asked", at: 1 }] }), false);
  assert.equal(readyNow(green, { downloads: { id: "dl_1", items: ITEMS, state: "asked", at: 1 } }), false);
  assert.equal(readyNow(green, { downloads: { id: "dl_1", items: ITEMS, state: "allowed", at: 1 }, admin: [{ id: "ad_1", command: "sudo x", state: "done", at: 1 }] }), true);
  assert.equal(readyNow([...green, { id: "deps:node_modules", ok: false, detail: "" }], null), false);
  assert.equal(agentTidOf(join(root, "state"), "agent-1"), req.tid);
});
