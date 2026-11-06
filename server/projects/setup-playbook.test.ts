// The Setup chat's playbook (playbooks/project-setup): what it shows the model must be what Sova accepts. Every drawing
// in its references parses as a vis block; the driver's drawing of Sova's own definition parses too (no row over the
// renderer's step limit); every JSON sample is a valid definition fragment; every merge/release/deploy key the parser
// accepts is named in references/definition.md; and its frontmatter says it proposes the whole pipeline.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFINITION_KEYS, parseDefinition } from "../../shared/project-contract";
import { parseFlow } from "../../src/vis/kinds/flow/parse";
import { parseSteps } from "../../src/vis/kinds/steps/parse";
// @ts-expect-error: a plain .mjs script, no types
import * as ps from "../../playbooks/project-setup/scripts/project-setup.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PLAYBOOK = join(REPO, "playbooks", "project-setup");

function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? mdFiles(p) : p.endsWith(".md") ? [p] : [];
  });
}

test("the frontmatter proposes the pipeline", () => {
  const head = readFileSync(join(PLAYBOOK, "PLAYBOOK.md"), "utf8").split("\n---")[0]!;
  assert.match(head, /^proposes: pipeline$/m);
});

test("every vis steps / vis flow block in the playbook parses", () => {
  let n = 0;
  for (const f of mdFiles(PLAYBOOK)) {
    for (const m of readFileSync(f, "utf8").matchAll(/```vis (steps|flow)\n([\s\S]*?)\n```/g)) {
      n++;
      assert.doesNotThrow(() => (m[1] === "steps" ? parseSteps(m[2]!) : parseFlow(m[2]!)), `${f.slice(REPO.length)}: a ${m[1]} block`);
    }
  }
  assert.ok(n > 0, "the playbook draws at least one plan");
});

test("the driver's drawing of Sova's own definition parses, every row within the step limit, and a change is marked", () => {
  const def = parseDefinition(readFileSync(join(REPO, ".sova", "project.json"), "utf8"));
  const rows = ps.pipelineRows(def) as { label: string; steps: unknown[] }[];
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.steps.length <= ps.ROW_MAX, `${r.label}: ${r.steps.length} steps`);
  const block = ps.visSteps(rows, { title: "Sova" }) as string;
  const body = /```vis steps\n([\s\S]*?)\n```/.exec(block)![1]!;
  assert.doesNotThrow(() => parseSteps(body));
  // A redraw against an older setup marks the rows that differ.
  const older = rows.map((r, i) => (i === 0 ? { ...r, steps: r.steps.slice(1) } : r));
  const marked = ps.visSteps(rows, { baseRows: older }) as string;
  assert.match(marked, /^mark .* accent "changed"$/m);
  assert.doesNotThrow(() => parseSteps(/```vis steps\n([\s\S]*?)\n```/.exec(marked)![1]!));
});

test("a long check list is split into rows the renderer accepts", () => {
  const checks = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, label: `Check ${i}`, run: ["true"] }));
  const def = parseDefinition(JSON.stringify({ version: 1, merge: { checks } }));
  const rows = ps.pipelineRows(def) as { label: string; steps: unknown[] }[];
  const req = rows.filter((r) => r.label.startsWith("Required checks"));
  assert.deepEqual(req.map((r) => r.steps.length), [10, 3]);
  assert.doesNotThrow(() => parseSteps(/```vis steps\n([\s\S]*?)\n```/.exec(ps.visSteps(rows) as string)![1]!));
});

test("every JSON sample in references is a valid definition fragment", () => {
  // The fragments name sections only; services and a merge check they refer to stand in around them.
  const base = { version: 1, services: { web: { cmd: ["x"], ports: { http: { base: 30000 } } }, db: { cmd: ["y"], ports: { pg: { base: 31000 } }, start: "on-demand" }, "test-repl": { cmd: ["z"], ports: { nrepl: { base: 32000 } }, start: "on-demand" } }, test: { run: ["t"], smoke: ["a"] } };
  let n = 0;
  for (const f of mdFiles(join(PLAYBOOK, "references"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/```json\n([\s\S]*?)\n```/g)) {
      n++;
      const frag = m[1]!.trim();
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(`{${frag}}`);
      } catch {
        obj = JSON.parse(frag);
      }
      const def: Record<string, unknown> = { ...base, ...obj };
      if (obj.release && !obj.merge) def.merge = { checks: [{ id: "e2e", run: ["e"], optional: true }, { id: "unit", run: ["u"] }] };
      if (obj.deploy && !obj.host) def.host = ["PROD_HOST", "SITE_HOST"];
      assert.doesNotThrow(() => parseDefinition(JSON.stringify(def)), `${f.slice(REPO.length)}: ${frag.slice(0, 80)}`);
    }
  }
  assert.ok(n > 0, "the references hold JSON samples");
});

test("every merge, release and deploy key the parser accepts is named in references/definition.md", () => {
  const doc = readFileSync(join(PLAYBOOK, "references", "definition.md"), "utf8");
  const groups = ["merge", "mergeCheck", "mergeInstall", "release", "releaseCheck", "deploy", "target", "deployStep", "verify", "credential", "requires"] as const;
  for (const g of groups) for (const k of (DEFINITION_KEYS[g] as readonly unknown[]).flat() as string[]) assert.ok(doc.includes(`\`${k}\``), `definition.md never names \`${k}\` (${g})`);
});
