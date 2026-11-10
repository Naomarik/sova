// POST /api/merge-queue/projects/:project/discard-branch (server/merge-queue/routes-landing.ts): page-only on both the
// dry run and the confirm, its body checked before anything runs, refusals as 409 {error: {code, message}}.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";
import type { Git } from "../pi-config/extensions/worktrees/git.ts";
import { discardNotPage, registerMergeLandingRoutes } from "./merge-queue/routes-landing";
import { DISCARD_WORDS, type DiscardDeps } from "./worktree-remove-discard";
import { CALLER_HEADER, TOKEN_HEADER } from "./auth";

const TIP = "a".repeat(40);

/** A repository with only its main checkout and one folderless branch at TIP; `ran` names each git call. */
function fakeDeps(o: { tip?: string | null } = {}) {
  const ran: string[] = [];
  const git: Git = async (args) => {
    ran.push(args.join(" "));
    if (args[0] === "worktree") return { code: 0, stdout: "worktree /repo\nHEAD 1\nbranch refs/heads/master\n", stderr: "" };
    if (args[0] === "rev-parse") return o.tip === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `${o.tip ?? TIP}\n`, stderr: "" };
    if (args[0] === "rev-list") return { code: 0, stdout: "1\n", stderr: "" };
    if (args[0] === "log") return { code: 0, stdout: "aaaaaaa\0work\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps = {
    git,
    target: async () => "master",
    openEntry: async () => null,
    owner: async () => null,
    chatBusy: () => false,
    workingSubagents: () => 0,
    uses: async () => ({ uses: [], unreadable: [] }),
    folderChats: async () => [],
    processes: async () => [],
    alive: () => false,
    leftovers: async () => ({ dirty: [], ignored: [], nested: [], rebuildable: [] }),
    digestOf: () => "",
    listingOf: () => null as never,
    draftNames: () => [],
    withAnyway: async (_f: string, _d: string, fn: () => Promise<unknown>) => fn(),
    lockFile: async () => "/repo/.git/sova-retire.lock",
    takeLock: () => true,
    dropLock: () => undefined,
    archive: async () => ({ ok: true as const }),
    close: async () => undefined,
    now: () => 0,
  } as DiscardDeps;
  return { deps, ran };
}

function setup(o: { tip?: string | null; notPage?: (c: import("hono").Context) => string | null } = {}) {
  const f = fakeDeps(o);
  const app = new Hono();
  registerMergeLandingRoutes(app, {
    queueOf: async () => null,
    queueOfEntry: async () => null,
    discard: { rootOf: async (id) => (id === "prj_1" ? "/repo" : null), deps: async () => f.deps, notPage: o.notPage ?? (() => null) },
  });
  const post = async (body: unknown, headers: Record<string, string> = {}, project = "prj_1") => {
    const r = await app.request(`/api/merge-queue/projects/${project}/discard-branch`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { post, ran: f.ran };
}

describe("POST …/discard-branch", () => {
  test("a chat, a script and the Overseer are refused on the dry run and the confirm alike, before any git runs", async () => {
    const t = setup({ notPage: discardNotPage });
    for (const headers of [{ [CALLER_HEADER]: "k" }, { [TOKEN_HEADER]: "t" }, {}] as Record<string, string>[])
      for (const body of [{ branch: "feat/x", commit: TIP, dryRun: true }, { branch: "feat/x", commit: TIP, digest: "" }]) {
        const r = await t.post(body, headers);
        assert.equal(r.status, 403, JSON.stringify(headers));
        assert.equal(r.body.error.code, "forbidden");
        assert.equal(r.body.error.message, "Only the user discards a branch. Ask them to press Discard Branch… in the Land menu. Nothing was deleted.");
        assert.equal(r.body.yourClick, true);
      }
    assert.deepEqual(t.ran, []);
  });

  test("a bad body is refused before anything runs", async () => {
    const t = setup();
    const bad = [
      {},
      { branch: "feat/x" },
      { branch: "-x", commit: TIP, dryRun: true },
      { branch: "a..b", commit: TIP, dryRun: true },
      { branch: "feat/x", commit: "abc", dryRun: true },
      { branch: "feat/x", commit: TIP, dryRun: false },
      { branch: "feat/x", commit: TIP },
      { branch: "feat/x", commit: TIP, dryRun: true, digest: "" },
      { branch: "feat/x", commit: TIP, digest: "not hex" },
    ];
    for (const b of bad) assert.equal((await t.post(b)).status, 400, JSON.stringify(b));
    assert.equal((await t.post({ branch: "feat/x", commit: TIP, dryRun: true }, {}, "prj_nope")).status, 404);
    assert.deepEqual(t.ran, []);
  });

  test("the dry run answers the preview; a refusal on the confirm is a 409 with its words", async () => {
    const t = setup();
    const p = await t.post({ branch: "feat/x", commit: TIP, dryRun: true });
    assert.equal(p.status, 200);
    assert.equal(p.body.refused, null);
    assert.deepEqual(p.body.commits, { count: 1, shown: [{ sha: "aaaaaaa", subject: "work" }] });
    assert.equal(p.body.folder, null);
    const moved = setup({ tip: "b".repeat(40) });
    assert.equal((await moved.post({ branch: "feat/x", commit: TIP, dryRun: true })).body.refused, DISCARD_WORDS.moved);
    assert.deepEqual(await moved.post({ branch: "feat/x", commit: TIP, digest: "" }), { status: 409, body: { error: { code: "refused", message: DISCARD_WORDS.moved } } });
  });

  test("the confirm answers each step", async () => {
    const t = setup();
    const r = await t.post({ branch: "feat/x", commit: TIP, digest: "" });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "discarded");
    assert.deepEqual(r.body.steps.map((s: { step: string; state: string }) => `${s.step}:${s.state}`), ["folder:skipped", "branch:done", "chat:skipped"]);
    assert.ok(t.ran.some((l) => l.includes(`update-ref -d refs/heads/feat/x ${TIP}`)));
  });
});
