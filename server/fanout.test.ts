// Run: npx tsx --test server/fanout.test.ts
// The fanout route's rules, with every SDK/disk/store touch injected: no agent dir, no runtime.
//
// The invariants worth more than the rest, all asserted on what the fakes RECORDED, not on the
// response alone: a refused source creates nothing; a member that fails mid-creation has its own
// file removed and nothing else; a created member is never unmade.
import assert from "node:assert/strict";
import { test } from "node:test";

const { planFanout, planMembers, runFanout } = await import("./fanout");
import type { FanoutDeps } from "./fanout";
import type { FanoutRequest, SessionGroup, SessionSummary } from "../shared/protocol";

const SOURCE = "/sessions/--tmp--/2026-09-20T00-00-00-000Z_01a0-source.jsonl";
const LEAF = "e9";

const summaryOf = (path: string): SessionSummary =>
  ({ id: path.split("_").pop()!.replace(".jsonl", ""), path, cwd: "/tmp", title: "t", createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false }) as SessionSummary;

interface Recorder {
  forked: string[];
  freshed: string[];
  discarded: string[];
  groups: { name: string; seed?: unknown; autoDissolve?: boolean }[];
  assigned: [string, string, string][];
  prompted: [string, string][];
  deleted: string[];
}

function deps(over: Partial<FanoutDeps> = {}): FanoutDeps & { rec: Recorder } {
  const rec: Recorder = { forked: [], freshed: [], discarded: [], groups: [], assigned: [], prompted: [], deleted: [] };
  let n = 0;
  // path → the member that made it, so the default read-back answers with the model the plan
  // chose (the mismatch guard below has its own tests that override `summary`). fork/fresh are
  // destructured OUT of `over` and wrapped below: spreading them back would replace the wrapper
  // and silently drop the registration, which the guard would then misreport as a mismatch.
  const { fork: overrideFork, fresh: overrideFresh, ...rest } = over;
  const refOf = new Map<string, string>();
  return {
    rec,
    knownRefs: async () => new Set(["anthropic/opus", "openai/gpt-5"]),
    validateCwd: async () => null,
    resolveSource: (raw) => (raw.endsWith(".jsonl") && raw.startsWith("/sessions/") ? raw : null),
    sourceHead: async () => ({ version: 3, leafId: LEAF }),
    live: () => false,
    streaming: () => false,
    foreignWriter: () => false,
    misconfigured: () => false,
    async fork(src, leaf, member) {
      const path = overrideFork ? await overrideFork(src, leaf, member) : `/sessions/--tmp--/m${++n}_id${n}.jsonl`;
      refOf.set(path, member.ref);
      rec.forked.push(`${member.ref}->${path}`);
      return path;
    },
    async fresh(cwd, member) {
      const path = overrideFresh ? await overrideFresh(cwd, member) : `/sessions/--tmp--/f${++n}_id${n}.jsonl`;
      refOf.set(path, member.ref);
      rec.freshed.push(`${member.ref}@${cwd}->${path}`);
      return path;
    },
    discard: (path) => rec.discarded.push(path),
    summary: async (path) => ({ ...summaryOf(path), model: refOf.get(path) ?? null }),
    createGroup(name, seed, autoDissolve) {
      rec.groups.push({ name, seed, autoDissolve });
      return { id: "g1", name, createdAt: "2026-09-22T00:00:00.000Z", members: [], ...(seed ? { seed } : {}) };
    },
    group: () => null, // no target unless a test provides one
    adoptSeed: (id, seed) => ({ id, name: "Target", createdAt: "2026-09-22T00:00:00.000Z", members: [], seed }),
    deleteGroup: (id) => rec.deleted.push(id),
    assign: (s, g, l) => rec.assigned.push([s, g, l]),
    async prompt(g, t) {
      rec.prompted.push([g, t]);
      return { ok: true, result: { sent: [], failed: [] } };
    },
    ...rest,
  };
}

const forkBody = (over: Partial<FanoutRequest> = {}): FanoutRequest => ({
  name: "Compare",
  members: [{ ref: "anthropic/opus", count: 2 }],
  source: { path: SOURCE, leafId: LEAF },
  ...over,
});

test("planMembers expands counts in pane order and only numbers a ref that repeats", () => {
  const planned = planMembers([
    { ref: "anthropic/opus", count: 2 },
    { ref: "openai/gpt-5", count: 1 },
  ]);
  assert.deepEqual(
    planned.map((m) => [m.ref, m.label]),
    [
      ["anthropic/opus", "anthropic/opus #1"],
      ["anthropic/opus", "anthropic/opus #2"],
      ["openai/gpt-5", "openai/gpt-5"],
    ],
  );
  assert.deepEqual(planned[0], { ref: "anthropic/opus", provider: "anthropic", modelId: "opus", label: "anthropic/opus #1" });
});

test("400s: name, members, counts, unknown refs, and the source/cwd exclusivity", async () => {
  const d = deps();
  const bad: [Partial<FanoutRequest>, RegExp][] = [
    [{ name: "  " }, /name must be/],
    [{ members: [] }, /non-empty/],
    [{ members: [{ ref: "opus", count: 1 }] }, /provider\/model/],
    [{ members: [{ ref: "anthropic/opus", count: 0 }] }, /1–9/],
    [{ members: [{ ref: "anthropic/opus", count: 10 }] }, /1–9/],
    [{ members: [{ ref: "anthropic/nope", count: 1 }] }, /No such model/],
    [{ source: undefined }, /exactly one/],
    [{ cwd: "/tmp" }, /exactly one/],
    [{ text: "hi" }, /fresh mode/],
  ];
  for (const [over, re] of bad) {
    const r = await planFanout(forkBody(over), d);
    assert.ok(!r.ok, JSON.stringify(over));
    assert.match(r.error, re);
  }
  // fresh mode needs a message, and a real cwd
  const noText = await planFanout({ name: "n", members: [{ ref: "anthropic/opus", count: 1 }], cwd: "/tmp" }, d);
  assert.ok(!noText.ok && /first message/.test(noText.error));
});

test("fork mode: one member per planned row, the group carries the seed, labels ride along", async () => {
  const d = deps();
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 2 }, { ref: "openai/gpt-5", count: 1 }] }), d);
  assert.ok(r.ok);
  assert.equal(r.result.created.length, 3);
  assert.deepEqual(r.result.failed, []);
  // No `named` in this body, so the name is treated as the user's: recorded false.
  assert.deepEqual(d.rec.groups, [{ name: "Compare", seed: { parentSessionPath: SOURCE, leafId: LEAF }, autoDissolve: false }]);
  assert.deepEqual(r.result.group.seed, { parentSessionPath: SOURCE, leafId: LEAF });
  assert.deepEqual(
    d.rec.assigned.map(([, g, label]) => [g, label]),
    [["g1", "anthropic/opus #1"], ["g1", "anthropic/opus #2"], ["g1", "openai/gpt-5"]],
  );
  assert.deepEqual(d.rec.discarded, [], "nothing to clean up");
  assert.deepEqual(d.rec.prompted, [], "fork mode sends no first message");
});

test("fresh mode: N independent sessions, NO seed, and the first message goes through the batch path", async () => {
  const d = deps();
  const r = await runFanout({ name: "Three", members: [{ ref: "anthropic/opus", count: 3 }], cwd: "/work", text: "start here" }, d);
  assert.ok(r.ok);
  assert.equal(d.rec.freshed.length, 3);
  assert.deepEqual(d.rec.forked, [], "no branching: there is no shared root");
  assert.equal(r.result.group.seed, undefined, "no fork point to align to");
  assert.deepEqual(d.rec.groups[0]!.seed, undefined);
  assert.equal(d.rec.groups[0]!.autoDissolve, false, "no `named`: the name is the user's until they say otherwise");
  assert.deepEqual(d.rec.prompted, [["g1", "start here"]]);
});

test("fresh mode: a cwd the New Session path would refuse is a 400 before anything is made", async () => {
  // Fresh mode IS that path N times, so it answers with that path's own sentences — not an
  // N-times-repeated "internal" member failure after the group was already half-written.
  const d = deps({ validateCwd: async () => "cwd does not exist" });
  const r = await runFanout({ name: "n", members: [{ ref: "anthropic/opus", count: 2 }], cwd: "/nope", text: "hi" }, d);
  assert.ok(!r.ok && r.status === 400);
  assert.equal(r.error, "cwd does not exist", "POST /api/sessions' own sentence");
  assert.deepEqual(d.rec.freshed, [], "not one member was created");
  assert.deepEqual(d.rec.groups, [], "no group was written");
});

test("fresh mode's first message is folded into failed when the batch refuses EVERY member", async () => {
  // The 201 keeps every member — they are real, empty, grouped sessions — and says which of
  // them did not start, instead of announcing a success that lands the user in N silent panes.
  const d = deps({
    prompt: async () => ({
      ok: false as const,
      status: 409 as const,
      refused: [
        { id: "id1", path: "/sessions/--tmp--/f1_id1.jsonl", code: "busy", message: "Another process wrote to it just now." },
        { id: "id2", path: "/sessions/--tmp--/f2_id2.jsonl", code: "mid-turn", message: "It is mid-turn here." },
      ],
    }),
  });
  const r = await runFanout({ name: "Two", members: [{ ref: "anthropic/opus", count: 2 }], cwd: "/work", text: "go" }, d);
  assert.ok(r.ok, "the members exist; the batch's refusal is an outcome, not a route failure");
  assert.equal(r.result.created.length, 2, "nothing that exists is rolled back");
  assert.deepEqual(
    r.result.failed.map((f) => [f.id, f.path, f.code, f.ref]),
    [
      ["id1", "/sessions/--tmp--/f1_id1.jsonl", "busy", "anthropic/opus"],
      ["id2", "/sessions/--tmp--/f2_id2.jsonl", "mid-turn", "anthropic/opus"],
    ],
    "the batch's own vocabulary, with the model named beside the id",
  );
  assert.ok(r.result.failed.every((f) => f.message.trim().length > 0), "the reason is never blank");
});

test("a member refused its first message keeps its id AND gains the ref; a pre-existing member keeps no ref", async () => {
  // Two shapes live in `failed` on this route: empty id = never came into being; id set = exists
  // but did not start. A member of the target group that this fanout did NOT create (the
  // `groupId` path prompts the whole group) reports with its id only — its model is not this
  // fanout's to claim.
  const d = deps({
    group: () => ({ id: "g-existing", name: "Handmade", createdAt: "2026-09-22T00:00:00.000Z", members: [{ id: "old" }] }) as never,
    prompt: async () => ({
      ok: false as const,
      status: 409 as const,
      refused: [
        { id: "id1", path: "/sessions/--tmp--/f1_id1.jsonl", code: "busy", message: "Another process wrote to it just now." },
        { id: "old", path: "/sessions/--tmp--/old.jsonl", code: "mid-turn", message: "It is mid-turn here." },
      ],
    }),
  });
  const r = await runFanout({ members: [{ ref: "anthropic/opus", count: 1 }], cwd: "/work", text: "go", groupId: "g-existing" }, d);
  assert.ok(r.ok);
  assert.deepEqual(
    r.result.failed.map((f) => [f.id, f.ref]),
    [
      ["id1", "anthropic/opus"],
      ["old", undefined],
    ],
  );
});

test("a partial first-message send folds its failed entries the same way", async () => {
  const d = deps({
    prompt: async () => ({
      ok: true as const,
      result: { sent: ["id1"], failed: [{ id: "id2", path: "/sessions/--tmp--/f2_id2.jsonl", code: "internal", message: "The queue refused it." }] },
    }),
  });
  const r = await runFanout({ name: "Two", members: [{ ref: "anthropic/opus", count: 2 }], cwd: "/work", text: "go" }, d);
  assert.ok(r.ok);
  assert.equal(r.result.created.length, 2);
  assert.deepEqual(r.result.failed, [
    { id: "id2", path: "/sessions/--tmp--/f2_id2.jsonl", code: "internal", message: "The queue refused it.", ref: "anthropic/opus" },
  ]);
});

test("a batch outcome this route cannot reach still becomes a visible failed entry, never a swallow", async () => {
  const d = deps({ prompt: async () => ({ ok: false as const, status: 400 as const, error: "Group has no members" }) });
  const r = await runFanout({ name: "Two", members: [{ ref: "anthropic/opus", count: 2 }], cwd: "/work", text: "go" }, d);
  assert.ok(r.ok, "the members exist; the outcome is reported, not raised over them");
  assert.deepEqual(r.result.failed, [{ id: "", path: "", code: "internal", message: "Group has no members" }]);
});

test("every source refusal is a 409 naming the source, and NOTHING is created", async () => {
  const cases: [Partial<FanoutDeps>, string][] = [
    [{ live: () => true }, "tui-live"],
    [{ streaming: () => true }, "mid-turn"],
    [{ foreignWriter: () => true }, "busy"],
    [{ misconfigured: () => true }, "config"],
    [{ sourceHead: async () => ({ version: 2, leafId: LEAF }) }, "old-format"],
    [{ sourceHead: async () => ({ version: 3, leafId: "moved-on" }) }, "stale-leaf"],
    [{ sourceHead: async () => null }, "missing"],
  ];
  for (const [over, code] of cases) {
    const d = deps(over);
    const r = await runFanout(forkBody(), d);
    assert.ok(!r.ok && r.status === 409, code);
    assert.equal(r.refused.length, 1, "exactly one entry, the source");
    assert.equal(r.refused[0]!.code, code);
    assert.ok(r.refused[0]!.message.trim().length > 0);
    assert.deepEqual(d.rec.forked, [], `${code}: not one member was created`);
    assert.deepEqual(d.rec.groups, [], `${code}: no group was written`);
  }
});

test("a member that fails mid-creation loses its OWN file and nothing else", async () => {
  let n = 0;
  const d = deps({
    async fork(_s, _l, member) {
      n++;
      if (n === 2) {
        // it got as far as a file, then died: that file is the debris
        throw Object.assign(new Error("model refused"), { path: "/sessions/--tmp--/half_id2.jsonl" });
      }
      return `/sessions/--tmp--/m${n}_id${n}.jsonl`;
    },
  });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 3 }] }), d);
  assert.ok(r.ok, "the survivors are a result, not a failure");
  assert.equal(r.result.created.length, 2);
  assert.equal(r.result.failed.length, 1);
  assert.equal(r.result.failed[0]!.message, "model refused", "the server's bare reason, for the banner to quote");
  assert.equal(r.result.failed[0]!.code, "internal");
  // The ONLY handle on a member that was never created: no session, so no id and no path.
  assert.equal(r.result.failed[0]!.ref, "anthropic/opus", "so the banner can name the model");
  assert.equal(r.result.failed[0]!.id, "");
  assert.equal(r.result.failed[0]!.path, "");
  assert.deepEqual(d.rec.discarded, [], "the throw produced no path for us to clean");
  assert.equal(d.rec.assigned.length, 2, "only the members that exist are grouped");
});

test("a member whose read-back fails has its file discarded", async () => {
  const d = deps({ summary: async (path) => (path.startsWith("/sessions/--tmp--/m2") ? null : { ...summaryOf(path), model: "anthropic/opus" }) });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 2 }] }), d);
  assert.ok(r.ok);
  assert.equal(r.result.created.length, 1);
  assert.deepEqual(d.rec.discarded, ["/sessions/--tmp--/m2_id2.jsonl"], "its own half-written file, removed");
  assert.equal(d.rec.assigned.length, 1, "the one that exists is untouched and grouped");
});

test("a member whose file does not record the PLANNED model is failed, never silently defaulted", async () => {
  // N1's live failure, held shut: a member whose model_change never reached the disk opens with
  // the runtime's default and answers as a model nobody chose. The read-back turns that into a
  // `failed` entry naming both models, and the member's own file is unlinked as debris.
  const d = deps({ summary: async (path) => ({ ...summaryOf(path), model: path.includes("f2") ? "ollama-cloud/deepseek-v4.1-flash" : "anthropic/opus" }) });
  const r = await runFanout({ name: "Two", members: [{ ref: "anthropic/opus", count: 2 }], cwd: "/work", text: "go" }, d);
  assert.ok(r.ok, "the member that recorded its model is a result");
  assert.equal(r.result.created.length, 1);
  assert.equal(r.result.failed.length, 1);
  assert.equal(r.result.failed[0]!.ref, "anthropic/opus");
  assert.match(r.result.failed[0]!.message, /ollama-cloud\/deepseek-v4\.1-flash.*anthropic\/opus|recorded model/);
  assert.ok(/recorded model/.test(r.result.failed[0]!.message), "the sentence says WHICH model the file wrongly names");
  assert.deepEqual(d.rec.discarded, ["/sessions/--tmp--/f2_id2.jsonl"], "a member that never became the planned member is debris");
});

test("a mid-batch failure does not shift the labels of the members behind it", async () => {
  // created[] skips failures, so pairing it with planned[i] would hand member #3 the label of
  // the failed #2 — pane names that lie about which session is behind them.
  let n = 0;
  const d = deps({
    async fork(_s, _l) {
      n++;
      if (n === 2) throw new Error("boom");
      return `/sessions/--tmp--/m${n}_id${n}.jsonl`;
    },
  });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 3 }] }), d);
  assert.ok(r.ok);
  assert.deepEqual(
    d.rec.assigned.map(([, , label]) => label),
    ["anthropic/opus #1", "anthropic/opus #3"],
    "each survivor keeps ITS number, not the slot's",
  );
});

test("the response's group is read back AFTER assigning, so it carries the members just landed", async () => {
  // Caught live: a 201 whose group.members was empty beside a created member — the store object
  // was returned from before the assignments that made it a group.
  const store = new Map<string, SessionGroup>();
  const d = deps({
    createGroup(name, seed, autoDissolve) {
      const g = { id: "g1", name, createdAt: "2026-09-22T00:00:00.000Z", members: [], ...(seed ? { seed } : {}), ...(autoDissolve !== undefined ? { autoDissolve } : {}) } as SessionGroup;
      store.set("g1", g);
      return g;
    },
    group: (id) => store.get(id) ?? null,
    assign: (sessionId, groupId, label) => {
      store.get(groupId)!.members!.push({ id: sessionId, ...(label ? { label } : {}) });
    },
  });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 2 }] }), d);
  assert.ok(r.ok);
  assert.deepEqual((r.result.group.members ?? []).map((m) => m.id), r.result.created.map((s) => s.id), "the one response the client navigates on tells the truth");
});

test("if not one member could be made, no group is written at all", async () => {
  const d = deps({
    fork: async () => {
      throw new Error("everything is on fire");
    },
  });
  const r = await runFanout(forkBody(), d);
  assert.ok(!r.ok && r.status === 500);
  assert.match(r.error, /on fire/);
  assert.deepEqual(d.rec.groups, [], "a group with no members is debris, not a result");
});

test("a source path that is not a session file is 404, not a refusal", async () => {
  const d = deps();
  const r = await runFanout(forkBody({ source: { path: "/etc/passwd", leafId: LEAF } }), d);
  assert.ok(!r.ok && r.status === 404, "the subject of the request doesn't exist");
  assert.deepEqual(d.rec.forked, []);
});

test("a member that fails its read-back is also named by ref, not by a session it never had", async () => {
  const d = deps({ summary: async () => null });
  const r = await runFanout(forkBody({ members: [{ ref: "openai/gpt-5", count: 2 }] }), d);
  assert.ok(!r.ok && r.status === 500, "no member survived, so no group is written");
});

test("every fanout failure carries a ref; a prompt-route refusal carries none", async () => {
  const d = deps({
    fork: async (_s, _l, member) => {
      throw new Error(`${member.ref} is over quota`);
    },
  });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 1 }, { ref: "openai/gpt-5", count: 1 }] }), d);
  assert.ok(!r.ok && r.status === 500);
  // and when SOME survive, each failure names its own model
  const partial = deps({
    fork: async (_s, _l, member) => {
      if (member.ref === "openai/gpt-5") throw new Error("over quota");
      return "/sessions/--tmp--/ok_id1.jsonl";
    },
  });
  const p = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 1 }, { ref: "openai/gpt-5", count: 1 }] }), partial);
  assert.ok(p.ok);
  assert.deepEqual(
    p.result.failed.map((f) => [f.ref, f.message]),
    [["openai/gpt-5", "over quota"]],
  );
});

test("a creation failure with no message still carries a sentence", async () => {
  // The ref prefix was stripped from this message so the banner doesn't render the model twice,
  // which makes a bare reason the case most likely to arrive empty — and §14 has the client show
  // `message` verbatim for a code it doesn't recognise, so an empty one would drop the reason.
  const d = deps({
    fork: async (_s, _l, member) => {
      if (member.ref === "openai/gpt-5") throw new Error("   ");
      return "/sessions/--tmp--/ok_id1.jsonl";
    },
  });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 1 }, { ref: "openai/gpt-5", count: 1 }] }), d);
  assert.ok(r.ok);
  const failure = r.result.failed[0]!;
  assert.equal(failure.ref, "openai/gpt-5", "the model is still named");
  assert.ok(failure.message.trim().length > 0, "and the reason is never blank");
  // The banner reads "{model} couldn't start: {message}", so the fallback must answer WHY rather
  // than restate the clause before the colon ("opus couldn't start: it could not be started").
  assert.doesNotMatch(failure.message, /could not be started|couldn't start/i, "no stutter against the banner's own words");
});

// --- landing in an EXISTING group (groupId) -------------------------------------------------
// One group carries one seed, because the fork marker reads it. Every check below runs BEFORE
// any member is made, so a refusal leaves no sessions behind — asserted on the recorder, not
// just the response.

const THIS_SEED = { parentSessionPath: SOURCE, leafId: LEAF };
const existing = (over: Partial<{ name: string; seed: unknown }> = {}) =>
  ({ id: "g-existing", name: "Handmade", createdAt: "2026-09-22T00:00:00.000Z", members: [{ id: "old" }], ...over }) as never;

test("groupId: a seedless group ADOPTS this fanout's seed and takes the members", async () => {
  const adopted: unknown[] = [];
  const d = deps({
    group: () => existing(),
    adoptSeed: (id, seed) => {
      adopted.push([id, seed]);
      return { id, name: "Handmade", createdAt: "2026-09-22T00:00:00.000Z", members: [{ id: "old" }], seed };
    },
  });
  const r = await runFanout(forkBody({ name: undefined, groupId: "g-existing", members: [{ ref: "anthropic/opus", count: 2 }] }), d);
  assert.ok(r.ok);
  assert.deepEqual(adopted, [["g-existing", THIS_SEED]], "the group gains this fanout's lineage");
  assert.equal(r.result.group.id, "g-existing", "the EXISTING group is returned, not a new one");
  assert.deepEqual(r.result.group.seed, THIS_SEED);
  assert.deepEqual(d.rec.groups, [], "no group was created");
  assert.equal(d.rec.assigned.length, 2);
  assert.ok(d.rec.assigned.every(([, g]) => g === "g-existing"));
});

test("groupId: a MATCHING seed just appends, adopting nothing", async () => {
  const adopted: unknown[] = [];
  const d = deps({
    group: () => existing({ seed: THIS_SEED }),
    adoptSeed: (id, seed) => {
      adopted.push([id, seed]);
      return null;
    },
  });
  const r = await runFanout(forkBody({ name: undefined, groupId: "g-existing", members: [{ ref: "anthropic/opus", count: 1 }] }), d);
  assert.ok(r.ok);
  assert.deepEqual(adopted, [], "nothing to adopt: it already has this seed");
  assert.equal(r.result.group.id, "g-existing");
  assert.deepEqual(r.result.group.seed, THIS_SEED);
  assert.equal(d.rec.assigned.length, 1);
});

test("groupId: a DIFFERING seed is refused with seed-conflict, and nothing is created", async () => {
  const d = deps({ group: () => existing({ seed: { parentSessionPath: "/sessions/--tmp--/other.jsonl", leafId: "z9" } }) });
  const r = await runFanout(forkBody({ name: undefined, groupId: "g-existing" }), d);
  assert.ok(!r.ok && r.status === 400);
  assert.equal(r.code, "seed-conflict");
  assert.match(r.error, /one fork point/);
  assert.deepEqual(d.rec.forked, [], "refused before any member was made");
  assert.deepEqual(d.rec.assigned, []);
  assert.deepEqual(d.rec.groups, []);
});

test("groupId: an unknown group is 404, and nothing is created", async () => {
  const d = deps({ group: () => null });
  const r = await runFanout(forkBody({ name: undefined, groupId: "no-such-group" }), d);
  assert.ok(!r.ok && r.status === 404);
  assert.deepEqual(d.rec.forked, []);
  assert.deepEqual(d.rec.groups, []);
});

test("groupId: FRESH mode never adopts and never conflicts, and leaves the target's seed alone", async () => {
  const adopted: unknown[] = [];
  const other = { parentSessionPath: "/sessions/--tmp--/other.jsonl", leafId: "z9" };
  const d = deps({
    group: () => existing({ seed: other }),
    adoptSeed: (id, seed) => {
      adopted.push([id, seed]);
      return null;
    },
  });
  const r = await runFanout({ members: [{ ref: "anthropic/opus", count: 1 }], cwd: "/work", text: "go", groupId: "g-existing" }, d);
  assert.ok(r.ok, "fresh mode has no seed of its own, so there is nothing to conflict with");
  assert.deepEqual(adopted, []);
  assert.deepEqual(r.result.group.seed, other, "the target keeps the seed it had");
  assert.equal(d.rec.freshed.length, 1);
});

test("groupId must be a non-empty string", async () => {
  for (const bad of [7, "", null]) {
    const r = await planFanout(forkBody({ name: undefined, groupId: bad as never }), deps());
    if (bad === null) continue; // null is JSON's absent-ish; the route rejects non-strings
    assert.ok(!r.ok, JSON.stringify(bad));
    assert.match(r.error, /groupId/);
  }
});

test("exactly one of name and groupId: both is a 400, neither is a 400", async () => {
  // Silently ignoring `name` when landing in an existing group would read as a rename that
  // didn't take — so a client asking for both is told, rather than half-served.
  const both = await planFanout(forkBody({ groupId: "g-existing" }), deps());
  assert.ok(!both.ok && /exactly one of name or groupId/.test(both.error));
  const neither = await planFanout(forkBody({ name: undefined }), deps());
  assert.ok(!neither.ok && /exactly one of name or groupId/.test(neither.error));
  // and a name is not validated when it isn't being used
  const ok = await planFanout(forkBody({ name: undefined, groupId: "g-existing" }), deps());
  assert.ok(ok.ok, "landing in an existing group needs no name at all");
});

// --- who named the group (`named` → autoDissolve) ------------------------------------
// pi-web may remove only what it both MADE and NAMED. The client reports which, because the
// server never generated the default and so cannot tell an accepted one from an identical string
// typed by hand.

test("the default accepted: pi-web named it, so the group dissolves when emptied", async () => {
  const d = deps();
  const r = await runFanout(forkBody({ named: "generated" }), d);
  assert.ok(r.ok);
  assert.equal(d.rec.groups[0]!.autoDissolve, true);
});

test("a name the user typed: recorded as NOT dissolving, explicitly", async () => {
  const d = deps();
  const r = await runFanout(forkBody({ named: "user" }), d);
  assert.ok(r.ok);
  assert.equal(d.rec.groups[0]!.autoDissolve, false, "false, not absent");
});

test("flag ABSENT is the safe answer: an older client never costs a user their name", async () => {
  // Absence means "client predates the field". It must not mean "pi-web named it", and it must
  // not be left unwritten either: absent-on-disk plus a seed is the signature the legacy rule
  // reads as a pre-flag fanout group, which would delete it.
  const d = deps();
  const r = await runFanout(forkBody(), d);
  assert.ok(r.ok);
  assert.equal(d.rec.groups[0]!.autoDissolve, false, "recorded false, so no later migration can re-infer dissolution");
});

test("every malformed `named` falls to the safe side, by construction", async () => {
  // Reviewer's table: `if (v)` is TRUE for "false", "yes", 1 and {} — the hazard a boolean field
  // would have carried, since truthiness is what a reader writes without thinking. `=== "generated"`
  // has no such case: anything that is not that exact token cannot claim the name.
  for (const bad of ["false", "yes", "user ", "GENERATED", 1, 0, {}, [], true, null]) {
    const d = deps();
    const r = await runFanout(forkBody({ named: bad as never }), d);
    assert.ok(r.ok, `named=${JSON.stringify(bad)} still creates`);
    assert.equal(d.rec.groups[0]!.autoDissolve, false, `named=${JSON.stringify(bad)} must not claim the name`);
  }
});

test("an unrecognised `named` is treated as absent, not as generated", async () => {
  const d = deps();
  const r = await runFanout(forkBody({ named: "Generated" as never }), d);
  assert.ok(r.ok);
  assert.equal(d.rec.groups[0]!.autoDissolve, false, "only the exact string \"generated\" claims the name");
});

test("the groupId path never sets the flag, whatever `named` says", async () => {
  // `group` mirrors what readGroup answers AFTER adoption (adoptGroupSeed writes
  // `autoDissolve ??= false`): the response's group is read back post-assignment now, so a fake
  // still answering the pre-adoption shape would test the fake, not the rule.
  let adoptedSeed: { parentSessionPath: string; leafId: string } | null = null;
  const d = deps({
    group: () =>
      adoptedSeed
        ? ({ id: "g-existing", name: "Handmade", createdAt: "2026-09-22T00:00:00.000Z", members: [], seed: adoptedSeed, autoDissolve: false } as const)
        : existing(),
    adoptSeed: (id, seed) => {
      adoptedSeed = seed;
      return { id, name: "Handmade", createdAt: "2026-09-22T00:00:00.000Z", members: [], seed, autoDissolve: false };
    },
  });
  const r = await runFanout(forkBody({ name: undefined, groupId: "g-existing", named: "generated" }), d);
  assert.ok(r.ok, "the flag is meaningless here: the target keeps its own name");
  assert.deepEqual(d.rec.groups, [], "no group was created, so nothing was flagged");
  assert.equal(r.result.group.autoDissolve, false, "the target's own value stands");
});
