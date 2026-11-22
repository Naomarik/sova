// The "Private names and secrets" step (§app.merge-queue/names-step): the scan's facts say where and what kind, never the
// matched text; a hit holds the landing for the user's Allow / Send Back / Ask the Merge Thread, each their own click.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RunStep } from "../../shared/merge-queue";
import type { Caller } from "../project-services/engine";
import type { RunMerge } from "./contract";
import { realGit } from "./guard";
import { allowFileOf, allowMatches, factsOf, openHits, readAllowed, runScan, SCAN_STEP_ID, SCAN_STEP_LABEL, scanPlanned, scanResultOf } from "./names-step";
import { scanPublication } from "./publish-scan";
import { merger } from "./routes";
import { writeOverride } from "./strategy";
import { makeKit, makeRepo, sh, standInRun, until } from "./testing/queue-kit";

const SECRET_NAME = "zorblaxcorp";

describe("the scan's facts", () => {
  test("a count reads with its verb", async () => {
    const { thingsThatLook } = await import("./publish-scan");
    assert.deepEqual([1, 2, 0, undefined].map(thingsThatLook), ["1 thing that looks", "2 things that look", "some things that look", "some things that look"]);
  });

  test("the secret's kind reads with its article", async () => {
    const { looksLike, SECRET_PATTERNS } = await import("./publish-scan");
    const said = Object.fromEntries(SECRET_PATTERNS.map(([label]) => [label, looksLike(label)]));
    assert.deepEqual(said, {
      "private key": "looks like a private key",
      "AWS access key": "looks like an AWS access key",
      "GitHub token": "looks like a GitHub token",
      "GitHub fine-grained token": "looks like a GitHub fine-grained token",
      "GitLab token": "looks like a GitLab token",
      "Anthropic key": "looks like an Anthropic key",
      "API key": "looks like an API key",
      "Slack token": "looks like a Slack token",
      "Google API key": "looks like a Google API key",
      "assigned secret": "looks like an assigned secret",
    });
  });

  test("where and what kind, never the text; an allowed match is skipped by its key, which follows the name, not its place in the list", async () => {
    const repo = makeRepo();
    try {
      const names = join(repo.state, "names.json");
      writeFileSync(names, JSON.stringify({ v: 1, privateNames: ["other", SECRET_NAME] }));
      const base = repo.head();
      const b = repo.branch("feat/n", { "src/a.ts": `export const who = "${SECRET_NAME} inc";\n`, "src/b.ts": "const k = 'AKIA" + "ABCDEFGHIJKLMNOP';\n" });
      const r = await scanPublication(realGit, { repo: repo.root, range: `${base}..${b.head}`, namesFile: names });
      assert.equal(r.ok, false);
      const f = factsOf(r);
      assert.equal(f.state, "hits");
      assert.equal(scanResultOf(f), "failed");
      assert.deepEqual(f.hits!.map((h) => [h.kind, h.what, h.file, h.line]).sort(), [["name", "private name #2", "src/a.ts", 1], ["secret", "looks like an AWS access key", "src/b.ts", 1]].sort());
      assert.ok(!JSON.stringify(f).includes(SECRET_NAME), "no matched text in the facts");
      assert.ok(!JSON.stringify(f).includes("AKIA" + "ABCDEFGHIJKLMNOP"));

      // The list reordered: the name's key stays, so allowing it once still holds.
      const nameHit = f.hits!.find((h) => h.kind === "name")!;
      writeFileSync(names, JSON.stringify({ v: 1, privateNames: [SECRET_NAME, "other"] }));
      const again = factsOf(await scanPublication(realGit, { repo: repo.root, range: `${base}..${b.head}`, namesFile: names }));
      assert.equal(again.hits!.find((h) => h.kind === "name")!.key, nameHit.key);
      const allow = join(repo.state, "allow.json");
      assert.equal(allowMatches(allow, [nameHit], { at: "t" }), 1);
      assert.equal(allowMatches(allow, [nameHit], { at: "t" }), 0, "once per key");
      assert.ok(!readFileSync(allow, "utf8").includes(SECRET_NAME), "the allow list keeps no matched text");
      const after = factsOf(await runScan(realGit, { copy: repo.root, base, tip: b.head, namesFile: names, allowFile: allow }));
      assert.deepEqual([after.state, after.allowed, after.hits!.map((h) => h.kind)], ["hits", 1, ["secret"]]);
      assert.deepEqual(openHits([{ id: SCAN_STEP_ID, scan: f }], allow).map((h) => h.kind), ["secret"], "a run's open hits: only what isn't allowed since");
    } finally {
      repo.done();
    }
  });

  test("no names list yet: secrets only, the step passes as unanswered; a names file that can't be read is skipped, never passed", async () => {
    const repo = makeRepo();
    try {
      const base = repo.head();
      const b = repo.branch("feat/u", { "u.txt": `${SECRET_NAME}\n` });
      const none = factsOf(await runScan(realGit, { copy: repo.root, base, tip: b.head, allowFile: join(repo.state, "x.json") }));
      assert.deepEqual([none.state, scanResultOf(none)], ["unanswered", "passed"]);
      const bad = join(repo.state, "bad.json");
      writeFileSync(bad, "{not json");
      const u = factsOf(await runScan(realGit, { copy: repo.root, base, tip: b.head, namesFile: bad, allowFile: join(repo.state, "x.json") }));
      assert.deepEqual([u.state, scanResultOf(u)], ["unreadable", "skipped"]);
    } finally {
      repo.done();
    }
  });

  test("planned only where the landing pushes", () => {
    assert.deepEqual(scanPlanned({ def: null, how: "local", hasRemote: true }), { run: true });
    assert.equal(scanPlanned({ def: null, how: "local", hasRemote: false }).run, false);
    assert.equal(scanPlanned({ def: { merge: { push: false } } as never, how: "local", hasRemote: true }).run, false);
    assert.equal(scanPlanned({ def: null, how: "github-pr", hasRemote: true }).run, true, "a request publishes the branch");
    assert.equal(scanPlanned({ def: { merge: { push: false } } as never, how: "push-branch", hasRemote: true }).run, true, "merge.push is the target's push, not the branch's");
    assert.equal(scanPlanned({ def: null, how: "push-branch", hasRemote: false }).run, false);
  });
});

/** A stand-in run that ends with a real scan step over what it merged (as run.ts withScan does). */
function scanningRun(): { stand: ReturnType<typeof standInRun>; run: RunMerge } {
  const stand = standInRun();
  const run: RunMerge = async (input, hooks) => {
    const o = await stand.run(input, hooks);
    if (!input.scan || !o.tip) return o;
    const facts = factsOf(await runScan(realGit, { copy: input.project.root, base: input.base, tip: o.tip, ...(input.scan.namesFile ? { namesFile: input.scan.namesFile } : {}), allowFile: input.scan.allowFile }));
    const step: RunStep = { id: SCAN_STEP_ID, kind: "scan", label: SCAN_STEP_LABEL, result: scanResultOf(facts), ms: 1, log: "logs/02-scan.log", scan: facts };
    hooks.step(step);
    return { ...o, scan: facts };
  };
  return { stand, run };
}

function namesKit(threadAnswers = true) {
  const { run } = scanningRun();
  const decided: string[] = [];
  const k = makeKit({ threadAnswers, deps: { runMerge: run, decided: (e) => void decided.push(e.decision?.kind ?? "") } });
  // The project's names list (the legacy file the kit reads).
  writeFileSync(join(k.repo.state, "merge-round.json"), JSON.stringify({ v: 1, privateNames: [SECRET_NAME] }));
  return { k, decided };
}

describe("a hit holds the landing for the user", () => {
  test("the entry waits as a private-names decision, notified; Allow marks it fine for the project and it lands", async () => {
    const { k, decided } = namesKit();
    try {
      const q = await k.q();
      const before = k.repo.head();
      const b = k.repo.branch("feat/leak", { "src/x.ts": `// ${SECRET_NAME}\n` });
      const { entry } = await q.add({ branch: "feat/leak", by: "land-button", session: "s1" });
      const e = await until(async () => ((await k.entry(entry.id)).state === "needs-user" ? k.entry(entry.id) : null), "held for names");
      assert.equal(k.repo.head(), before, "the target didn't move");
      assert.equal(e.decision?.kind, "private-names");
      assert.deepEqual(e.decision?.actions, ["allow", "send-back", "ask-thread"]);
      assert.ok(!e.decision!.question.includes(SECRET_NAME), "the question names the place, never the text");
      assert.match(e.decision!.question, /src\/x\.ts:1 · private name #1/);
      assert.match(e.decision!.question, /found 1 thing that looks like private names or secrets:/);
      assert.equal(e.reason, "the scan before pushing found 1 thing that looks private");
      assert.deepEqual(decided, ["private-names"], "one notification, as every decision");
      const run = (await q.view()).needsYou.find((x) => x.id === entry.id)!.run!;
      assert.equal(q.store.readRun(run)?.steps.find((s) => s.id === SCAN_STEP_ID)?.result, "failed");

      await q.answer(entry.id, "allow");
      await until(async () => (await k.entry(entry.id)).state === "landed", "landed after Allow");
      assert.ok(k.repo.head() !== before);
      const allowed = readAllowed(allowFileOf(q.store.dir));
      assert.equal(allowed.length, 1);
      assert.ok(!JSON.stringify(allowed).includes(SECRET_NAME));

      // The same line again in that file, in another branch, is fine now: it lands with no decision.
      k.repo.branch("feat/same", { "src/x.ts": `// ${SECRET_NAME}\nconst more = 1;\n// ${SECRET_NAME}\n` });
      const two = await q.add({ branch: "feat/same", by: "land-button", session: "s2" });
      await until(async () => (await k.entry(two.entry.id)).state === "landed", "the allowed match lands");
      void b;
    } finally {
      await k.done();
    }
  });

  test("Send Back hands it to the branch's chat naming where, never the text; Ask the Merge Thread tells the thread where and keeps the decision", async () => {
    const { k } = namesKit();
    try {
      const q = await k.q();
      k.repo.branch("feat/sb", { "y.txt": `${SECRET_NAME}\n` });
      const { entry } = await q.add({ branch: "feat/sb", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "needs-user", "held for names");
      await q.answer(entry.id, "ask-thread");
      const told = k.thread.find((ev) => ev.kind === "names-hit");
      assert.ok(told, "the thread is told");
      assert.ok(told!.hits!.some((l) => l.includes("y.txt:1")));
      assert.ok(!JSON.stringify(told).includes(SECRET_NAME));
      assert.equal((await k.entry(entry.id)).state, "needs-user", "the decision stays the user's");

      await q.answer(entry.id, "send-back");
      const e = await k.entry(entry.id);
      assert.equal(e.state, "with-chat");
      assert.equal(e.sentBackFor, "names");
      const rq = e.requests!.at(-1)!;
      assert.match(rq.text, /y\.txt:1 · private name #1/);
      assert.ok(!rq.text.includes(SECRET_NAME));
      await assert.rejects(q.answer(entry.id, "allow"), /answers the scan.s private names/);
    } finally {
      await k.done();
    }
  });

  test("No private names answers the interview at one click and the held push goes", async () => {
    const k = makeKit();
    try {
      // No names file at all: pushes are held.
      writeFileSync(join(k.repo.state, "merge-round.json"), "{}");
      const q = await k.q();
      k.repo.branch("feat/p", { "p.txt": "p\n" });
      const { entry } = await q.add({ branch: "feat/p", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "landed", "landed");
      assert.equal((await q.view()).names, "unanswered");
      assert.notEqual(sh(k.repo.origin, "rev-parse", k.repo.target), k.repo.head(), "held");
      const r = await q.noPrivateNames();
      assert.ok(existsSync(r.file));
      assert.equal(sh(k.repo.origin, "rev-parse", k.repo.target), k.repo.head(), "pushed");
      assert.equal((await q.view()).names, "none");
      await assert.rejects(q.noPrivateNames(), /answered already/);
    } finally {
      await k.done();
    }
  });
});

describe("who may answer", () => {
  test("Allow, Send Back, Ask the Merge Thread, No private names and the held push's Allow are the user's own click: never the thread, a chat or a chat's script", async () => {
    const k = makeKit();
    try {
      await k.q();
      const thread = "thread-1";
      const call = merger({
        queues: k.queues,
        served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("served"); } },
        rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
        isThreadChat: (root, sid) => root === k.repo.root && sid === thread,
        names: async (_q, action) => ({ action, summary: "ok" }),
      });
      const session = (id: string): Caller => ({ kind: "session", id, root: k.repo.root, own: [] });
      const fromChat = { kind: "operator", fromChat: true } as unknown as Caller;
      const fromCard = { kind: "operator", fromCard: true } as unknown as Caller;
      for (const who of [session(thread), session("someone"), fromChat, fromCard]) {
        for (const action of ["none", "allow"]) assert.equal((await call("merge.names", { project: k.repo.root, action }, who)).error?.code, "forbidden", `merge.names ${action} by ${JSON.stringify(who)}`);
        for (const answer of ["allow", "send-back", "ask-thread"]) assert.equal((await call("merge.answer", { project: k.repo.root, entry: "mq_x", answer }, who)).error?.code, "forbidden", `${answer} by ${JSON.stringify(who)}`);
      }
      assert.notEqual((await call("merge.names", { project: k.repo.root, action: "show" }, session(thread))).error?.code, "forbidden", "the interview's own steps stay the thread's");
      assert.equal((await call("merge.names", { project: k.repo.root, action: "allow" }, { kind: "operator" })).error?.code, "invalid-request", "the user's page reaches it (nothing holds the push here)");
    } finally {
      await k.done();
    }
  });
});

describe("the queue pausing itself", () => {
  test("one notification per pause: the folder in its title, the reason as its body, a tap to the tab", async () => {
    const { pausedPush } = await import("./notices");
    const a = pausedPush({ kind: "machine", why: "setup fails on master alone too", at: "2026-11-02T10:00:00Z" }, "/home/u/proj", "p1");
    assert.deepEqual([a.title, a.body, a.hash], ["The merge queue paused · proj", "Setup fails on master alone too", "#/projects/p1/merge-queue"]);
    const b = pausedPush({ kind: "machine", why: "x", at: "2026-11-02T11:00:00Z" }, "/home/u/proj", "p1");
    assert.notEqual(a.tag, b.tag, "a later pause notifies again");
  });

  test("the queue calls it for its own pauses only, never the user's", async () => {
    const paused: string[] = [];
    const k = makeKit({ deps: { pausedSelf: (p) => void paused.push(p.kind) } });
    try {
      const q = await k.q();
      await q.pause("me");
      assert.deepEqual(paused, []);
    } finally {
      await k.done();
    }
  });
});

describe("the scan right before a push", () => {
  test("one that can't look holds the push with its reason and tells the user; the landing itself goes on", async () => {
    const alerts: string[] = [];
    // git can't list what the remote lacks: the scan can't look, so nothing is pushed.
    const failing: typeof realGit = (args, cwd, o) => (args[0] === "rev-list" && args[1] === "--reverse" ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: bad range" }) : realGit(args, cwd, o));
    const k = makeKit({ deps: { git: failing, alert: (a) => void alerts.push(a.body) } });
    try {
      const q = await k.q();
      k.repo.branch("feat/u", { "u.txt": "u\n" });
      const { entry } = await q.add({ branch: "feat/u", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "landed", "landed");
      // The landing is recorded before its push is tried: wait for the push's outcome.
      const v = await until(async () => {
        const x = await q.view();
        return x.heads.pushWhy ? x : null;
      }, "the push held");
      assert.notEqual(sh(k.repo.origin, "rev-parse", k.repo.target), k.repo.head(), "not pushed");
      assert.match(v.heads.pushWhy ?? "", /couldn't list/);
      assert.equal(v.heads.pushScan?.state, "unreadable");
      assert.equal(alerts.length, 1);
      assert.match(alerts[0]!, /couldn't look/);
      const held = q.events({ entry: entry.id }).events.find((x) => x.kind === "names" && x.step === "push");
      assert.match(held?.why ?? "", /wasn't pushed: the scan before pushing couldn't look \(/, "never recorded as a find");
    } finally {
      await k.done();
    }
  });
});

describe("the scan right before a first push", () => {
  test("a remote without the target branch yet: what no remote ref holds is scanned, and a hit holds the push", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      sh(k.repo.origin, "update-ref", "-d", `refs/heads/${k.repo.target}`);
      k.repo.branch("feat/k", { "k.ts": "const k = 'AKIA" + "ABCDEFGHIJKLMNOP';\n" });
      const { entry } = await q.add({ branch: "feat/k", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "landed", "landed");
      const v = await until(async () => {
        const x = await q.view();
        return x.heads.pushWhy ? x : null;
      }, "the push held");
      assert.equal(sh(k.repo.root, "ls-remote", k.repo.origin, `refs/heads/${k.repo.target}`), "", "nothing pushed");
      assert.equal(v.heads.pushScan?.state, "hits");
      assert.match(v.heads.pushWhy ?? "", /found 1 thing that looks private/);
    } finally {
      await k.done();
    }
  });
});

describe("a branch published by request or by push", () => {
  test("a hit holds it before anything is published; Allow publishes it, with the publication's own scan skipping the allowed match", async () => {
    const { k, decided } = namesKit();
    try {
      const q = await k.q();
      writeOverride(q.store.dir, "push-branch");
      const b = k.repo.branch("feat/pb", { "pb.txt": `${SECRET_NAME}\n` });
      const { entry } = await q.add({ branch: "feat/pb", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "needs-user", "held for names");
      assert.equal((await k.entry(entry.id)).decision?.kind, "private-names");
      assert.deepEqual(decided, ["private-names"]);
      assert.equal(sh(k.repo.root, "ls-remote", k.repo.origin, "refs/heads/feat/pb"), "", "nothing published");
      await q.answer(entry.id, "allow");
      await until(async () => (await k.entry(entry.id)).state === "pushed", "pushed after Allow");
      assert.equal(sh(k.repo.origin, "rev-parse", "refs/heads/feat/pb"), b.head);
    } finally {
      await k.done();
    }
  });
});
