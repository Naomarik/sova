// Deterministic outsider look-up probe for the simulation's C3/C3b (run with bun, from the worktree):
// every record id of each given spec copy is read through server/spec-lookup.ts's own specLookup
// (op "read", outsider view), the same path a gathering's spec_lookup call takes, with the module's
// test hooks pointing the project at that copy. No server, no model.
//
//   bun scripts/sim/lib/lookup-probe.ts <input.json>   → JSON on stdout
//   input: { names: string[], copies: [{ label, toolRoot }] }   (toolRoot holds .sova/spec)
//   output: [{ label, id, candidate, result | refused }]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { names: string[]; copies: { label: string; toolRoot: string }[] };
const lookup = await import("../../../server/spec-lookup.ts");
const out: { label: string; id: string; candidate: boolean; result?: string; refused?: string }[] = [];
for (const copy of input.copies) {
  const projectId = `probe-${copy.label}`;
  lookup.setLookupPlaceForTest(() => ({ root: copy.toolRoot, name: "probe", names: input.names }));
  lookup.setMainLineForTest(async () => ({ root: copy.toolRoot, specRoot: copy.toolRoot, specKey: `probe-${copy.label}`, code: null as never }));
  const manifest = JSON.parse(readFileSync(join(copy.toolRoot, ".sova/spec/manifest.json"), "utf8"));
  for (const [id, rec] of Object.entries<any>(manifest.claims ?? {})) {
    const sessionId = `probe-${copy.label}`;
    const ref = lookup.handleFor(sessionId, projectId, id);
    try {
      const result = await lookup.specLookup({ sessionId, projectId, view: "outsider" }, { op: "read", ref });
      out.push({ label: copy.label, id, candidate: rec?.authority === "candidate", result });
    } catch (err) {
      out.push({ label: copy.label, id, candidate: rec?.authority === "candidate", refused: err instanceof Error ? err.message : String(err) });
    }
  }
}
lookup.setLookupPlaceForTest(null);
lookup.setMainLineForTest(null);
console.log(JSON.stringify(out));
process.exit(0);
