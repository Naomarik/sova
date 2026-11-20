// Is a split spec's topic search the unsplit spec's? For every split topic of AFTER, the text it is scored on against
// the same claim in BEFORE, field by field (heading, first sentence, names, prose, area heading: each word's count and
// the field's length), and the word statistics over all units. Read-only; Node stdlib and the core only.
// Run: node tests/search/split-units.mjs <before root> <after root> [--json]   exit 0 equal, 1 any difference, 2 unreadable
import { resolve } from "node:path";
import { graphAt } from "../../core/sova-spec.mjs";
import { indexOf } from "../../core/graph.mjs";
import { topicIndex, topicText } from "../../core/topic.mjs";
import { splitOf } from "../../core/parts.mjs";

const [before, after] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((p) => resolve(p));
if (!before || !after) { console.error("usage: split-units.mjs <before root> <after root> [--json]"); process.exit(2); }
const open = (root) => {
  const g = graphAt(root);
  if (!g || g.findings.some((f) => f.severity === "error")) { console.error(`${root}: the spec does not load`); process.exit(2); }
  const ix = indexOf(g.ctx, g.parentOf);
  return { ctx: g.ctx, ix, tix: topicIndex(ix) };
};
const B = open(before), A = open(after), split = splitOf(A.ctx);
const unitsOf = (tix) => new Map(tix.units.map((u) => [u.id, u]));
const ub = unitsOf(B.tix), ua = unitsOf(A.tix);
const field = (u, f) => JSON.stringify([u.per[f].len, [...u.per[f].tf].sort(([a], [b]) => (a < b ? -1 : 1))]);
const diffOf = (a, b) => (!b ? ["missing before"] : Object.keys(a.per).filter((f) => field(a, f) !== field(b, f)));
// Text as written, blank lines aside: a split may also have moved lines, which changes no count but the first sentence.
const lines = (t) => t.split("\n").filter((l) => l.trim()).join("\n");
const topics = [...split.down.keys()].sort().map((id) => {
  const fields = diffOf(ua.get(id), ub.get(id));
  return { id, parts: split.down.get(id).length, fields, sameText: !!B.ctx.decls.get(id) && lines(topicText(A.ix, split, id).text) === lines(B.ctx.decls.get(id).text) };
});
const others = [...ua.keys()].filter((id) => !split.down.has(id)), otherDiff = others.filter((id) => diffOf(ua.get(id), ub.get(id)).length);
const sameStats = { units: ua.size === ub.size, df: JSON.stringify([...A.tix.df].sort()) === JSON.stringify([...B.tix.df].sort()), avg: JSON.stringify(A.tix.avg) === JSON.stringify(B.tix.avg) };
const out = { before, after, topics: topics.length, parts: split.up.size, equal: topics.filter((t) => !t.fields.length).length, sameTextIgnoringBlankLines: topics.filter((t) => t.sameText).length,
  differ: topics.filter((t) => t.fields.length).map(({ id, fields }) => ({ id, fields })), others: others.length, othersDiffer: otherDiff, stats: sameStats };
const ok = !out.differ.length && !otherDiff.length && Object.values(sameStats).every(Boolean);
if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.topics} split topics (${out.parts} parts): ${out.equal} scored exactly as before, ${out.sameTextIgnoringBlankLines} with the same lines in the same order`);
  for (const d of out.differ) console.log(`  differs: ${d.id} (${d.fields.join(", ")})`);
  console.log(`${out.others} other units: ${otherDiff.length} differ${otherDiff.length ? ` (${otherDiff.slice(0, 10).join(", ")})` : ""}`);
  console.log(`word statistics: units ${sameStats.units ? "same" : "differ"} · df ${sameStats.df ? "same" : "differ"} · field lengths ${sameStats.avg ? "same" : "differ"}`);
}
process.exit(ok ? 0 : 1);
