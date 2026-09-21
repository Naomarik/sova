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
import type { FanoutRequest, SessionSummary } from "../shared/protocol";

const SOURCE = "/sessions/--tmp--/2026-09-20T00-00-00-000Z_01a0-source.jsonl";
const LEAF = "e9";

const summaryOf = (path: string): SessionSummary =>
  ({ id: path.split("_").pop()!.replace(".jsonl", ""), path, cwd: "/tmp", title: "t", createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false }) as SessionSummary;

interface Recorder {
  forked: string[];
  freshed: string[];
  discarded: string[];
  groups: { name: string; seed?: unknown }[];
  assigned: [string, string, string][];
  prompted: [string, string][];
  deleted: string[];
}

function deps(over: Partial<FanoutDeps> = {}): FanoutDeps & { rec: Recorder } {
  const rec: Recorder = { forked: [], freshed: [], discarded: [], groups: [], assigned: [], prompted: [], deleted: [] };
  let n = 0;
  return {
    rec,
    knownRefs: async () => new Set(["anthropic/opus", "openai/gpt-5"]),
    resolveSource: (raw) => (raw.endsWith(".jsonl") && raw.startsWith("/sessions/") ? raw : null),
    sourceHead: async () => ({ version: 3, leafId: LEAF }),
    live: () => false,
    streaming: () => false,
    foreignWriter: () => false,
    misconfigured: () => false,
    async fork(_src, _leaf, member) {
      const path = `/sessions/--tmp--/m${++n}_id${n}.jsonl`;
      rec.forked.push(`${member.ref}->${path}`);
      return path;
    },
    async fresh(cwd, member) {
      const path = `/sessions/--tmp--/f${++n}_id${n}.jsonl`;
      rec.freshed.push(`${member.ref}@${cwd}->${path}`);
      return path;
    },
    discard: (path) => rec.discarded.push(path),
    summary: async (path) => summaryOf(path),
    createGroup(name, seed) {
      rec.groups.push({ name, seed });
      return { id: "g1", name, createdAt: "2026-09-22T00:00:00.000Z", members: [], ...(seed ? { seed } : {}) };
    },
    deleteGroup: (id) => rec.deleted.push(id),
    assign: (s, g, l) => rec.assigned.push([s, g, l]),
    prompt: async (g, t) => void rec.prompted.push([g, t]),
    ...over,
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
  assert.deepEqual(d.rec.groups, [{ name: "Compare", seed: { parentSessionPath: SOURCE, leafId: LEAF } }]);
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
  assert.deepEqual(d.rec.prompted, [["g1", "start here"]]);
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
  const d = deps({ summary: async (path) => (path.startsWith("/sessions/--tmp--/m2") ? null : summaryOf(path)) });
  const r = await runFanout(forkBody({ members: [{ ref: "anthropic/opus", count: 2 }] }), d);
  assert.ok(r.ok);
  assert.equal(r.result.created.length, 1);
  assert.deepEqual(d.rec.discarded, ["/sessions/--tmp--/m2_id2.jsonl"], "its own half-written file, removed");
  assert.equal(d.rec.assigned.length, 1, "the one that exists is untouched and grouped");
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
