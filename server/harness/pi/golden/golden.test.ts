// Run: pnpm test -- server/harness/pi/golden/golden.test.ts. The goldens (README.md here): every fixture ×
// every probe against its expected file, recorded on the code before the reader refactor. A failure names
// the probe, the fixture and the JSON path of the first difference (for the real corpus: its hash, never
// content). Recording runs through here too, so it sees the test's own environment:
// `node scripts/harness-golden.mjs record [--accept <probe>]` sets SOVA_GOLDEN_MODE=record.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";

// Before any server module computes its paths from it.
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-golden-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const g = await import("./golden");
const PROBE_FILES = ["reader", "rows", "usage", "list", "baton", "overseer", "fork"];
const probes: import("./golden").Probe[] = (await Promise.all(PROBE_FILES.map((n) => import(`./probes/${n}.ts`)))).flatMap((m) => m.probes);

const mode: import("./golden").Mode = process.env.SOVA_GOLDEN_MODE === "record" ? "record" : "compare";
const accept = new Set((process.env.SOVA_GOLDEN_ACCEPT ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const onlySets = process.env.SOVA_GOLDEN_SETS ? new Set(process.env.SOVA_GOLDEN_SETS.split(",")) : null;
/** The run's own paths, so no output carries this machine's temp dir. */
const scrub = new Map([[agentDir, "<agent>"]]);
const workspace = join(agentDir, "sessions", "--golden--");

test("probe names are unique and every accepted probe exists", () => {
  const names = probes.map((p) => p.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  for (const a of accept) assert.ok(names.includes(a), `--accept ${a}: no such probe`);
});

const sets = g.fixtureSets();
if (!sets.some((s) => s.name === "real")) test.skip(`real corpus: ${relative(g.REPO, g.REAL_DIR)}/sessions is absent (scripts/harness-golden.mjs sample)`, () => {});

for (const set of sets) {
  if (onlySets && !onlySets.has(set.name)) continue;
  describe(`golden ${set.name}`, () => {
    test("committed fixtures exist", () => assert.ok(set.private || set.fixtures.length > 0, `no fixtures in the ${set.name} set`));
    for (const fx of set.fixtures) {
      const fixture = g.workspaceFixture(set, fx, workspace);
      const label = set.private ? `real/${fx.name}` : `${set.name}/${fx.name}`;
      for (const probe of probes.filter((p) => p.formats.includes(fx.format))) {
        test(`${probe.name} ${label}`, async () => {
          const output = g.encode(await g.runProbe(probe, fixture), scrub);
          const r = g.settle(set, fx.name, probe.name, output, mode, accept);
          const where = relative(g.REPO, r.path);
          if (r.status === "missing") assert.fail(`${probe.name} ${label}: no expected file ${where}. Record it: node scripts/harness-golden.mjs record`);
          if (r.status === "differs")
            assert.fail(`${probe.name} ${label}: differs at ${r.where}${r.detail ? ` (${r.detail})` : ""}. An intended change needs a CHANGES.md line and \`node scripts/harness-golden.mjs record --accept ${probe.name}\`.`);
        });
      }
    }
    test("no stale expected files", () => assert.deepEqual(g.staleExpected(set, probes), [], "expected files no fixture or probe produces: remove them"));
  });
}
