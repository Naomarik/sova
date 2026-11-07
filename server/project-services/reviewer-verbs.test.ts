// Run: pnpm test -- server/project-services/reviewer-verbs.test.ts. A merge reviewer's project_verbs (§app.merge-queue/review):
// it reads and answers merge.review, and every other verb is refused before the engine sees it, so it can never run
// the branch's code through `test`, start a copy or share one. Known by its own profile record (Sova's
// merge-reviewer), never by its title; any other session is as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MERGE_VERBS, RELEASE_VERBS, DEPLOY_VERBS, VERBS } from "../../shared/project-contract";
import { PROFILE } from "../harness/state-kinds";
import type { ProjectEngine } from "./engine";
import { REVIEWER_TOOL_VERBS, sessionVerbsTool } from "./tools";

function harness() {
  const ran: string[] = [];
  const engine = {
    async run(verb: string) {
      ran.push(verb);
      return { ok: true, changed: false, state: null, steps: [], services: [], data: [], links: [] };
    },
  } as unknown as ProjectEngine;
  const tool = sessionVerbsTool(() => engine);
  const ctx = (profile: unknown) =>
    ({ sessionId: "s", cwd: "/nowhere", leafId: () => null, branch: () => [], state: () => ({ latest: (k: unknown) => (k === PROFILE && profile ? { data: { v: 1, profile } } : null) }) }) as never;
  const call = async (verb: string, profile: unknown) => {
    const r = (await tool.execute("t", { verb, project: "/nowhere", run: "mr_1" }, undefined, undefined, ctx(profile))) as { content: { text: string }[]; details: { result: { error?: { code: string } } } };
    return { text: r.content[0]!.text, code: r.details.result?.error?.code };
  };
  return { ran, call };
}

const REVIEWER = { source: "sova", id: "merge-reviewer" };

test("a merge reviewer may call the reads and merge.review, and nothing else reaches the engine", async () => {
  const { ran, call } = harness();
  const all = [...VERBS, ...MERGE_VERBS, ...RELEASE_VERBS, ...DEPLOY_VERBS];
  for (const verb of all) {
    const before = ran.length;
    const r = await call(verb, REVIEWER);
    if (REVIEWER_TOOL_VERBS.includes(verb)) assert.equal(ran.length, before + 1, `${verb} reaches the engine`);
    else {
      assert.equal(ran.length, before, `${verb} must not reach the engine`);
      assert.equal(r.code, "forbidden", verb);
      assert.match(r.text, /merge reviewer only reads/);
    }
  }
  for (const v of ["test", "up", "apply", "create", "share", "merge.try", "merge.resolve", "release.step"]) assert.ok(!REVIEWER_TOOL_VERBS.includes(v), v);
  assert.ok(REVIEWER_TOOL_VERBS.includes("merge.review"));
});

test("only Sova's merge-reviewer profile is held to that: the merge thread, a user's profile of the same id and an ordinary chat are not", async () => {
  const { ran, call } = harness();
  for (const profile of [{ source: "sova", id: "merge-thread" }, { source: "user", id: "merge-reviewer" }, null]) {
    const before = ran.length;
    await call("test", profile);
    assert.equal(ran.length, before + 1, JSON.stringify(profile));
  }
});
