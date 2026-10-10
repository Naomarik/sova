// Ranked finishing census check (lane B2, fix 8): on a `git archive` copy of a project at REV, apply a change,
// run `census --changed --related --json`, and report where the § that change really concerns rank among the
// touched foreign §, how many bytes reading the read-first set costs, and whether every touched § is still named.
// Not a test (the runner's glob is tests/*.test.mjs). Node stdlib, git and tar only; writes only under --work.
//
//   node ranked-finish.mjs --src <git repo> --rev REV --work DIR [--core DIR] [--case sessionview|wav|all]
//     [--patch FILE]   the SessionView patch (default: `git -C /tmp/spec-review-2026-10-09/trial show 39505c1`)
//
// --core: the tools under test (default: this checkout's core). The reference set for the guard is the census of
// the copy's own tools (REV's core), so "none dropped" is measured against what today's census lists.
// Today's census has no ranking: a § is "unranked" and the read-first set is everything it lists.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const src = arg("--src"), rev = arg("--rev", "HEAD"), work = resolve(arg("--work", ""));
const core = resolve(arg("--core", join(dirname(fileURLToPath(import.meta.url)), "../../core")));
const which = arg("--case", "all");
if (!src || !arg("--work")) { console.error("--src and --work are required"); process.exit(2); }

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const sh = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: "utf8", env, maxBuffer: 1 << 30, ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
const git = (dir, ...a) => sh("git", ["-c", "user.name=b", "-c", "user.email=b@b", "-c", "commit.gpgsign=false", "-C", dir, ...a]);
const tool = (c, dir, ...a) => spawnSync(process.execPath, [join(c, "sova-spec.mjs"), ...a, "--root", dir], { encoding: "utf8", env, maxBuffer: 1 << 28, cwd: dir });
const patchText = arg("--patch") ? readFileSync(arg("--patch"), "utf8") : sh("git", ["-C", "/tmp/spec-review-2026-10-09/trial", "show", "39505c1"]);

const CASES = {
  // Trial task (d): rename a session from its head title; 30 added, 3 removed lines in SessionView.tsx.
  sessionview: {
    apply: (dir) => { writeFileSync(join(work, "sessionview.patch"), patchText); git(dir, "apply", join(work, "sessionview.patch")); },
    relevant: ["§chat.transcript/anatomy", "§chat.context-window/markup"],
  },
  // Trial probe (g): MAX_WAV_BYTES 12 → 16 MB, against the claim that says "at most 12 MB".
  wav: {
    apply: (dir) => {
      const f = join(dir, "server/voice/service.ts"), text = readFileSync(f, "utf8");
      const next = text.replace("MAX_WAV_BYTES = 12 * 1024 * 1024", "MAX_WAV_BYTES = 16 * 1024 * 1024");
      if (next === text) throw new Error("MAX_WAV_BYTES = 12 MB not found");
      writeFileSync(f, next);
    },
    relevant: ["§chat.voice/transcribe"],
    stale: { id: "§chat.voice/transcribe", literal: /12/ },
  },
};

const base = join(work, `ranked-${rev.slice(0, 12)}`);
rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true });
sh("tar", ["-x", "-C", base], { input: spawnSync("git", ["-C", src, "archive", rev], { env, maxBuffer: 1 << 30 }).stdout, encoding: undefined });
git(base, "init", "-q"); git(base, "add", "-A"); git(base, "commit", "-qm", "base");
const refCore = join(base, "pi-config/extensions/spec/core");

const results = {};
for (const [name, c] of Object.entries(CASES)) {
  if (which !== "all" && which !== name) continue;
  git(base, "checkout", "-q", "--", ".");
  c.apply(base);
  const run = (k) => { const r = tool(k, base, "census", "--changed", "--related", "--json"); return { json: JSON.parse(r.stdout), bytes: r.stdout.length + r.stderr.length, stderr: r.stderr }; };
  const ref = run(refCore).json.census;
  const got = run(core);
  const j = got.json, cs = j.census;
  const readFirst = cs.readFirst ?? j.readFirst;
  const named = cs.named ?? j.named ?? [];
  const ranked = Array.isArray(readFirst);
  const order = ranked ? [...readFirst, ...named] : cs.foreign;
  const touched = Object.fromEntries((cs.touched ?? []).map((t) => [t.id, t]));
  const rankOf = (id) => !ranked ? null : touched[id]?.rank ?? (order.indexOf(id) + 1 || null);
  const readSet = ranked ? readFirst : cs.foreign;
  let readBytes = 0;
  readSet.forEach((id, i) => { const r = tool(core, base, "read", id, ...(i ? ["--no-frame"] : [])); readBytes += r.stdout.length; });
  const dropped = ref.foreign.filter((id) => !order.includes(id));
  const s = c.stale ? touched[c.stale.id]?.stale : undefined;
  results[name] = {
    touchedForeign: ref.foreign.length,
    ranked,
    relevant: Object.fromEntries(c.relevant.map((id) => [id, { rank: rankOf(id), listedAt: order.indexOf(id) + 1 || null }])),
    readFirst: readSet.length,
    readFirstBytes: readBytes,
    named: order.length,
    dropped,
    ...(c.stale ? { stale: s ?? null, staleFlagged: Array.isArray(s) ? s.some((x) => c.stale.literal.test(String(x))) : typeof s === "string" ? c.stale.literal.test(s) : false } : {}),
    censusJsonBytes: got.bytes,
  };
  console.error(`${name}: ${ranked ? "ranked" : "unranked"}; ${Object.entries(results[name].relevant).map(([id, v]) => `${id} rank ${v.rank ?? "-"} (listed ${v.listedAt}/${order.length})`).join(", ")}; read-first ${readSet.length} § = ${(readBytes / 1024).toFixed(1)} KB; dropped ${dropped.length}`);
}
console.log(JSON.stringify({ rev, core, results }, null, 2));
