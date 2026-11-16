// Which model each playbook role gets (§chat.playbooks/model-order): the order rule over every
// combination of what can run, "only these models", the reason words, and the whole chain kept.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerChoice } from "./protocol";
import { resolveCast, resolveRoleModel, type ResolveContext } from "./playbook-models";
import { parsePlaybookSpec, type PlaybookSpec } from "./playbook-format";

const m = (model: string, backend: WorkerChoice["backend"] = "pi", effort = "high"): WorkerChoice => ({ backend, model, effort });
const P = m("pick/p"), A = m("list/a"), B = m("list/b"), R = m("prof/r"), F = m("prof/f"), C = m("chat/c");
const NAMES: Record<string, string> = { "pick/p": "P", "list/a": "A", "list/b": "B", "prof/r": "R", "prof/f": "F", "chat/c": "C" };
const ctx = (off: Set<string>): ResolveContext => ({
  routes: { planning: { primary: R, fallback: F } },
  chat: C,
  denial: (c) => (off.has(c.model) ? "is turned off in Settings → Models" : null),
  name: (c) => NAMES[c.model] ?? c.model,
});

test("rule: the first model that can run wins, in the order pick, list, profile, chat; only-roles stop after the list", () => {
  const all = [P, A, B, R, F, C];
  for (let mask = 0; mask < 1 << all.length; mask++) {
    const off = new Set(all.filter((_, i) => mask & (1 << i)).map((c) => c.model));
    for (const only of [false, true]) for (const pickOnList of [false, true]) {
      const pick = pickOnList ? m("list/b", "pi", "low") : P;
      const r = resolveRoleModel({ pick, list: [A, B], only, kind: "planning" }, ctx(off));
      // By hand: the order the promise states.
      const pickAllowed = !only || pickOnList;
      const order = [...(pickAllowed ? [pick] : []), A, B, ...(only ? [] : [R, F, C])];
      const want = order.find((c) => !off.has(c.model)) ?? null;
      const label = `off=${[...off].join(",")} only=${only} pickOnList=${pickOnList}`;
      assert.deepEqual(r.use, want, label);
      assert.equal(r.use === null, r.blocked !== undefined, `blocked iff no model: ${label}`);
      if (only) assert.ok(r.source !== "profile" && r.source !== "chat", `only never falls through: ${label}`);
      // Nothing is swapped silently: a reason whenever it isn't the first choice, none when it is.
      const first = r.chain[0]!.choice;
      if (r.use) assert.equal(r.reason !== undefined, r.use !== first, `reason iff not first: ${label}`);
      // The whole chain goes with the run, each entry with whether it can run.
      assert.deepEqual(r.chain.map((e) => e.choice), [pick, A, B, ...(only ? [] : [R, F, C])], label);
      for (const e of r.chain) assert.equal(e.why !== undefined, off.has(e.choice.model) || (e.source === "pick" && !pickAllowed), label);
    }
  }
});

test("the reason says what couldn't run and what runs instead", () => {
  const say = (off: string[], extra: { pick?: WorkerChoice; only?: boolean } = {}) => {
    const r = resolveRoleModel({ list: [A, B], only: false, kind: "planning", ...extra }, ctx(new Set(off)));
    return r.reason ?? r.blocked;
  };
  assert.equal(say([]), undefined);
  assert.equal(say(["list/a"]), "A is turned off in Settings → Models, so B");
  assert.equal(say(["list/a", "list/b"]), "None of this playbook's models can run, so your profile's model, R");
  assert.equal(say(["list/a", "list/b", "prof/r", "prof/f"]), "None of this playbook's models can run, and your profile's model can't run either, so this chat's model, C");
  assert.equal(say(["pick/p"], { pick: P }), "Your pick, P, is turned off in Settings → Models, so A");
  assert.equal(say(["list/a", "list/b"], { only: true }), "None of its models can run here (only these models): A is turned off in Settings → Models; B is turned off in Settings → Models.");
  const none = resolveRoleModel({ list: [], only: false, kind: "routine" }, ctx(new Set()));
  assert.deepEqual([none.use, none.reason], [C, "Your profile has no model for routine work, so this chat's model"]);
});

test("a whole cast: each role resolved from the description, your picks applied by role", () => {
  const spec = parsePlaybookSpec({
    version: 1,
    roles: {
      grader: { label: "Grader", prompt: "roles/grader.md", only: true, models: [{ model: "list/a", effort: "high" }] },
      writer: { label: "Writer", prompt: "roles/writer.md", kind: "planning" },
    },
    steps: [{ id: "s", label: "S", roles: ["grader", "writer"] }],
  }) as PlaybookSpec;
  const cast = resolveCast(spec, { writer: B }, ctx(new Set(["list/a"])));
  assert.deepEqual(Object.keys(cast), ["main", "grader", "writer"]);
  assert.deepEqual([cast.main!.use, cast.main!.source], [C, "chat"]);
  assert.equal(cast.grader!.use, null);
  assert.deepEqual([cast.writer!.use, cast.writer!.source], [B, "pick"]);
});
