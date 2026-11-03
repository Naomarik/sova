// How often branches collide on the spec's record files, replayed from a repository's merge history, before and
// after the move to one record file per area (format version 2). Read-only: Git plumbing and core/layout.mjs.
//   node merge-collisions.mjs [--root DIR] [--since DATE|REV] [--until REV] [--spec .sova/spec] [--rows] [--json]
// --since: a date (merges committed since then) or a revision (merges in REV..until). Default: every merge.
//
// For each two-parent merge M (p1 = the side merged into, p2 = the side merged in, base = their merge base):
//   index files  the spec's record files: manifest.json plus claims/**/*.json, as each commit holds them.
//   both         (a) some index file changed on both sides, as the files were at the time.
//   conflict     (b) Git's line merge (`git merge-file`, never a merge driver) leaves a conflict in one of those.
//   bothArea / conflictArea  the same over the records re-laid one file per area (layout.mjs serialize, format 2),
//                whatever the layout at the time: the after-cutover shape, so both periods compare on one footing.
//   sameRecord   some record changed differently on both sides: a real clash no merge settles by itself.
//   tookWhole    (d) M's whole spec equals one parent's while the other parent's own change to a spec file is gone
//                (a whole-spec recovery); tookArea: the same for one area's pair of files (a per-area recovery).
// Each merge is grouped by the layout of its two parents: v1, v2, or cross (a merge across the cutover).
// Plus (c): commits whose subject reads as a re-apply (re-promote, re-apply, master's whole spec), per week.
// Exit 0; 2 on a usage or Git error.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSpecGit, serialize, canonRecord, layoutOf } from "../../core/layout.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const ROOT = resolve(opt("--root", join(dirname(fileURLToPath(import.meta.url)), "../../../../..")));
const SPEC = opt("--spec", ".sova/spec").replace(/\/+$/, "");
const SINCE = opt("--since"), UNTIL = opt("--until", "HEAD");
const ROWS = args.includes("--rows"), JSON_OUT = args.includes("--json");
const REAPPLY = /re-?promot|re-?appl|master'?s (whole )?spec/i;

function git(argv, input) {
  const r = spawnSync("git", ["-C", ROOT, ...argv], { encoding: "utf8", maxBuffer: 1 << 30, input });
  return r;
}
function must(argv) {
  const r = git(argv);
  if (r.status !== 0) { console.error(`git ${argv.join(" ")}: ${r.stderr.trim()}`); process.exit(2); }
  return r.stdout;
}

// ---------------------------------------------------------------- the merges
const isRev = SINCE !== undefined && git(["rev-parse", "-q", "--verify", `${SINCE}^{commit}`]).status === 0;
const range = SINCE === undefined ? [UNTIL] : isRev ? [`${SINCE}..${UNTIL}`] : [`--since=${SINCE}`, UNTIL];
const merges = must(["rev-list", "--min-parents=2", "--max-parents=2", "--parents", ...range]).trim().split("\n").filter(Boolean)
  .map((l) => l.split(" ")).reverse();

// ---------------------------------------------------------------- per commit, cached
const listing = new Map(); // rev → Map(path rel to the spec dir → blob id), tracked files only
function filesAt(rev) {
  if (!listing.has(rev)) {
    const m = new Map();
    for (const e of must(["ls-tree", "-r", "-z", "--full-tree", rev, "--", `${SPEC}/`]).split("\0").filter(Boolean)) {
      const [meta, path] = e.split("\t");
      if (meta.split(" ")[1] === "blob") m.set(path.slice(SPEC.length + 1), meta.split(" ")[2]);
    }
    listing.set(rev, m);
  }
  return listing.get(rev);
}
const isIndex = (rel) => rel === "manifest.json" || (rel.startsWith("claims/") && rel.endsWith(".json"));
const specs = new Map(); // rev → {layout, files: Map(rel → text)} | null, the records re-laid one file per area
function areaFilesAt(rev) {
  if (!specs.has(rev)) {
    const s = readSpecGit(ROOT, rev, { specRel: SPEC });
    let v = null;
    if (s.state === "present" && s.manifest) {
      const files = new Map([...serialize(2, s.manifest)].filter(([, t]) => t !== null));
      v = { layout: s.layout, records: s.records, files };
    }
    specs.set(rev, v);
  }
  return specs.get(rev);
}
function layoutAt(rev) {
  const blob = filesAt(rev).get("manifest.json");
  if (!blob) return null;
  try { return layoutOf(JSON.parse(must(["cat-file", "blob", blob]))); } catch { return null; }
}
const blobText = (id) => (id ? must(["cat-file", "blob", id]) : "");

// Git's own line merge of three texts: true when it leaves a conflict.
const scratch = mkdtempSync(join(tmpdir(), "sova-merge-collisions-"));
function conflicts(base, ours, theirs) {
  const [b, o, t] = ["base", "ours", "theirs"].map((n) => join(scratch, n));
  writeFileSync(b, base); writeFileSync(o, ours); writeFileSync(t, theirs);
  const r = spawnSync("git", ["merge-file", "-p", "-q", o, b, t], { encoding: "utf8", maxBuffer: 1 << 30 });
  return r.status !== 0;
}
// A path both sides changed (to different bytes, or the same new bytes: Git's line merge settles identical ones).
const both = (base, a, b, keys) => keys.filter((k) => a.get(k) !== base.get(k) && b.get(k) !== base.get(k));

// ---------------------------------------------------------------- replay
const groups = {};
const rows = [];
const blank = () => ({ merges: 0, both: 0, conflict: 0, bothArea: 0, conflictArea: 0, sameRecord: 0, tookWhole: 0, tookArea: 0, bothFiles: 0, bothAreaFiles: 0 });
try {
  for (const [m, p1, p2] of merges) {
    const baseOut = git(["merge-base", p1, p2]);
    if (baseOut.status !== 0) continue; // unrelated histories
    const base = baseOut.stdout.trim();
    const [l1, l2] = [layoutAt(p1), layoutAt(p2)];
    if (l1 === null && l2 === null) continue; // no spec on either side
    const group = l1 === l2 ? `v${l1}` : l1 === null || l2 === null ? `v${l1 ?? l2}` : "cross";
    const g = (groups[group] ??= blank());
    g.merges++;
    const [fb, f1, f2, fm] = [filesAt(base), filesAt(p1), filesAt(p2), filesAt(m)];
    const keys = [...new Set([...fb.keys(), ...f1.keys(), ...f2.keys()])];
    const row = { merge: m.slice(0, 12), group };
    // (a), (b): the index files as they were.
    const bothIdx = both(fb, f1, f2, keys.filter(isIndex));
    if (bothIdx.length) {
      g.both++; g.bothFiles += bothIdx.length; row.both = bothIdx;
      const hit = bothIdx.filter((k) => f1.get(k) !== f2.get(k) && conflicts(blobText(fb.get(k)), blobText(f1.get(k)), blobText(f2.get(k))));
      if (hit.length) { g.conflict++; row.conflict = hit; }
    }
    // The same, one record file per area, and the records themselves.
    if (bothIdx.length) {
      const [ab, a1, a2] = [areaFilesAt(base), areaFilesAt(p1), areaFilesAt(p2)];
      if (ab && a1 && a2) {
        const akeys = [...new Set([...ab.files.keys(), ...a1.files.keys(), ...a2.files.keys()])];
        const bothA = both(ab.files, a1.files, a2.files, akeys);
        if (bothA.length) {
          g.bothArea++; g.bothAreaFiles += bothA.length; row.bothArea = bothA;
          const hitA = bothA.filter((k) => a1.files.get(k) !== a2.files.get(k) && conflicts(ab.files.get(k) ?? "", a1.files.get(k) ?? "", a2.files.get(k) ?? ""));
          if (hitA.length) { g.conflictArea++; row.conflictArea = hitA; }
        }
        const ids = new Set([...Object.keys(ab.records), ...Object.keys(a1.records), ...Object.keys(a2.records)]);
        const same = [...ids].filter((id) => {
          const [b, x, y] = [ab, a1, a2].map((s) => canonRecord(s.records[id]));
          return x !== b && y !== b && x !== y;
        });
        if (same.length) { g.sameRecord++; row.sameRecord = same; }
      }
    }
    // (d): a side's own change to a spec file dropped by the merge.
    const dropped = (mine, theirs) => keys.filter((k) => mine.get(k) !== fb.get(k) && mine.get(k) !== theirs.get(k) && fm.get(k) === theirs.get(k));
    const specOf = (f) => JSON.stringify([...f].sort());
    for (const [mine, theirs, side] of [[f1, f2, "theirs"], [f2, f1, "ours"]]) {
      const lost = dropped(mine, theirs);
      if (!lost.length) continue;
      if (specOf(fm) === specOf(theirs)) { g.tookWhole++; row.tookWhole = side; }
      else {
        // An area's pair (claims/<path>.md + .json) taken whole from one side while the other side changed it.
        const areas = new Set(lost.filter((k) => k.startsWith("claims/")).map((k) => k.replace(/\.(md|json)$/, "")));
        const took = [...areas].filter((a) => [".md", ".json"].every((x) => fm.get(a + x) === theirs.get(a + x)));
        if (took.length) { g.tookArea++; row.tookArea = [...(row.tookArea ?? []), ...took.map((a) => `${side}:${a}`)]; }
      }
    }
    if (ROWS && Object.keys(row).length > 2) rows.push(row);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// (c): re-apply commits.
const log = must(["log", "--no-merges", "--format=%ct%x09%s", ...range]).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const times = log.map(([t]) => Number(t));
const days = times.length ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86400) : 0;
const reapply = log.filter(([, s]) => REAPPLY.test(s)).length;
const out = {
  tool: "merge-collisions", root: ROOT, spec: SPEC, range: range.join(" "), merges: merges.length, groups,
  reapply: { commits: reapply, days: Math.round(days * 10) / 10, perWeek: days ? Math.round((reapply / days) * 7 * 10) / 10 : 0 },
  ...(ROWS ? { rows } : {}),
};
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "0/0");
  console.log(`${out.merges} merge(s) in ${out.range}`);
  for (const [k, v] of Object.entries(groups))
    console.log(`  ${k.padEnd(5)} ${v.merges} merges · both sides changed an index file ${pct(v.both, v.merges)} · Git conflict ${pct(v.conflict, v.merges)} · per area: both ${pct(v.bothArea, v.merges)}, conflict ${pct(v.conflictArea, v.merges)} · same record two ways ${v.sameRecord} · whole-spec recoveries ${v.tookWhole} · per-area ${v.tookArea}`);
  console.log(`  re-apply commits: ${reapply} in ${out.reapply.days} days (${out.reapply.perWeek}/week)`);
}
