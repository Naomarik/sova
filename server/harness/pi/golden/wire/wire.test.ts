// Run: pnpm test -- server/harness/pi/golden/wire/wire.test.ts. The wire goldens (README.md here): every faux
// stream's v1 control frames and live trace, and the trace of every live.test.ts sequence and hand-written
// effects sequence, against expected/. A failure names the file and the JSON path of the first difference.
// Record what is missing: SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/golden/wire/wire.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";

// Before any server module computes its paths from it (wire.ts imports chat-manager).
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-golden-wire-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const g = await import("../golden");
const w = await import("./wire");

const HERE = import.meta.dirname;
const EXPECTED = join(HERE, "expected");
const FAUX = join(g.GOLDEN_DIR, "fixtures/faux");
const mode: import("../golden").Mode = process.env.SOVA_GOLDEN_MODE === "record" ? "record" : "compare";
const accept = new Set((process.env.SOVA_GOLDEN_ACCEPT ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const setOf = (name: string): import("../golden").FixtureSet => ({ name, private: false, expected: join(EXPECTED, name), fixtures: [] });

/** Every expected file this run produces, for the stale check. */
const produced = new Set<string>();

function check(set: import("../golden").FixtureSet, fixture: string, probe: string, output: unknown) {
  const r = g.settle(set, fixture, probe, g.compact(g.encode(output)), mode, accept);
  produced.add(r.path);
  const where = relative(g.REPO, r.path);
  if (r.status === "missing") assert.fail(`no expected file ${where}. Record it: SOVA_GOLDEN_MODE=record pnpm test -- ${relative(g.REPO, join(HERE, "wire.test.ts"))}`);
  if (r.status === "differs")
    assert.fail(`${where}: differs at ${r.where}${r.detail ? ` (${r.detail})` : ""}. An intended change needs a CHANGES.md line and SOVA_GOLDEN_ACCEPT=${probe}.`);
}

const faux = readdirSync(FAUX).filter((d) => existsSync(join(FAUX, d, "events.json"))).sort();

describe("wire faux", () => {
  test("every faux scenario has an event stream", () => assert.ok(faux.length > 0));
  for (const name of faux) {
    const events = JSON.parse(readFileSync(join(FAUX, name, "events.json"), "utf8")) as unknown[];
    const frames = w.controlFrames(events, readFileSync(join(FAUX, name, "session.jsonl"), "utf8"));
    test(`frames faux/${name}`, () => check(setOf("faux"), name, "frames", frames));
    test(`trace faux/${name}`, () => check(setOf("faux"), name, "trace", w.frameTrace(frames)));
  }
});

for (const [setName, file] of [
  ["live", "live-test.json"],
  ["effects", "effects.json"],
] as const) {
  describe(`wire ${setName}`, () => {
    const sequences = JSON.parse(readFileSync(join(HERE, "inputs", file), "utf8")) as import("./wire").Sequence[];
    test("sequences exist, and their file names are unique", () => {
      assert.ok(sequences.length > 0);
      const slugs = sequences.map((s) => w.slug(s.name));
      assert.deepEqual(slugs.filter((x, i) => slugs.indexOf(x) !== i), []);
    });
    for (const seq of sequences) test(`trace ${setName}/${w.slug(seq.name)}`, () => check(setOf(setName), w.slug(seq.name), "trace", w.trace(seq.calls)));
  });
}

test("no stale expected files", () => {
  const stale: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!produced.has(p)) stale.push(relative(g.REPO, p));
    }
  };
  if (existsSync(EXPECTED)) walk(EXPECTED);
  assert.deepEqual(stale, [], "expected files no input produces: remove them");
});
