// Run: pnpm test -- server/project-verb-params.test.ts
// A project verb's params come from one table (§app.project-commands/verb-params,
// shared/project-contract.ts VERB_PARAMS): the agents' tools and the catalogue's `project.verb.*`
// entries are both made from it. What the tools declare is frozen byte for byte by
// server/agent-loadouts.test.ts; this file holds the rest: both callers name each param by the
// table, send it under the same wire key, and the catalogue's verb params are the bytes they were
// before the table.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildRequest, COMMANDS, wireKey } from "../shared/commands-catalog";
import { DEPLOY_VERBS, ordered, VERB_FLAGS, VERB_PARAMS, type Verb } from "../shared/project-contract";
import { stateView } from "./harness/state-view";
import type { ProjectEngine } from "./project-services/engine";
import { projectVerbsTool } from "./project-services/tools";

/** An engine that records the body each call carries and answers a plain result. */
function recordingEngine(bodies: Record<string, unknown>[]): ProjectEngine {
  return {
    async run(verb: string, body: Record<string, unknown>) {
      bodies.push(body);
      return ordered({ v: 1, verb: verb as Verb, project: "/srv/p", instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: false, state: "absent", steps: [], services: [], data: [], links: [], defHash: null, at: "" });
    },
  } as unknown as ProjectEngine;
}

function tools(bodies: Record<string, unknown>[] = []) {
  const base = { label: "", description: "", promptSnippet: "", engine: () => recordingEngine(bodies), caller: async () => ({ kind: "operator" }) as const, defaultProject: async () => null };
  return {
    session: projectVerbsTool({ ...base, name: "project_verbs", deploy: "session" }),
    overseer: projectVerbsTool({ ...base, name: "sova_project_verbs", deploy: "overseer", onboard: async () => ({ text: "", details: {} }) }),
  };
}
type Schema = { properties: Record<string, { type: string; description: string }> };

const sample = (type: string, wire: string): unknown =>
  ({ string: `v-${wire}`, path: `/srv/p-${wire}`, integer: 3, boolean: true, list: ["a", "b"] })[type];
const verbEntries = COMMANDS.filter((c) => c.id.startsWith("project.verb."));

describe("one table for a verb's params", () => {
  test("the tools' params are the table's rows that have a tool name, in its order, with its descriptions", () => {
    const rows = VERB_PARAMS.filter((p) => p.tool);
    for (const [which, t] of Object.entries(tools())) {
      const props = (t.parameters as unknown as Schema).properties;
      assert.deepEqual(Object.keys(props), ["verb", ...rows.map((p) => p.tool!.name)], which);
      for (const p of rows) {
        const want = which === "overseer" && p.tool!.overseerDescription ? p.tool!.overseerDescription : p.tool!.description;
        assert.equal(props[p.tool!.name]!.description, want, `${which}: ${p.tool!.name}`);
      }
    }
  });

  test("the catalogue's verb params are the table's flags for that kind of verb, each under the table's wire key and type", () => {
    assert.equal(verbEntries.length > 0, true);
    for (const e of verbEntries) {
      const deploy = (DEPLOY_VERBS as readonly string[]).includes(e.id.slice("project.verb.".length));
      assert.deepEqual(Object.keys(e.params), [...(deploy ? VERB_FLAGS.deploy : VERB_FLAGS.instance)], e.id);
      for (const [flag, p] of Object.entries(e.params)) {
        const row = VERB_PARAMS.find((r) => r.cli?.flag === flag)!;
        assert.equal(wireKey(flag, p), row.wire, `${e.id} --${flag}`);
        assert.equal(p.type, row.type, `${e.id} --${flag}`);
        assert.equal(p.description, row.cli!.description, `${e.id} --${flag}`);
      }
    }
  });

  test("every row is reachable: on the tools, on the command line, or both; flags and tool names are unique", () => {
    const flags = VERB_PARAMS.flatMap((p) => (p.cli ? [p.cli.flag] : []));
    const names = VERB_PARAMS.flatMap((p) => (p.tool ? [p.tool.name] : []));
    assert.equal(new Set(flags).size, flags.length);
    assert.equal(new Set(names).size, names.length);
    assert.equal(new Set(VERB_PARAMS.map((p) => p.wire)).size, VERB_PARAMS.length);
    for (const p of VERB_PARAMS) assert.ok(p.tool || p.cli, p.wire);
    for (const f of [...VERB_FLAGS.instance, ...VERB_FLAGS.deploy]) assert.ok(flags.includes(f), `--${f} has no row`);
    for (const f of flags) assert.ok(VERB_FLAGS.instance.includes(f) || VERB_FLAGS.deploy.includes(f), `--${f} is on no kind of verb`);
  });

  test("the operator's own params never reach the agents' tools: no tool row for confirm, the overrides, dismiss or slot", () => {
    const operatorOnly = ["confirm", "overrideTests", "overrideDirty", "dismiss", "slot"];
    for (const w of operatorOnly) assert.ok(VERB_PARAMS.some((p) => p.wire === w), `${w} is a row`);
    assert.deepEqual(VERB_PARAMS.filter((p) => operatorOnly.includes(p.wire) && p.tool).map((p) => p.wire), []);
    for (const t of Object.values(tools())) {
      const props = Object.keys((t.parameters as unknown as Schema).properties);
      assert.deepEqual(props.filter((k) => ["confirm", "override_tests", "overrideTests", "override_dirty", "overrideDirty", "dismiss", "slot"].includes(k)), []);
    }
  });

  test("a param reaches the engine under the same wire key from a tool as from the command line", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { session } = tools(bodies);
    const ctx = { sessionId: "s", cwd: "/", leafId: () => null, state: () => stateView([]) } as never;
    for (const p of VERB_PARAMS.filter((r) => r.tool)) {
      const v = sample(p.type, p.wire);
      await session.execute("t", { verb: "status", [p.tool!.name]: v }, undefined, undefined, ctx);
      const sent = bodies.at(-1)!;
      assert.deepEqual(sent[p.wire], v, `tool ${p.tool!.name} → ${p.wire}: ${JSON.stringify(sent)}`);
      if (!p.cli) continue;
      const entry = verbEntries.find((e) => e.params[p.cli!.flag])!;
      const r = buildRequest(entry, { [p.cli.flag]: v });
      assert.deepEqual((r.body as Record<string, unknown>)[p.wire], v, `--${p.cli.flag} → ${p.wire}`);
    }
  });

  test("the catalogue's verb params are the bytes they were before the table", () => {
    // sha256 of JSON.stringify(the project.verb.* entries) as shared/commands/projects.ts built them at 0ed11922.
    const now = createHash("sha256").update(JSON.stringify(verbEntries)).digest("hex");
    assert.equal(now, "952f705d0bd6cb3d1f3512b977f7c0cb111765ad00293609291c051c923a21b5");
  });

  test("scripts/sova-project.mjs parses every flag the table gives the command line, and takes exactly its booleans bare", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "sova-project.mjs"), "utf8");
    const setOf = (name: string) => new Set(JSON.parse(`[${new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src)![1]}]`) as string[]);
    const value = setOf("VALUE");
    const bare = setOf("FLAG");
    for (const p of VERB_PARAMS.filter((r) => r.cli)) {
      if (p.type === "boolean") assert.ok(bare.has(p.cli!.flag), `--${p.cli!.flag} is a bare flag`);
      else assert.ok(value.has(p.cli!.flag), `--${p.cli!.flag} takes a value`);
    }
    assert.deepEqual([...bare].sort(), VERB_PARAMS.filter((r) => r.cli && r.type === "boolean").map((r) => r.cli!.flag).sort());
  });
});
