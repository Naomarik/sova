#!/usr/bin/env node
// The merge round's driver (PLAYBOOK.md): the round's mechanical steps, one subcommand each. The
// captain still picks every next step; each command ends with a `next:` line. Node builtins only.
//
//   node scripts/round.mjs <command> [args] [--repo <dir>] [--json]
//
//   start                 this session's round begins (PI_SESSION_ID): interview?, push hold, restart needed or confirmed?
//   names-answered        the user answered the start interview: lift the push hold
//   status                every local branch ahead of master with a worktree, joined to Sova's merge board and sorted by the next action; the main checkout
//   note <branch> owner=<id> idle=yes|no
//   go <branch> [without-specs]  the user's word in this chat to land it: a go-ahead like Land It, straight to check
//   ask <branch>          Ready to land, owner idle: queue it, and Sova shows the owner the Landing card
//   check <branch> [full] [--background]
//                         merge master in (in the branch's worktree), print the expected time, typecheck, unit tests, the
//                         integration tests a landing runs (the everyday set + triggered groups; `full`: all), suites
//                         (niced), spec replay, build, spec, also-update nudges, fixed-wait note, leak scan;
//                         --background: the same, detached, its output in a log under the state dir
//   wait <branch> [--timeout <s>]  block until the branch's background check ends, then print its digest
//   full on|off           every check a full run (every integration test) until told otherwise
//   land <branch>         a green check at this head and master, and no leak-scan hit: the `worktree` merge call to make
//   landed <branch>       verify its head is in master, build the main checkout, record the restart need; next: the clean up
//   push                  leak-scan, then `git push origin master`, refused under the hold or if not a fast-forward
//   restart-check         is a restart needed? prints the restart line when one is (systemctl; macOS launchctl kickstart; busy sessions never hold it)
//   report                the round report's skeleton
//
// Exit 0: go. Exit 1: something to act on or decide. Exit 2: couldn't tell; fail closed.
// Owners come from Sova's merge board file (<state root>/merge-board.json); it never reads sessions,
// never calls Sova's API about them and never holds Sova's token. It never restarts anything, never force-pushes, and masks every private name in what it prints or stores.
// A restart is needed when the live server's head (GET /api/health) lacks master's runtime code.
// Every child runs by argv with no shell, in its own process group, under a timeout.
import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, cpSync, createWriteStream, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// Pure rules, exported for the tests. tempCommitOf and needsRestart copy server/merge-readiness.ts's,
// landingAnswer and landingAnswerAt pi-config's worktrees/landing.ts; server/merge-round-rules.test.ts holds them equal.

const TEMP_RE = /^(?:temp|wip)\b|^(?:fixup|squash|amend)!/i;
/** The newest temporary commit subject, if any (server/merge-readiness.ts tempCommitOf). */
export const tempCommitOf = (subjects) => subjects.find((s) => TEMP_RE.test(s.trim()));

/** A changed file that needs the server restarted (server/merge-readiness.ts needsRestart). */
export const needsRestart = (file) =>
  (/^(?:server|shared|pi-config)\//.test(file) && !/\.md$|\.test\.[cm]?[jt]sx?$/.test(file)) || file === "package.json" || file === "pnpm-lock.yaml";

/** The sandbox tests' own output: never counts as uncommitted, never staged. */
export const IGNORED_DIRTY = ["pi-config/extensions/sandbox/tests/FIRST-RUN.txt", "pi-config/extensions/sandbox/tests/NAIVE-RUN.txt"];

/** Paths from `git status --porcelain=v1 -z`, minus the ignored ones. */
export function dirtyPaths(porcelainZ) {
  const parts = porcelainZ.split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // the rename's source follows
  }
  return paths.filter((p) => !IGNORED_DIRTY.includes(p));
}

/** Distinct files in `merge-tree --write-tree`'s conflicted-file lines (server/worktrees.ts conflictedFiles). */
export function conflictedFiles(stdout) {
  const files = new Set();
  for (const line of stdout.split("\n").slice(1)) {
    if (line.trim() === "") break;
    const tab = line.indexOf("\t");
    files.add(tab >= 0 ? line.slice(tab + 1) : line);
  }
  return files.size;
}

/** The hand-back for a branch whose docs aren't official: its owner promotes and commits on its branch. */
export const handBackText = (branch, drafts) =>
  `${branch} isn't landing yet: its docs aren't official. Your spec drafts aren't promoted: ${draftsShown(drafts)}. Promote them on ${branch} and commit that (the user's go-ahead to merge covers it: don't ask for it again; delete a draft that holds nothing to land, and say so), so the branch shows Ready to land again. The merge round never promotes them.`;

/** The hand-back for a branch whose merge with master conflicts in the spec: the owner merges and promotes again on top. */
// layout 2 (each area's records beside its claim file): only the clashing areas are taken from master and redone.
export const specConflictText = (branch, files, layout = 1) => {
  const areas = [...new Set(files.filter((f) => /^\.sova\/spec\/claims\/.*\.(md|json)$/.test(f)).map((f) => f.replace(/\.(md|json)$/, "")))].sort();
  const take = layout === 2
    ? `take master's copy of only the areas that clashed, each claim file with its record file, with \`git checkout --no-overlay master -- ${areas.length ? areas.flatMap((a) => [`${a}.md`, `${a}.json`]).join(" ") : ".sova/spec/claims/<area>.md .sova/spec/claims/<area>.json"}\`, resolve the rest and commit the merge, promote again only your changes to those areas with the same --ids (re-record stale evidence)`
    : "take master's whole spec with `git checkout --no-overlay master -- .sova/spec/manifest.json .sova/spec/claims`, resolve the rest and commit the merge, promote your drafts again with the same --ids (re-record stale evidence)";
  return `${branch} isn't landing yet: merging master into it conflicts in the spec (${files.slice(0, 4).join(", ")}${files.length > 4 ? `, +${files.length - 4} more` : ""}). Merge master into ${branch} yourself and recover the spec as PROMOTE.md says: ${take}, and commit the claims (the user's go-ahead to merge covers it: don't ask for it again), so the branch shows Ready to land again.`;
};

/** The notice for a landed branch's owner. Drafts left unpromoted are named, with where their copy was kept. */
export const landedText = (branch, sha, drafts = [], kept = null) =>
  `${branch} is merged into master at ${sha.slice(0, 7)}. Don't touch master; start any new work on a fresh branch.` +
  (drafts.length ? ` Its docs didn't land with the code: its spec drafts ${drafts.some((d) => !d.ids) ? "may not be" : "weren't"} promoted: ${draftsShown(drafts)}. Promote them on a fresh branch from master, never on master itself: copy each draft's folder from ${kept}/ into that worktree's .sova/spec/drafts/, then promote and commit it there.` : "");

/** Files of the spec a merge left conflicted: the manifest and the claims (drafts are never tracked). */
export const specConflicts = (files) => files.filter((f) => f === ".sova/spec/manifest.json" || f.startsWith(".sova/spec/claims/"));
// A layout-2 record file (the records of one area, beside its claim file).
const isRecordFile = (f) => f.startsWith(".sova/spec/claims/") && f.endsWith(".json");

/** Drafts not confirmed promoted, each named with up to four of its § ids, or "status unreadable" (ids null). */
export const draftsShown = (drafts) =>
  drafts.map(({ name, ids }) => `${name} (${!ids ? "status unreadable" : `${ids.slice(0, 4).join(", ")}${ids.length > 4 ? `, +${ids.length - 4} more` : ""}`})`).join("; ");

/** Test files a node:test run, or scripts/run-tests.mjs on Bun (`FAIL <file>`), names as failing, relative to `root`. */
export function failingTestFiles(output, root) {
  const files = new Set();
  const re = /(?:test at |✖ |not ok \d+ - |^\s*FAIL )(?:file:\/\/)?(\S+?\.test\.[cm]?[jt]sx?)\b/gm;
  for (const m of output.matchAll(re)) {
    let f = m[1];
    if (isAbsolute(f)) {
      if (!root || !f.startsWith(`${root}/`)) continue;
      f = f.slice(root.length + 1);
    }
    if (!f.startsWith("..")) files.add(f);
  }
  return [...files].sort();
}

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** Whether the package.json in `tree` has the script `name` (none, or unreadable: no). */
export function hasScript(tree, name) {
  try {
    return typeof JSON.parse(readFileSync(join(tree, "package.json"), "utf8"))?.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

/** A step's timeout: the larger of its floor and twice the median of its earlier passing runs. */
export const timeoutFor = (floorMs, passedMs = []) => Math.max(floorMs, Math.round(2 * median(passedMs)));

/** A duration as people read it: "45s", "3m 20s", "1h 5m". */
export const durationShown = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** The integration step's timings key (§chat.merge-round/check-time): `test-int` for the whole tier, else the group
 *  set a landing runs, `test-int:core` or `test-int:core+trial`, so no set is ever estimated from another's runs. */
export const intKey = (plan) => (plan.full ? "test-int" : `test-int:${["core", ...plan.ran].join("+")}`);

/** The groups a check didn't run, as its result names them (§chat.merge-round/driver). */
export function skippedShown(skipped = []) {
  const untriggered = skipped.filter((s) => s.why !== "never").map((s) => `${s.title} (no change to its areas)`);
  const never = skipped.filter((s) => s.why === "never").map((s) => s.title);
  return [untriggered.length ? `Skipped: ${untriggered.join(", ")}` : null, never.length ? `Not run at landing: ${never.join(", ")}` : null].filter(Boolean);
}

/**
 * What a check should take: for each step `{label, key, floorMs, fallbackMs?, times?}`, the median of its earlier
 * passing runs in `timings` (else `fallbackMs`, the runner's estimate), times `times` (a suite's commands); the limit is
 * the sum of the steps' timeouts. A step with neither is unknown. → {expectedMs, limitMs, parts, unknown}
 */
export function expectedTime(steps, timings) {
  let expectedMs = 0;
  let limitMs = 0;
  const parts = [];
  const unknown = [];
  for (const s of steps) {
    const times = s.times ?? 1;
    const m = median(timings[s.key] ?? []);
    const ms = (m || s.fallbackMs || 0) * times;
    if (ms > 0) {
      expectedMs += ms;
      parts.push(`${s.label} ${durationShown(ms)}${m ? "" : " from recorded file times"}`);
    } else unknown.push(s.label);
    limitMs += timeoutFor(s.floorMs, timings[s.key]) * times;
  }
  return { expectedMs, limitMs, parts, unknown };
}

/** Text with the home directory written as `~`, so a local path never shows the home path and `~/…`
 *  still resolves (the worktree tool expands it). Its real path too, when the home is a symlink. */
export function homeShown(text, home = homedir()) {
  const homes = homesOf(home);
  if (!homes.length) return text;
  const re = new RegExp(`(?<![A-Za-z0-9._/~-])(?:${homes.map(escapeRe).join("|")})(?=/|$|[^A-Za-z0-9._-])`, "g");
  return text.replace(re, "~");
}

/** A local path as a shell argument: under the home directory `"$HOME"'/rest'`, else single-quoted. */
export function shellPath(path, home = homedir()) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  for (const h of homesOf(home)) {
    if (path === h) return `"$HOME"`;
    if (path.startsWith(`${h}/`)) return `"$HOME"${q(path.slice(h.length))}`;
  }
  return q(path);
}

function homesOf(home) {
  if (!home || !isAbsolute(home)) return [];
  const h = home.replace(/\/+$/, "");
  if (!h) return [];
  let real = h;
  try { real = realpathSync(h); } catch {}
  return [...new Set([h, real])].sort((a, b) => b.length - a.length);
}
/** A path as the board writes it: the real path, else as given. */
function canonicalPath(p) {
  try { return realpathSync(p); } catch { return p; }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each name masked, case-insensitively, longest first. */
export function maskerOf(names) {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return (s) => s;
  const re = new RegExp(list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (s) => s.replace(re, "[private name]");
}

/** One extension's line from pi-config/README.md's Tests block, as commands of argv (no shell). */
export function suiteOf(readme, ext) {
  const at = readme.indexOf("\n## Tests");
  if (at < 0) return null;
  const open = readme.indexOf("```", at);
  const close = open < 0 ? -1 : readme.indexOf("```", open + 3);
  if (close < 0) return null;
  const line = readme.slice(readme.indexOf("\n", open) + 1, close).split("\n").find((l) => l.startsWith(`cd extensions/${ext} && `));
  if (!line) return null;
  const cmds = line.split(" && ").map((c) => c.trim().split(/\s+/));
  return { dir: `extensions/${ext}`, commands: cmds.slice(1) };
}

/** A command's argv with `dir/*.ext` patterns expanded against `cwd` (one star, in the last segment). */
export function expandArgs(argv, cwd) {
  return argv.flatMap((a) => {
    if (!a.includes("*")) return [a];
    const d = dirname(a);
    const [pre, post] = basename(a).split("*");
    let names = [];
    try { names = readdirSync(join(cwd, d)); } catch {}
    const hits = names.filter((n) => n.startsWith(pre) && n.endsWith(post) && n.length >= pre.length + post.length).sort();
    return hits.length ? hits.map((n) => (d === "." ? n : `${d}/${n}`)) : [a];
  });
}

/** A changed file that makes `check` run the spec replay suite (a landing gate, never run while working). */
export const touchesSpecReplay = (file) =>
  /^pi-config\/extensions\/spec\/(?:core|tests\/replay)\//.test(file) || file === "pi-config/extensions/mode/spec-guard.ts";

/** A path glob as a whole-path RegExp: `**` any depth (`dir/**` the dir's every file), `*` within one segment, `?` one char. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

/** An area guide's front-matter (agents/**\/overview.md): its `watches` and `alsoUpdate` lists, each a
 *  JSON array on its key's line or a `- item` list under it. No front-matter: both empty. */
export function guideFrontMatter(text) {
  const out = { watches: [], alsoUpdate: [] };
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return out;
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1] in out ? kv[1] : null;
      if (key && kv[2].trim()) {
        try { out[key] = JSON.parse(kv[2]).filter((x) => typeof x === "string"); } catch { out[key] = []; }
        key = null;
      }
      continue;
    }
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (key && item) out[key].push(item[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return out;
}

/** Each area guide in `tree` (agents/**\/overview.md) with its front-matter; `area` is its folder under agents/. */
export function areaGuides(tree) {
  const guides = [];
  const walk = (rel) => {
    let entries = [];
    try { entries = readdirSync(join(tree, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name === "overview.md") {
        let text = "";
        try { text = readFileSync(join(tree, rel, e.name), "utf8"); } catch {}
        guides.push({ area: rel.slice("agents/".length) || "agents", guide: `${rel}/overview.md`, ...guideFrontMatter(text) });
      }
    }
  };
  walk("agents");
  return guides;
}

/** The landing nudge: each area a branch touched (a changed file its guide `watches`) whose
 *  `alsoUpdate` files it changed none of. Something to ask the owner about, never a need. */
export function alsoUpdateNudges(changed, guides) {
  const hit = (globs) => { const res = globs.map(globRe); return changed.filter((f) => res.some((r) => r.test(f))); };
  return guides
    .filter((g) => g.alsoUpdate.length && hit(g.watches).length && !hit(g.alsoUpdate).length)
    .map((g) => ({ area: g.area, guide: g.guide, touched: hit(g.watches), missing: g.alsoUpdate }));
}

/** A machine-wide lock file `{pid, at}`, created exclusively and whole (a hard link of a written
 *  file). The holder rewrites `at` every `beatMs` while it holds it; a lock whose `at` is older
 *  than `staleMs` is taken over, a fresher one is waited for. Never judged by pid: a holder in
 *  another PID namespace looks gone to `kill(pid, 0)`. Resolves to `{ release, waitedMs }`. */
export async function acquireLock(file, { pollMs = 5000, beatMs = 30_000, staleMs = 3 * 60_000, now = Date.now } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const started = now();
  let mine = JSON.stringify({ pid: process.pid, at: new Date(started).toISOString() });
  const draft = `${file}.${process.pid}.new`;
  writeFileSync(draft, mine, { mode: 0o600 });
  for (;;) {
    try {
      linkSync(draft, file);
      rmSync(draft, { force: true });
      const beat = setInterval(() => {
        // Rewritten whole beside the lock and renamed over it, only while it is still ours.
        try {
          if (readFileSync(file, "utf8") !== mine) return;
          const next = JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() });
          writeFileSync(`${file}.${process.pid}.beat`, next, { mode: 0o600 });
          renameSync(`${file}.${process.pid}.beat`, file);
          mine = next;
        } catch { rmSync(`${file}.${process.pid}.beat`, { force: true }); }
      }, beatMs);
      beat.unref();
      const release = () => { clearInterval(beat); try { if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true }); } catch {} };
      return { release, waitedMs: now() - started };
    } catch (e) {
      if (e.code !== "EEXIST") { rmSync(draft, { force: true }); throw e; }
    }
    let held = "";
    try { held = readFileSync(file, "utf8"); } catch { continue; }
    let holder = null;
    try { holder = JSON.parse(held); } catch {}
    if (!(now() - Date.parse(holder?.at) < staleMs)) {
      // Moved aside first, so a fresh lock taken meanwhile by another waiter is put back, not lost.
      const aside = `${file}.${process.pid}.stale`;
      try {
        renameSync(file, aside);
        if (readFileSync(aside, "utf8") !== held) linkSync(aside, file);
      } catch {}
      rmSync(aside, { force: true });
      continue;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------------------------------------
// Sova's merge board (`<state root>/merge-board.json`, server/merge-board.ts): who owns which
// worktree, as Sova's own readiness reads it. The driver reads the file; it never reads sessions,
// never calls Sova's API about them, and never holds Sova's token.

/** A board older than this can't be trusted: Sova rewrites it every minute while it runs. */
export const BOARD_STALE_MS = 5 * 60_000;
const BOARD_STATES = ["merged", "stale", "in-progress", "blocked", "ready", "waiting-approval", "removed"];
const OWNER_STATUSES = ["idle", "busy", "archived"];

// ---------------------------------------------------------------------------------------------
// Landing (§chat.worktrees/ready-to-land, §chat.offers/sova-landing): the board's `landing` per row,
// and the user's answers on the Landing card, or typed in the branch's own chat, which Sova keeps in
// `<state root>/landing.json`.

/** A row the captain may queue: Ready to land, or Landing specs whose owner said why they can't land (the card then
 *  offers Merge Without Specs…). */
export const landingEligible = (row, head) => !!row?.landing && row.landing.commit === head && (row.landing.state === "ready" || !!row.landing.specsWhy);

/** `landing.json`'s text → {goAheads, notYet} (a bad file reads as none). */
export function parseLanding(text) {
  let d;
  try { d = JSON.parse(text); } catch { return { goAheads: [], notYet: [] }; }
  const ok = (r) => typeof r?.branch === "string" && typeof r.commit === "string" && /^[0-9a-f]{40,64}$/.test(r.commit);
  return d?.v === 1 ? { goAheads: (Array.isArray(d.goAheads) ? d.goAheads : []).filter(ok), notYet: (Array.isArray(d.notYet) ? d.notYet : []).filter(ok) } : { goAheads: [], notYet: [] };
}

/** The user's newest answer on the Landing card for this branch at exactly this head: the go-ahead, or Not Yet. */
/** Both may be recorded at one commit: the later `at` wins, Not Yet a tie or a time that can't be read
 *  (landing.ts answerAt, held equal by server/merge-round-rules.test.ts). */
export const landingAnswer = (landing, branch, head) => {
  const go = landing.goAheads.filter((g) => g.branch === branch && g.commit === head).at(-1);
  const no = landing.notYet.filter((n) => n.branch === branch && n.commit === head).at(-1);
  if (go && (!no || Date.parse(go.at) > Date.parse(no.at))) return { kind: "go-ahead", withoutSpecs: go.withoutSpecs === true, by: go.by };
  return no ? { kind: "not-yet" } : null;
};

/** A go-ahead's words by where it was given: the Project Overseer's Merge Branch, the user's word in this chat, their
 *  word typed in the branch's own chat (`worktree land`), Land It. */
export const goAheadWord = (by) => (by === "page" ? "Merge Branch" : by === "chat" ? "word in this chat" : by === "owner-chat" ? "word typed in its own chat" : "Land It");

/** How many clean master merges a go-ahead carries through (§chat.merge-round/driver). */
export const CARRY_MAX = 20;

/**
 * The commit `merge` was made from when it is a clean merge of `target` into it (§chat.merge-round/driver):
 * exactly two parents, the second already on `target`, and its tree exactly what `git merge-tree --write-tree`
 * makes of them (no conflict, nothing edited by hand); `run(args)` runs git in the repository → {code, stdout}.
 */
export async function cleanMergeParent(run, merge, target) {
  const line = await run(["rev-list", "--parents", "-n", "1", merge]);
  const ids = line.code === 0 ? line.stdout.trim().split(/\s+/) : [];
  if (ids.length !== 3) return undefined;
  const [, first, second] = ids;
  const onTarget = await run(["merge-base", "--is-ancestor", second, `refs/heads/${target}`]);
  if (onTarget.code !== 0) return undefined;
  const [tree, made] = await Promise.all([run(["rev-parse", "--verify", "-q", `${merge}^{tree}`]), run(["merge-tree", "--write-tree", "--no-messages", first, second])]);
  if (tree.code !== 0 || made.code !== 0) return undefined;
  const want = tree.stdout.trim();
  return want && made.stdout.split("\n")[0]?.trim() === want ? first : undefined;
}

/**
 * landingAnswer carried over clean master merges: an answer recorded at an earlier commit counts at `head` when
 * every commit since is a clean master merge (`parentOf`, cleanMergeParent), up to CARRY_MAX, so the check's own
 * merge of master never cancels the user's Land It; `at` then names the commit it was given at. The walk stops at
 * the first commit with an answer (the head included), whose newest answer decides: a Not Yet there holds the
 * branch and is never walked past.
 */
export async function landingAnswerAt(landing, branch, head, parentOf) {
  const here = landingAnswer(landing, branch, head);
  if (here) return here;
  if (![...landing.goAheads, ...landing.notYet].some((g) => g.branch === branch)) return null;
  let sha = head;
  for (let i = 0; i < CARRY_MAX; i++) {
    const parent = await parentOf(sha).catch(() => undefined);
    if (!parent) return null;
    sha = parent;
    const a = landingAnswer(landing, branch, sha);
    if (a) return { ...a, at: sha };
  }
  return null;
}

/** The board file's text → {ok: true, board: {at, pending, rows}} | {ok: false, why}. */
export function parseBoard(text, now) {
  let b;
  try { b = JSON.parse(text); } catch { return { ok: false, why: "the merge board file isn't valid JSON" }; }
  const at = Date.parse(b?.at);
  if (b?.v !== 1 || !Array.isArray(b.rows) || !Number.isFinite(at)) return { ok: false, why: "the merge board file isn't one Sova wrote (version 1)" };
  if (now - at > BOARD_STALE_MS) return { ok: false, why: `the merge board was written ${ago(now - at)} ago (Sova rewrites it every minute while it runs: is Sova running?)` };
  const rows = b.rows.filter((r) =>
    typeof r?.path === "string" && typeof r.branch === "string" && BOARD_STATES.includes(r.state) &&
    typeof r.owner?.id === "string" && OWNER_STATUSES.includes(r.owner.status));
  return { ok: true, board: { at, pending: Number.isSafeInteger(b.pending) && b.pending > 0 ? b.pending : 0, rows } };
}

/**
 * Who owns a branch, and how fresh that is (§chat.merge-round/driver): the board's reading
 * (`rec.board`) unless the captain's hand note (`rec.owner`, `rec.notedAt`) is newer, and then only
 * for who the owner is. The owner's status (idle, busy, archived) and `at` come from the newest
 * reading of that owner, the board's or the note's. → null when neither names one.
 */
export function ownerOf(rec) {
  const note = rec?.owner ? { owner: rec.owner, status: rec.idle === "yes" ? "idle" : "busy", at: rec.notedAt ?? 0, from: "note" } : null;
  const board = rec?.board?.owner ? { owner: rec.board.owner, status: rec.board.status, at: rec.board.at ?? 0, from: "board" } : null;
  const who = note && (!board || note.at > board.at) ? note : board;
  if (!who) return null;
  const newest = [note, board].filter((r) => r?.owner === who.owner).sort((a, b) => b.at - a.at)[0];
  return { owner: who.owner, from: who.from, status: newest.status, at: newest.at, via: newest.from };
}

/** The owner's chat as the captain names it to the user: its title (from the board) and a link Sova opens. */
export function chatOf(rec, id) {
  const title = rec?.board?.owner === id && rec.board.title ? rec.board.title : null;
  const link = `#/sid/${encodeURIComponent(id)}`;
  return title ? `"${title.replace(/"/g, "'")}" (${link})` : `${id} (${link})`;
}

/** What to do next with a branch, in the order `status` lists them. */
export const GROUPS = [
  ["check", "to check", "The user's go-ahead at this head (Land It, their word in this chat, or typed in the branch's own chat): check it"],
  ["land", "to land", "Checked green at this head and master: land it"],
  ["ask", "to queue now", "Ready to land, owner idle: queue it (Sova shows the Landing card)"],
  ["waiting", "card shown", "Landing card shown: waits for the user's Land It, or \"land it\" typed in that chat"],
  ["busy", "owner busy", "Ready to land, owner busy: queue it on a later round"],
  ["archived", "owner archived", "Owner archived: the user's call (tell the user once)"],
  ["untracked", "no session tracks", "No session tracks this worktree: the user's call (tell the user once)"],
  ["unknown", "owner unknown", "Owner unknown: Sova hasn't read every session yet"],
  ["not-ready", "not ready", "Not ready"],
];

/**
 * A branch's group: `rec` its state record, `row` its board row (or null), `pending` the board's unread sessions,
 * `answer` the user's answer on the Landing card for this head (landingAnswerAt: carried over clean master merges,
 * so a Land It before the check's own merge of master still counts), `queued` Sova's answer to the captain's queue
 * entry for this head ({card} shown, {refused} not). A check that passed at this head and master lands; the
 * user's go-ahead at this head checks; the user's Not Yet holds it whatever the check says.
 */
export function groupOf({ rec, row, head, master, pending, answer = null, queued = null }) {
  const check = rec?.check;
  if (answer?.kind !== "not-yet") {
    if (check?.ok && check.head === head && check.masterSha === master) return "land";
    if (answer?.kind === "go-ahead") return "check";
  }
  const own = ownerOf(rec);
  if (!own) return pending > 0 ? "unknown" : "untracked";
  if (own.status === "archived") return "archived";
  if (answer?.kind === "not-yet" || !landingEligible(row, head)) return "not-ready";
  if (rec?.ask?.queued && rec.ask.head === head && queued && !queued.refused) return "waiting";
  return own.status === "idle" ? "ask" : "busy";
}

export const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)}m` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86400_000)}d`);

// ---------------------------------------------------------------------------------------------
// The CLI.

const MIN = 60_000;
const FLOORS = { typecheck: 5 * MIN, test: 20 * MIN, build: 10 * MIN, ext: 10 * MIN, replay: 30 * MIN, master: 10 * MIN };
const NOTE_FRESH_MS = 15 * MIN;
const DEFAULT_UNIT = "sova-runtime.service";
const MANIFEST = ".sova/spec/manifest.json";
const DRAFTS = ".sova/spec/drafts";
const HERE = dirname(fileURLToPath(import.meta.url));

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
}

class Exit extends Error {
  constructor(code, lines, next) {
    super(lines.join("\n"));
    this.code = code;
    this.lines = lines;
    this.next = next;
  }
}
const stop = (code, line, next) => { throw new Exit(code, [line], next); };

/** Runs one program by argv, in its own process group, killed whole at its timeout. */
export function run(cmd, args, { cwd, env = process.env, timeoutMs = 30_000, input, logFile } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const log = logFile ? createWriteStream(logFile, { mode: 0o600 }) : null;
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
      if (extra) err.push(Buffer.from(extra));
      const result = { code: timedOut ? null : code, timedOut, ms: Date.now() - started, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (log) log.end(() => done(result));
      else done(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      finish(null, e.message);
      return;
    }
    const keep = (into) => (d) => {
      log?.write(d);
      if (size < 8 * 1024 * 1024) { into.push(d); size += d.length; }
    };
    child.stdout.on("data", keep(out));
    child.stderr.on("data", keep(err));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000).unref();
    }, timeoutMs);
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    if (input !== undefined) child.stdin.end(input);
  });
}

function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", LC_ALL: "C" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  return { ...env, ...extra };
}
const git = (cwd, args, { env, timeoutMs = 30_000 } = {}) => run("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv(env), timeoutMs });
const firstLine = (r) => (r.stderr || r.stdout).split("\n").map((s) => s.trim()).find(Boolean) ?? (r.timedOut ? "timed out" : `exit ${r.code}`);
async function gitOut(cwd, args, what = args[0]) {
  const r = await git(cwd, args);
  if (r.code !== 0) stop(2, `git ${what} failed: ${firstLine(r)}`);
  return r.stdout.trim();
}

class Round {
  constructor(argv) {
    this.json = argv.includes("--json");
    this.background = argv.includes("--background");
    const repoAt = argv.indexOf("--repo");
    this.repoArg = repoAt >= 0 ? argv[repoAt + 1] : process.cwd();
    this.args = argv.filter((a, i) => a !== "--json" && a !== "--background" && !(repoAt >= 0 && (i === repoAt || i === repoAt + 1)));
    // Lines printed as they happen (the expected time, a rerun's cost), before the digest at the end.
    this.progress = [];
    this.agent = agentDir();
    this.stateRoot = join(this.agent, "sova");
    this.settingsFile = join(this.stateRoot, "merge-round.json");
    this.dir = join(this.stateRoot, "playbooks", "merge-round");
    this.stateFile = join(this.dir, "state.json");
    this.boardFile = join(this.stateRoot, "merge-board.json");
    this.landingFile = join(this.stateRoot, "landing.json");
    this.queueFile = join(this.stateRoot, "landing-queue.json");
    this.shownFile = join(this.stateRoot, "landing-shown.json");
    this.specCore = process.env.SOVA_ROUND_SPEC_CORE || join(this.agent, "extensions", "spec", "core");
    this.pnpm = process.env.SOVA_ROUND_PNPM || "pnpm";
    this.healthUrl = process.env.SOVA_ROUND_HEALTH_URL || "http://127.0.0.1:4800/api/health";
    this.floorOverride = Number(process.env.SOVA_ROUND_FLOOR_MS) || 0;
    this.lockPollMs = Number(process.env.SOVA_ROUND_LOCK_POLL_MS) || 5000;
    this.platform = process.env.SOVA_ROUND_PLATFORM || process.platform;
    this.settings = this.readSettings();
    this.mask = maskerOf(this.settings.names);
    this.now = Date.now();
  }

  readSettings() {
    let raw;
    try { raw = readFileSync(this.settingsFile, "utf8"); } catch { return { exists: false, names: [] }; }
    try {
      const s = JSON.parse(raw);
      const names = Array.isArray(s?.privateNames) ? s.privateNames.filter((x) => typeof x === "string" && x.trim()) : [];
      return { exists: true, valid: true, names, restartUnit: typeof s?.restartUnit === "string" ? s.restartUnit : undefined };
    } catch {
      return { exists: true, valid: false, names: [] };
    }
  }

  loadState() {
    let s = null;
    try { s = JSON.parse(readFileSync(this.stateFile, "utf8")); } catch {}
    if (!s || s.v !== 1) s = { v: 1 };
    for (const k of ["sessions", "branches", "masterRuns", "timings"]) if (!s[k] || typeof s[k] !== "object") s[k] = {};
    if (!Array.isArray(s.events)) s.events = [];
    this.state = s;
    return s;
  }

  saveState() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Keys too: a branch named after a private name is stored masked (and so never found again).
    const maskKeys = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [this.mask(k), x])) : v);
    const masked = JSON.parse(JSON.stringify(this.state), (_k, v) => (typeof v === "string" ? this.mask(v) : maskKeys(v)));
    masked.events = masked.events.slice(-200);
    const tmp = join(this.dir, `.state.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(masked, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.stateFile);
  }

  event(kind, fields) {
    this.state.events.push({ at: this.now, kind, ...fields });
  }

  /** A line printed at once, masked as the digest is (with --json it goes in the result's `progress` instead). */
  say(line) {
    this.progress.push(line);
    if (!this.json) process.stdout.write(`${this.mask(homeShown(line))}\n`);
  }

  sessionId(required = true) {
    const id = process.env.PI_SESSION_ID;
    if (!id && required) stop(2, "PI_SESSION_ID is not set, so this session can't be told apart. Run the round from the captain's session.");
    return id;
  }

  floor(step) {
    return this.floorOverride || FLOORS[step];
  }

  /** A local path holding a private name beyond its home prefix (the home path is listed too, so
   *  it is judged as printed: `~/…`). */
  privateIn(path) {
    const shown = homeShown(path);
    return this.mask(shown) !== shown;
  }

  /** leak-scan.mjs over what landing `head` would publish: the commits origin/master doesn't have.
   *  → {code: 0 clean | 1 hits | 2 couldn't scan, lines} */
  async leakScanTo(head) {
    const { main } = await this.repo();
    const origin = await git(main, ["rev-parse", "--verify", "-q", "refs/remotes/origin/master^{commit}"]);
    if (origin.code !== 0) return { code: 2, lines: ["leak-scan: no origin/master here, so what landing would publish can't be scanned."] };
    const range = `${origin.stdout.trim()}..${head}`;
    const scan = await run(process.execPath, [join(HERE, "leak-scan.mjs"), "--repo", main, "--range", range], { cwd: main, timeoutMs: 120_000 });
    const lines = `${scan.stdout}${scan.stderr}`.split("\n").filter(Boolean);
    return { code: scan.code === 0 || scan.code === 1 ? scan.code : 2, lines: lines.length ? lines : [`leak-scan: ${scan.timedOut ? "timed out" : `exit ${scan.code}`}.`] };
  }

  /** The restart need: whether the live server (GET /api/health, its `head`) lacks master's runtime
   *  code, whoever merged it. → {known: false, why} | {known: true, needed, files, head, startedAt} */
  async restartNeed() {
    let health = null;
    try {
      const res = await fetch(this.healthUrl, { signal: AbortSignal.timeout(3000) });
      health = res.ok ? await res.json() : null;
    } catch {}
    const master = await this.masterSha();
    const head = typeof health?.head === "string" && /^[0-9a-f]{7,64}$/.test(health.head) ? health.head : null;
    if (!head) return { known: false, master, why: health ? "the server's health names no head" : "the server's health can't be read" };
    const { main } = await this.repo();
    const d = await git(main, ["diff", "--name-only", head, master, "--"]);
    if (d.code !== 0) return { known: false, master, why: `the server's head ${head.slice(0, 7)} isn't in this repository` };
    const files = d.stdout.split("\n").filter(Boolean).filter(needsRestart);
    return { known: true, needed: files.length > 0, files, head, master, startedAt: health.startedAt };
  }

  /** Records a restart need in the state: pending while needed, confirmed once none. One that can't
   *  be told keeps a pending restart, and makes one only when `failClosed` (a merge just landed). */
  applyNeed(st, need, { merge, failClosed = false } = {}) {
    const was = st.restart?.pending ? st.restart : null;
    const pend = (line) => {
      st.restart = { pending: true, since: was?.since ?? this.now, merges: [...(was?.merges ?? []), ...(merge ? [merge] : [])], ...(need.known ? { serverHead: need.head } : {}) };
      return line;
    };
    if (need.known && !need.needed) {
      if (!was) return `The server runs ${need.head.slice(0, 7)}, with master ${need.master.slice(0, 7)}'s runtime code: no restart needed.`;
      st.restart = { pending: false, confirmedAt: this.now, startedAt: need.startedAt, head: need.head };
      this.event("restart-confirmed", { head: need.head });
      return `Restart confirmed: the server runs ${need.head.slice(0, 7)}, with master ${need.master.slice(0, 7)}'s runtime code.`;
    }
    if (need.known) {
      const n = need.files.length;
      return pend(`Restart needed: the server runs ${need.head.slice(0, 7)}, and master ${need.master.slice(0, 7)} changes ${n} file${n === 1 ? "" : "s"} that need one (${need.files.slice(0, 3).join(", ")}${n > 3 ? ` and ${n - 3} more` : ""}).`);
    }
    if (was) return pend(`Restart pending since ${ago(this.now - was.since)} ago; ${need.why}, so it isn't confirmed.`);
    if (failClosed) return pend(`Whether the server runs master's code can't be told (${need.why}): a restart is treated as needed.`);
    return `Whether the server runs master's code can't be told: ${need.why}.`;
  }

  // --- the merge board --------------------------------------------------------------------

  /** Sova's merge board → {ok: true, board} | {ok: false, why}. */
  readBoard() {
    let text;
    try { text = readFileSync(this.boardFile, "utf8"); } catch (e) {
      return { ok: false, why: e?.code === "ENOENT" ? "the merge board file is missing (Sova writes it every minute while it runs)" : `the merge board file can't be read (${e?.code ?? "error"})` };
    }
    return parseBoard(text, this.now);
  }

  /** The user's answers: on Landing cards and typed in a branch's own chat (Sova's `landing.json`), and their word in
   *  this chat (`go`), a go-ahead alike. */
  readLanding() {
    let l;
    try { l = parseLanding(readFileSync(this.landingFile, "utf8")); } catch { l = { goAheads: [], notYet: [] }; }
    for (const [branch, r] of Object.entries(this.state?.branches ?? {}))
      if (r.go) l.goAheads.push({ branch, commit: r.go.head, at: new Date(r.go.at).toISOString(), by: "chat", withoutSpecs: !!r.go.withoutSpecs });
    return l;
  }

  /** Sova's answer to one queue entry: {card} shown, {refused} not, or null while it hasn't read it. */
  queueResult(id) {
    if (!id) return null;
    try {
      const d = JSON.parse(readFileSync(this.shownFile, "utf8"));
      const r = d?.v === 1 ? d.results?.[id] : null;
      return r && (typeof r.card === "string" || typeof r.refused === "string") ? r : null;
    } catch { return null; }
  }

  /** Append one entry to the landing queue Sova reads (§chat.offers/sova-landing); the last 100 are kept. */
  enqueue(entry) {
    let entries = [];
    try {
      const d = JSON.parse(readFileSync(this.queueFile, "utf8"));
      if (d?.v === 1 && Array.isArray(d.entries)) entries = d.entries;
    } catch {}
    entries = [...entries.filter((e) => e?.id !== entry.id), entry].slice(-100);
    mkdirSync(this.stateRoot, { recursive: true });
    const tmp = `${this.queueFile}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, entries }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.queueFile);
  }

  /** The board's row for a worktree: same canonical path, same branch. Rows elsewhere are ignored. */
  boardRow(board, path, branch) {
    const want = canonicalPath(path);
    return board.rows.find((r) => r.branch === branch && canonicalPath(r.path) === want) ?? null;
  }

  /** Records the board's reading of a branch in its state record (and forgets one the board no
   *  longer shows, once it has read every session). */
  recordBoard(st, branch, row, board) {
    if (row) {
      const rec = (st.branches[branch] ??= {});
      rec.board = { owner: row.owner.id, ...(typeof row.owner.title === "string" && row.owner.title.trim() ? { title: row.owner.title.trim().slice(0, 80) } : {}), status: row.owner.status, state: row.state, reason: row.reason ?? row.state, at: board.at };
    } else if (board.pending === 0 && st.branches[branch]?.board) delete st.branches[branch].board;
  }

  // --- the repository ---------------------------------------------------------------------

  async repo() {
    if (this.repoInfo) return this.repoInfo;
    const list = await gitOut(this.repoArg, ["worktree", "list", "--porcelain"], "worktree list");
    const trees = [];
    let cur = null;
    for (const line of list.split("\n")) {
      if (line.startsWith("worktree ")) trees.push((cur = { path: line.slice(9) }));
      else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
      else if (cur && line === "bare") cur.bare = true;
    }
    if (!trees.length || trees[0].bare) stop(2, "no main checkout found (a bare repository?).");
    const main = trees[0].path;
    const commonDir = await gitOut(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "rev-parse");
    this.repoInfo = { main, commonDir, trees: trees.filter((t) => existsSync(t.path)) };
    return this.repoInfo;
  }

  async masterSha() {
    const { main } = await this.repo();
    return gitOut(main, ["rev-parse", "--verify", "refs/heads/master^{commit}"], "rev-parse master");
  }

  async branchArg(i = 1) {
    const b = this.args[i];
    if (!b || !/^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(b) || b === "master") stop(2, `usage: round.mjs ${this.args[0]} <branch> (a local branch other than master).`);
    const { main, trees } = await this.repo();
    const r = await git(main, ["rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`]);
    if (r.code !== 0) stop(1, `no local branch ${b}.`);
    return { branch: b, head: r.stdout.trim(), tree: trees.find((t) => t.branch === b)?.path };
  }

  async dirtyIn(path) {
    const r = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (r.code !== 0) stop(2, `git status failed in a worktree: ${firstLine(r)}`);
    return dirtyPaths(r.stdout);
  }

  /** The user's answer on the Landing card for `branch` at `head`, a go-ahead carried over clean master merges
   *  (landingAnswerAt); merge-tree's objects go to a throwaway object directory. */
  async answerAt(landing, branch, head) {
    const { main, commonDir } = await this.repo();
    const parentOf = async (sha) => {
      const scratch = mkdtempSync(join(tmpdir(), "sova-round-carry-"));
      try {
        const runIn = (args) => git(main, args, args[0] === "merge-tree" ? { env: { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects") } } : {});
        return await cleanMergeParent(runIn, sha, "master");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
    return landingAnswerAt(landing, branch, head, parentOf);
  }

  /** How many files a merge of `head` into master conflicts in, its new objects in a throwaway object directory. */
  async trialConflicts(master, head) {
    const { main, commonDir } = await this.repo();
    const scratch = mkdtempSync(join(tmpdir(), "sova-round-merge-tree-"));
    try {
      const r = await git(main, ["merge-tree", "--write-tree", "--no-messages", master, head], { env: { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects") } });
      if (r.code === 0) return 0;
      if (r.code === 1) return conflictedFiles(r.stdout);
      return `merge-tree failed: ${firstLine(r)}`;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async branchFacts(branch, path, master) {
    const { main } = await this.repo();
    const [counts, subjects, last, changed] = await Promise.all([
      gitOut(main, ["rev-list", "--left-right", "--count", `${master}...refs/heads/${branch}`], "rev-list"),
      gitOut(main, ["log", "--format=%s", `${master}..refs/heads/${branch}`], "log"),
      gitOut(main, ["log", "-1", "--format=%ct", `refs/heads/${branch}`], "log"),
      gitOut(main, ["diff", "--name-only", `${master}...refs/heads/${branch}`], "diff"),
    ]);
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    const dirty = await this.dirtyIn(path);
    return {
      ahead, behind, dirty,
      temp: tempCommitOf(subjects ? subjects.split("\n") : []),
      lastCommitAt: Number(last) * 1000,
      changed: changed ? changed.split("\n") : [],
    };
  }

  async mainFacts() {
    const { main } = await this.repo();
    const ref = await git(main, ["symbolic-ref", "-q", "HEAD"]);
    const onMaster = ref.code === 0 && ref.stdout.trim() === "refs/heads/master";
    const dirty = await this.dirtyIn(main);
    const origin = await git(main, ["rev-list", "--left-right", "--count", "refs/remotes/origin/master...refs/heads/master"]);
    const [behind, ahead] = origin.code === 0 ? origin.stdout.trim().split(/\s+/).map(Number) : [null, null];
    return { onMaster, dirty: dirty.length, ahead, behind };
  }

  // --- commands ---------------------------------------------------------------------------

  async start() {
    const sid = this.sessionId();
    const st = this.loadState();
    const first = !st.sessions[sid];
    if (first) st.sessions[sid] = { firstRoundAt: this.now, hold: !this.settings.exists };
    const sess = st.sessions[sid];
    sess.roundStartedAt = this.now;
    sess.firstRound = first;
    const lines = [];
    if (first) {
      lines.push("First round of this session: run the start interview.");
      lines.push(this.settings.exists
        ? "Settings present: run scripts/discover-names.mjs --show, show the list in this chat only, and ask whether it's right or needs more."
        : "Settings missing: run scripts/discover-names.mjs, then add the user's answers. The push hold is on until `round.mjs names-answered`.");
    } else lines.push("Later round: run scripts/discover-names.mjs (no --show) to pick up new names.");
    if (!this.settings.exists && !first) lines.push("Settings missing: the leak scan can't run, so nothing can be pushed.");
    lines.push(`Push hold: ${sess.hold ? "on (the user hasn't answered the start interview)" : "off"}.`);
    lines.push(this.applyNeed(st, await this.restartNeed()));
    this.saveState();
    return { exit: first ? 1 : 0, lines, next: first ? "the start interview, then `round.mjs status`" : "round.mjs status" };
  }

  async namesAnswered() {
    const sid = this.sessionId();
    const st = this.loadState();
    if (!st.sessions[sid]) stop(2, "This session has no round yet: run `round.mjs start` first.");
    if (!this.settings.valid || !this.settings.names.length) stop(2, "The settings file is missing, unreadable or lists no names: add the answers with scripts/discover-names.mjs first.");
    st.sessions[sid].hold = false;
    st.sessions[sid].answeredAt = this.now;
    this.saveState();
    return { exit: 0, lines: ["Push hold lifted for this session."], next: "round.mjs status" };
  }

  async status() {
    const st = this.loadState();
    const { trees } = await this.repo();
    const master = await this.masterSha();
    const read = this.readBoard();
    const board = read.ok ? read.board : null;
    const landing = this.readLanding();
    const branches = [];
    for (const t of trees.slice(1)) {
      if (!t.branch || t.branch === "master") continue;
      const f = await this.branchFacts(t.branch, t.path, master);
      if (f.ahead === 0) continue;
      const conflicts = await this.trialConflicts(master, `refs/heads/${t.branch}`);
      const head = t.head;
      const row = board ? this.boardRow(board, t.path, t.branch) : null;
      if (board) this.recordBoard(st, t.branch, row, board);
      const rec = st.branches[t.branch] ?? {};
      const own = board ? ownerOf(rec) : null;
      const answer = await this.answerAt(landing, t.branch, head);
      const queued = rec.ask?.queued && rec.ask.head === head ? this.queueResult(rec.ask.queued) : null;
      const group = board ? groupOf({ rec, row, head, master, pending: board.pending, answer, queued }) : "unknown";
      const parts = [];
      parts.push(row ? row.reason : board ? "no readiness on the board" : "readiness unknown");
      if (!board) parts.push("owner unknown");
      else if (own) parts.push(`owner ${own.owner} ${own.status} (${own.via === "board" ? "board" : "your note"}, ${ago(this.now - own.at)} ago${own.from === "note" && own.via === "note" && rec.board ? "; your note is newer than the board" : ""})`);
      else parts.push(board.pending ? `owner unknown: Sova hasn't read ${board.pending} session${board.pending === 1 ? "" : "s"} yet` : "no session tracks this worktree");
      parts.push(`+${f.ahead}/-${f.behind}`, f.dirty.length ? `${f.dirty.length} uncommitted (${f.dirty[0]}${f.dirty.length > 1 ? ` and ${f.dirty.length - 1} more` : ""})` : "clean");
      if (f.temp) parts.push(`temporary commit: "${f.temp.slice(0, 60)}"`);
      parts.push(typeof conflicts === "number" ? (conflicts ? `conflicts with master in ${conflicts} file${conflicts === 1 ? "" : "s"}` : "merges cleanly") : conflicts);
      parts.push(`last commit ${ago(this.now - f.lastCommitAt)} ago`);
      if (answer?.kind === "go-ahead") parts.push(`the user's go-ahead (${goAheadWord(answer.by)}) at ${(answer.at ?? head).slice(0, 7)}${answer.at ? `, carried to ${head.slice(0, 7)} over clean master merges` : ""}${answer.withoutSpecs ? ", without its specs" : ""}`);
      else if (answer?.kind === "not-yet") parts.push(`the user said Not Yet at ${(answer.at ?? head).slice(0, 7)}: it waits for a new commit`);
      if (rec.ask?.queued) parts.push(`queued ${ago(this.now - rec.ask.at)} ago at ${rec.ask.head.slice(0, 7)}${rec.ask.head !== head ? " (the head moved since)" : queued ? (queued.refused ? `; Sova didn't show the card: ${queued.refused}` : `; Landing card shown in ${chatOf(rec, rec.ask.owner)}`) : "; Sova hasn't read the queue yet"}`);
      if (rec.check) parts.push(`last check: ${rec.check.ok ? "landable" : "needs work"} at ${rec.check.head.slice(0, 7)}`);
      const restartNeeded = f.changed.some(needsRestart);
      if (restartNeeded) parts.push("landing needs a restart");
      branches.push({
        branch: t.branch, path: t.path, head, group, line: `${t.branch}: ${parts.join(" · ")}`,
        state: row?.state ?? null, reason: row?.reason ?? null,
        owner: own?.owner ?? null, ownerStatus: own?.status ?? null, ownerFrom: own?.from ?? null,
        ahead: f.ahead, behind: f.behind, dirty: f.dirty.length, temp: !!f.temp, conflicts, lastCommitAgoMs: this.now - f.lastCommitAt,
        ask: rec.ask ? { agoMs: this.now - rec.ask.at, ...(rec.ask.queued ? { queued: queued ? (queued.refused ? { refused: queued.refused } : { card: queued.card }) : null } : {}) } : null, restartNeeded,
        landing: row?.landing ?? null, userAnswer: answer,
      });
    }
    const lines = [];
    if (board) {
      const n = (k) => branches.filter((b) => b.group === k).length;
      lines.push(`Merge board (written ${ago(this.now - board.at)} ago${board.pending ? `, ${board.pending} session${board.pending === 1 ? "" : "s"} not read yet` : ""}): ${GROUPS.map(([k, short]) => `${n(k)} ${short}`).join(" · ")}.`);
      for (const [k, , head] of GROUPS) {
        const of = branches.filter((b) => b.group === k);
        if (!of.length) continue;
        lines.push(`== ${head} (${of.length})`);
        for (const b of of) lines.push(b.line);
      }
    } else {
      lines.push(`Owners unknown: ${read.why}. Git facts only; land nothing until the board is back.`);
      for (const b of branches) lines.push(b.line);
    }
    if (!branches.length) lines.push("No local branch with a worktree is ahead of master.");
    const m = await this.mainFacts();
    lines.push(`Main checkout: ${m.onMaster ? "on master" : "NOT on master"}, ${m.dirty} uncommitted, ${m.ahead === null ? "no origin/master" : `+${m.ahead}/-${m.behind} vs origin/master`}.`);
    if (st.restart?.pending) lines.push(`Restart pending since ${ago(this.now - st.restart.since)} ago.`);
    st.lastStatus = {
      at: this.now, board: !!board,
      forUser: branches.filter((b) => b.group === "archived" || b.group === "untracked").map((b) => ({ branch: b.branch, head: b.head, group: b.group })),
      // Cards Sova showed at the current head, still waiting for the user: the report names each owner's chat.
      waiting: branches.filter((b) => b.group === "waiting").map((b) => ({ branch: b.branch, head: b.head, chat: chatOf(st.branches[b.branch], st.branches[b.branch]?.ask?.owner ?? b.owner) })),
    };
    this.saveState();
    const first = (k) => branches.find((b) => b.group === k)?.branch;
    const next = !board ? "say owners are unknown and why; land nothing this round"
      : first("check") ? `round.mjs check ${first("check")}`
      : first("land") ? `round.mjs land ${first("land")}`
      : first("ask") ? `round.mjs ask ${first("ask")} (Ready to land: queues it, and Sova shows its owner the Landing card)`
      : "round.mjs report";
    return { exit: !board ? 2 : m.onMaster && m.dirty === 0 ? 0 : 1, lines, data: { master, board: board ? { at: new Date(board.at).toISOString(), pending: board.pending } : { error: read.why }, branches: branches.map(({ line, ...b }) => b), main: m }, next };
  }

  async note() {
    const { branch } = await this.branchArg();
    const kv = Object.fromEntries(this.args.slice(2).map((a) => { const i = a.indexOf("="); return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, ""]; }));
    const unknown = Object.keys(kv).filter((k) => !["owner", "idle"].includes(k));
    if (unknown.length) stop(2, `unknown field ${unknown[0]}: owner=, idle= only (the user's word to land a branch is round.mjs go <branch>).`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(kv.owner ?? "")) stop(2, "owner=<session id> is required (the id session_detail shows).");
    if (!["yes", "no"].includes(kv.idle)) stop(2, "idle=yes|no is required.");
    const st = this.loadState();
    const rec = (st.branches[branch] ??= {});
    if (rec.owner && rec.owner !== kv.owner) delete rec.ask;
    Object.assign(rec, { owner: kv.owner, idle: kv.idle, notedAt: this.now });
    this.saveState();
    return { exit: 0, lines: [`Noted ${branch}: owner ${kv.owner}, ${kv.idle === "yes" ? "idle" : "busy"}.`], next: "round.mjs status" };
  }

  /** The user's word in this chat to land a branch: their go-ahead at its head, read as a Land It (readLanding). */
  async go() {
    const { branch, head } = await this.branchArg();
    const extra = this.args.slice(2);
    if (extra.some((a) => a !== "without-specs")) stop(2, "usage: round.mjs go <branch> [without-specs]");
    const st = this.loadState();
    (st.branches[branch] ??= {}).go = { head, at: this.now, ...(extra.length ? { withoutSpecs: true } : {}) };
    this.event("go", { branch, head });
    this.saveState();
    return { exit: 0, lines: [`The user's word: land ${branch} at ${head.slice(0, 7)}${extra.length ? ", without its specs" : ""}. It is their go-ahead, as Land It is.`], next: `round.mjs check ${branch}` };
  }

  async ask() {
    const { branch, head, tree } = await this.branchArg();
    if (this.args.length > 2) stop(2, "usage: round.mjs ask <branch>");
    const st = this.loadState();
    // The board's reading first: it may be newer than any note (§chat.merge-round/driver).
    const read = this.readBoard();
    const row = read.ok && tree ? this.boardRow(read.board, tree, branch) : null;
    if (read.ok && tree) this.recordBoard(st, branch, row, read.board);
    const rec = st.branches[branch] ?? {};
    const own = ownerOf(rec);
    if (!own) stop(1, `No owner known for ${branch}: ${read.ok ? (read.board.pending ? "Sova hasn't read every session yet" : "no session tracks its worktree, so it is the user's call") : `owners are unknown (${read.why})`}.`, read.ok && !read.board.pending ? "tell the user once; land it only on their word" : "round.mjs status on a later round");
    if (own.status === "archived") stop(1, `${own.owner} is archived: no card can reach it, so ${branch} is the user's call.`, "tell the user once; land it only on their word");
    if (own.status !== "idle") stop(1, `${own.owner} was busy when last read: never ask a busy session. Try next round.`, "the next branch");
    if (this.now - own.at > NOTE_FRESH_MS) stop(1, `The newest reading of ${own.owner} on ${branch} is ${ago(this.now - own.at)} old: run round.mjs status again (Sova rewrites its board every minute), or note it by hand.`, "round.mjs status");
    // Ready to land at this head: queued, and Sova shows the owner the Landing card itself (§chat.offers/sova-landing).
    const prior = rec.ask?.queued && rec.ask.head === head ? this.queueResult(rec.ask.queued) : null;
    if (prior?.refused) stop(1, `Sova didn't show ${branch}'s Landing card at ${head.slice(0, 7)}: ${prior.refused}.`, "tell the user once that it lands on their word, \"land it\" typed in its own chat or \"land <branch>\" here (round.mjs go); never to press a card");
    if (!landingEligible(row, head)) stop(1, `${branch} isn't Ready to land at ${head.slice(0, 7)}: nothing to queue.`, "the next branch");
    if (rec.ask?.queued && rec.ask.head === head) stop(1, `${branch} is already queued at ${head.slice(0, 7)}${prior ? `: its Landing card is shown in ${chatOf(rec, rec.ask.owner)}` : ""}. The user's Land It, or their \"land it\" typed there, reaches you by itself.`, "the next branch");
    const captain = this.sessionId();
    const id = `lq_${head.slice(0, 12)}_${this.now.toString(36)}`;
    this.enqueue({ id, branch, path: tree, head, owner: own.owner, captain, at: this.now });
    st.branches[branch] = rec;
    rec.ask = { at: this.now, owner: own.owner, head, queued: id };
    this.event("queued", { branch, owner: own.owner });
    this.saveState();
    const specs = row.landing.state === "specs" ? ` Its spec drafts can't land (${row.landing.specsWhy}): the card offers Merge Without Specs….` : "";
    return { exit: 0, lines: [`Queued ${branch} at ${head.slice(0, 7)}: Sova shows the Landing card in ${chatOf(rec, own.owner)}.${specs}`], data: { owner: own.owner, queued: id }, next: "don't poll: the user's Land It reaches you as a message, and their \"land it\" typed in that chat as a merge-ready wake; round.mjs status says whether the card was shown" };
  }

  // Master's record layout (1 or 2), from its committed manifest.json settings.
  async masterLayout() {
    const { main } = await this.repo();
    const r = await git(main, ["show", `refs/heads/master:${MANIFEST}`]);
    try { return r.code === 0 && JSON.parse(r.stdout).formatVersion === 2 ? 2 : 1; } catch { return 1; }
  }
  // The spec's records in `tree` as the core reads them (`records`): "ok", "mixed" (held both ways), "broken" (they
  // don't read: an unreadable manifest, a bad record file) or "unknown" (no answer). Only "ok" lets a merge commit.
  async recordsState(tree) {
    if (!existsSync(join(tree, MANIFEST))) return { state: "ok" };
    // A spec with no spec tool to read it can't be told apart from a mixed one: never committed unread.
    if (!existsSync(join(this.specCore, "sova-spec.mjs"))) return { state: "unknown", why: "no spec tool to read the records" };
    const r = await run(process.execPath, [join(this.specCore, "sova-spec.mjs"), "records", "--root", tree, "--json"], { cwd: tree, timeoutMs: 60_000 });
    let j;
    try { j = JSON.parse(r.stdout); } catch { return { state: "unknown", why: r.timedOut ? "the spec tool timed out" : `the spec tool printed no JSON (exit ${r.code})` }; }
    const findings = Array.isArray(j?.findings) ? j.findings : [];
    if (findings.some((f) => f.code === "layout-mixed")) return { state: "mixed" };
    const bad = findings.find((f) => f.severity === "error");
    if (bad || j?.exit === 2 || r.code === 2) return { state: "broken", why: bad ? `${bad.code}: ${bad.message}` : `exit ${r.code}` };
    return { state: "ok" };
  }
  // merge-manifest --write over a merge in progress, then the files it wrote staged when the spec checks.
  async mergeRecords(tree) {
    const mm = await run(process.execPath, [join(this.specCore, "sova-spec-draft.mjs"), "merge-manifest", "--write", "--root", tree, "--json"], { cwd: tree, timeoutMs: 60_000 });
    let out = {};
    try { out = JSON.parse(mm.stdout); } catch { out = {}; }
    const files = Array.isArray(out.files) && out.files.length ? out.files : [MANIFEST];
    const what = files.length > 1 || files[0] !== MANIFEST ? "The spec's records" : "manifest.json";
    const ok = mm.code === 0 && (await run(process.execPath, [join(this.specCore, "sova-spec.mjs"), "check", "--root", tree, "--json"], { cwd: tree, timeoutMs: 60_000 })).code !== 2;
    if (ok) await gitOut(tree, ["add", "-A", "--", ...files], "add");
    return { ok, what, why: mm.timedOut ? "timed out" : `exit ${mm.code}` };
  }

  async check() {
    const { branch, tree, head: before } = await this.branchArg();
    const extra = this.args.slice(2);
    if (extra.some((a) => a !== "full")) stop(2, "usage: round.mjs check <branch> [full] [--background]");
    if (this.background) return this.checkBackground(branch, extra.includes("full"));
    if (!tree) stop(1, `${branch} has no worktree: the round works only in a branch's own worktree.`);
    const { main } = await this.repo();
    const st = this.loadState();
    let master = await this.masterSha();
    const f = await this.branchFacts(branch, tree, master);
    if (f.ahead === 0) stop(1, `${branch} has no commit ahead of master.`);
    if (f.dirty.length) stop(1, `${branch} has ${f.dirty.length} uncommitted file${f.dirty.length === 1 ? "" : "s"} (${f.dirty[0]}${f.dirty.length > 1 ? ` and ${f.dirty.length - 1} more` : ""}): hand it back to the owner.`);
    if (f.temp) stop(1, `${branch} has a temporary commit ("${f.temp.slice(0, 60)}"): hand it back to the owner.`);
    if ((await git(tree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0) stop(1, `A merge is in progress in ${tree}: finish or abort it first.`);
    const lines = [];

    // Merge current master into the branch, in its own worktree.
    if (f.behind > 0) {
      // Stopped before its commit, so the spec's record layout is looked at after every merge (below).
      const m = await git(tree, ["merge", "--no-edit", "--no-commit", "refs/heads/master"], { timeoutMs: 120_000 });
      if (m.code !== 0) {
        let conflicted = (await gitOut(tree, ["diff", "--name-only", "--diff-filter=U"], "diff")).split("\n").filter(Boolean);
        if (!conflicted.length) stop(2, `git merge master failed in ${tree}: ${firstLine(m)}`);
        // The records (manifest.json, or per-area claims/**/*.json record files) merge per record, across layouts too.
        if (conflicted.includes(MANIFEST) || conflicted.some(isRecordFile)) {
          const mm = await this.mergeRecords(tree);
          if (mm.ok) lines.push(`${mm.what} conflict merged by the spec tool's merge-manifest --write.`);
          else lines.push(`${mm.what}: merge-manifest --write didn't resolve it (${mm.why}).`);
          conflicted = (await gitOut(tree, ["diff", "--name-only", "--diff-filter=U"], "diff")).split("\n").filter(Boolean);
        }
        const spec = specConflicts(conflicted);
        if (spec.length) {
          // The spec is never resolved here: the owner merges master in and promotes again on top of it.
          const ab = await git(tree, ["merge", "--abort"], { timeoutMs: 60_000 });
          if (ab.code !== 0) stop(2, `git merge --abort failed in ${tree}: ${firstLine(ab)}`);
          const rec = (st.branches[branch] ??= {});
          rec.check = { head: before, masterSha: master, ok: false, needs: ["spec conflict with master: handed back"], flaky: [], preexisting: [], skipped: [], full: false, at: this.now };
          this.event("check", { branch, head: before, ok: false });
          this.saveState();
          const who = rec.ask?.owner ?? ownerOf(rec)?.owner;
          return { exit: 1, lines: [...lines, `Merging master into ${branch} conflicts in the spec (${spec.join(", ")}): the merge was aborted, so ${tree} is as it was. Handed back: its owner merges master in and promotes again on top.`, who ? `session_send to ${who}:` : "For its owner (none known: the user's call):", specConflictText(branch, spec, spec.some(isRecordFile) || (await this.masterLayout()) === 2 ? 2 : 1)], next: who ? "send the hand-back (only when the owner is idle); check again once it shows Ready to land at a new head" : "tell the user: no owner is known to re-promote it" };
        }
        if (conflicted.length) {
          return { exit: 1, lines: [...lines, `Merging master into ${branch} conflicts in ${conflicted.length} file${conflicted.length === 1 ? "" : "s"}: ${conflicted.slice(0, 5).join(", ")}${conflicted.length > 5 ? ` and ${conflicted.length - 5} more` : ""}.`, `They're left in ${tree} for you; if one isn't clear-cut, ask the owner.`], next: `resolve, commit in ${tree}, then round.mjs check ${branch}` };
        }
      }
      // After every merge, before its commit, the spec's records must read: a spec left holding records both ways (one
      // side's single manifest.json list, the other's per-area record files) is finished here, per record; one whose
      // records don't read, or that the tool can't answer for, is never committed: the merge is aborted.
      let rs = await this.recordsState(tree), finished = false;
      if (rs.state === "mixed") {
        const mm = await this.mergeRecords(tree);
        rs = mm.ok ? await this.recordsState(tree) : { state: "mixed", why: `merge-manifest --write: ${mm.why}` };
        finished = rs.state === "ok";
        if (rs.state === "mixed" && mm.ok) rs.why = "still mixed after merge-manifest --write";
      }
      if (rs.state !== "ok") {
        const ab = await git(tree, ["merge", "--abort"], { timeoutMs: 60_000 });
        if (ab.code !== 0) stop(2, `git merge --abort failed in ${tree}: ${firstLine(ab)}`);
        const what = rs.state === "mixed" ? "leaves its spec holding records both ways, and it couldn't be finished" : rs.state === "broken" ? "leaves spec records that don't read" : "leaves a spec whose records the spec tool couldn't read";
        return { exit: 1, lines: [...lines, `Merging master into ${branch} ${what} (${rs.why ?? "no reason given"}): the merge was aborted, so ${tree} is as it was.`],
          next: rs.state === "mixed" ? `merge master in ${tree} by hand and run sova-spec-draft.mjs merge-manifest --root ${tree} --write before committing, then round.mjs check ${branch}` : `look at the spec's records in ${tree} merged with master (sova-spec.mjs records --json), then round.mjs check ${branch}` };
      }
      if (finished) lines.push("The merge left the spec holding records both ways; merge-manifest --write finished it per record.");
      const c = await git(tree, ["commit", "--no-edit"], { timeoutMs: 60_000 });
      if (c.code !== 0) stop(2, `committing the merge failed in ${tree}: ${firstLine(c)}`);
      lines.push(`Merged master ${master.slice(0, 7)} into ${branch}.`);
    }
    const head = await gitOut(main, ["rev-parse", `refs/heads/${branch}`], "rev-parse");
    master = await this.masterSha();
    const changed = (await gitOut(main, ["diff", "--name-only", `${master}...${head}`], "diff")).split("\n").filter(Boolean);

    // The checks, each in its own process group with a log.
    const logDir = join(this.dir, "logs", `${new Date(this.now).toISOString().replace(/[:.]/g, "-")}-${branch.replace(/[^A-Za-z0-9._-]/g, "_")}`);
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    // Inherited from a node --test above us, it makes a suite's node --test skip every file and pass.
    delete env.NODE_TEST_CONTEXT;
    const needs = [];
    const flaky = [];
    const preexisting = [];
    const step = async (key, floorKey, label, cmd, args, cwd, extraEnv = {}) => {
      const timeoutMs = timeoutFor(this.floor(floorKey), st.timings[key]);
      const r = await run(cmd, args, { cwd, env: { ...env, ...extraEnv }, timeoutMs, logFile: join(logDir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.log`) });
      if (r.code === 0) st.timings[key] = [...(st.timings[key] ?? []), r.ms].slice(-9);
      const said = r.timedOut ? `TIMED OUT at ${Math.round(timeoutMs / 1000)}s (process group killed)` : r.code === 0 ? "ok" : `FAILED (exit ${r.code})`;
      lines.push(`${label}: ${said}, ${Math.round(r.ms / 1000)}s.`);
      return r;
    };
    // Which integration tests run (§app.server-runtime/test-tiers): the branch's own runner picks the everyday set
    // plus each slow group its changes trigger; a full run, or a tree with no test groups, runs the whole tier.
    const intPlan = hasScript(tree, "test:int") ? await this.integrationPlan(tree, master, env, extra.includes("full") || !!st.full?.on) : null;
    // The extension suites this check runs (their Tests lines), known before any step runs.
    const nice = join(tree, "scripts", "nice.mjs");
    const niced = (cmd, args) => (existsSync(nice) ? [process.execPath, [nice, cmd, ...args]] : [cmd, args]);
    const exts = [...new Set(changed.map((p) => /^pi-config\/extensions\/([^/]+)\//.exec(p)?.[1]).filter(Boolean))].sort();
    let readme = "";
    if (exts.length) try { readme = readFileSync(join(tree, "pi-config", "README.md"), "utf8"); } catch {}
    const replay = changed.some(touchesSpecReplay) && existsSync(join(tree, "pi-config", "extensions", "spec", "tests", "replay", "replay.test.mjs"));
    // The expected time, first (§chat.merge-round/check-time): the only check duration the captain quotes.
    const eta = expectedTime([
      { label: "typecheck", key: "typecheck", floorMs: this.floor("typecheck") },
      { label: "pnpm test", key: "test", floorMs: this.floor("test") },
      ...(intPlan ? [{ label: `pnpm test:int (${intPlan.full ? "full run" : ["everyday set", ...intPlan.titles].join(" + ")})`, key: intPlan.key, floorMs: this.floor("test"), fallbackMs: intPlan.estimateMs }] : []),
      ...exts.map((ext) => ({ label: `pi-config ${ext}`, key: `ext:${ext}`, floorMs: this.floor("ext"), times: suiteOf(readme, ext)?.commands.length ?? 0 })).filter((s) => s.times),
      ...(replay ? [{ label: "spec replay", key: "spec-replay", floorMs: this.floor("replay") }] : []),
      { label: "build", key: "build", floorMs: this.floor("build") },
    ], st.timings);
    this.say(`Expected: about ${durationShown(eta.expectedMs)} (${eta.parts.join(", ") || "no step timed yet"}${eta.unknown.length ? `; unknown: ${eta.unknown.join(", ")}, never timed` : ""}). Time limit: ${durationShown(eta.limitMs)} (${Math.ceil(eta.limitMs / 1000)} s, the steps' timeouts): in the foreground, give the call a timeout above it. A rerun of a failing file adds its own time, printed before it runs.`);
    this.backgroundNote({ expectedMs: eta.expectedMs, limitMs: eta.limitMs, startedAt: this.now });
    if (intPlan?.note) lines.push(intPlan.note);
    const tc = await step("typecheck", "typecheck", "typecheck", this.pnpm, ["run", "typecheck"], tree);
    if (tc.code !== 0) needs.push(tc.timedOut ? "typecheck timed out" : "typecheck fails");
    // The unit tier, then the integration tier (each its own timings, the same floor and rules).
    const suite = async (key, label, args) => {
      const t = await step(key, "test", label, this.pnpm, args, tree);
      if (t.timedOut) needs.push(`${label} timed out`);
      else if (t.code !== 0) {
        const files = failingTestFiles(`${t.stdout}\n${t.stderr}`, tree);
        if (!files.length) needs.push(`${label} fails (no failing file named; see the log)`);
        else {
          // Each failing file again on its own: one that passes alone is flaky and holds nothing.
          const alone = await this.alone(files, tree, env, st);
          const held = files.filter((x) => alone[x] !== "passes");
          const verdicts = held.length ? await this.onMaster(held, master, env, st) : {};
          const said = {};
          for (const file of files) {
            if (alone[file] === "passes") {
              flaky.push(file);
              said[file] = "flaky: passes alone";
              continue;
            }
            const v = verdicts[file];
            const onMaster = v === "pre-existing" ? "also fails on master" : v === "new" ? "passes on master" : v;
            if (alone[file] === "fails" && v === "pre-existing") {
              // Fails alone on the branch and on master too: master's, not the branch's.
              preexisting.push(file);
              said[file] = "fails alone; pre-existing: also fails on master";
            } else if (alone[file] === "fails") {
              needs.push(v === "new" ? `new test failure: ${file}` : `test failure in ${file} (${onMaster})`);
              said[file] = `fails alone; ${onMaster}`;
            } else {
              needs.push(`test failure in ${file} (${alone[file]})`);
              said[file] = `${alone[file]}; ${onMaster}`;
            }
          }
          lines.push(`  failing files: ${files.map((x) => `${x} (${said[x]})`).join(", ")}.`);
        }
      }
    };
    await suite("test", "pnpm test", ["test"]);
    if (intPlan) {
      await suite(intPlan.key, "pnpm test:int", intPlan.args);
      lines.push(...(intPlan.full ? ["Integration tests: full run (every group)."] : skippedShown(intPlan.skipped).map((l) => `${l}.`)));
    } else lines.push("pnpm test:int: skipped (this tree's package.json has no test:int script).");
    // Extension suites at the branch's own lowered priority (scripts/nice.mjs, as pnpm test runs);
    // a tree without it runs them unchanged.
    if (exts.length) {
      for (const ext of exts) {
        const suite = suiteOf(readme, ext);
        if (!suite) { lines.push(`pi-config ${ext}: no line in pi-config/README.md's Tests block.`); continue; }
        const cwd = join(tree, "pi-config", suite.dir);
        let failed = null;
        for (const argv of suite.commands) {
          const [cmd, ...rest] = expandArgs(argv, cwd);
          const r = await step(`ext:${ext}`, "ext", `pi-config ${ext}: ${argv.join(" ")}`, ...niced(cmd === "node" ? process.execPath : cmd, rest), cwd);
          if (r.code !== 0) { failed = r.timedOut ? "timed out" : "fails"; break; }
        }
        if (failed) needs.push(`pi-config ${ext} suite ${failed}`);
      }
    }
    // The spec replay suite: a landing gate, run only here, one at a time on this machine.
    if (changed.some(touchesSpecReplay)) {
      const specDir = join(tree, "pi-config", "extensions", "spec");
      if (!existsSync(join(specDir, "tests", "replay", "replay.test.mjs"))) lines.push("spec replay: skipped (no tests/replay/replay.test.mjs in this tree).");
      else {
        const lock = await acquireLock(join(this.agent, "locks", "spec-replay.lock"), { pollMs: this.lockPollMs });
        const release = () => lock.release();
        process.once("exit", release);
        try {
          if (lock.waitedMs >= 1000) lines.push(`spec replay: waited ${Math.round(lock.waitedMs / 1000)}s for another landing's replay.`);
          const argv = ["--test", ...expandArgs(["tests/replay/*.test.mjs"], specDir)];
          const r = await step("spec-replay", "replay", "spec replay: node --test tests/replay/*.test.mjs", ...niced(process.execPath, argv), specDir, { SOVA_SPEC_REPLAY: "1" });
          if (r.code !== 0) needs.push(`spec replay ${r.timedOut ? "timed out" : "fails"}`);
        } finally {
          release();
          process.removeListener("exit", release);
        }
      }
    }
    if (tc.code === 0) {
      const b = await step("build", "build", "build", this.pnpm, ["run", "build"], tree);
      if (b.code !== 0) needs.push(b.timedOut ? "build timed out" : "build fails");
    } else lines.push("build: skipped (the typecheck failed).");
    const spec = await this.specChecks(tree);
    lines.push(...spec.lines);
    // Docs land with the code: a draft not confirmed promoted holds the branch, and goes back to its owner.
    let left = spec.statuses.filter((d) => d.pending === null || d.pending.length).map((d) => ({ name: d.name, ids: d.pending }));
    // The user's Merge Without Specs… at the head checked: the drafts stay behind, named, and hold nothing.
    if (left.length && (await this.answerAt(this.readLanding(), branch, before))?.withoutSpecs) {
      lines.push(`Specs left behind on the user's Merge Without Specs…: ${draftsShown(left)}. The landed notice names them for a fresh branch.`);
      left = [];
    }
    if (left.length) needs.push(`docs not promoted: ${left.map((d) => d.name).join(", ")}`);
    // The area guides' "also update" files: questions for the owner, never a need.
    const nudges = alsoUpdateNudges(changed, areaGuides(tree));
    for (const n of nudges) lines.push(`also update: touched ${n.area} (${n.touched.length} file${n.touched.length === 1 ? "" : "s"}, ${n.guide}), not ${n.missing.join(" or ")}: ask the owner ("updated" or "not needed because …").`);
    // New fixed waits in the changed tests: a note for the owner, never a need; a tree without the scanner prints nothing.
    const fixedWaits = await this.fixedWaits(tree, master, env);
    if (fixedWaits.line) lines.push(fixedWaits.line);
    // What landing would publish, scanned now: a scrubbed or leaky commit is caught before it lands.
    const scan = await this.leakScanTo(head);
    lines.push(...scan.lines);
    if (scan.code === 1) needs.push("leak-scan hits in commits origin/master doesn't have");
    else if (scan.code === 2) lines.push("The leak scan couldn't run here: landing doesn't wait on it, and push scans again.");

    const ok = needs.length === 0;
    const rec = (st.branches[branch] ??= {});
    const skipped = intPlan?.full ? [] : (intPlan?.skipped ?? []).map(({ name, title, why }) => ({ name, title, why }));
    const full = !!intPlan?.full;
    rec.check = { head, masterSha: master, ok, needs, flaky, preexisting, skipped, full, at: this.now, logs: logDir };
    if (left.length) {
      const who = rec.ask?.owner ?? ownerOf(rec)?.owner;
      lines.push(who ? `Hand-back, session_send to ${who}:` : "Hand-back, for its owner (none known: the user's call):", handBackText(branch, left));
    }
    this.event("check", { branch, head, ok, skipped, full });
    this.saveState();
    if (preexisting.length) lines.push(`Pre-existing on master (not blocking): ${preexisting.join(", ")}.`);
    if (flaky.length) lines.push(`Flaky (failed in the full run, passed alone; not blocking): ${flaky.join(", ")}.`);
    lines.push(`Logs: ${logDir}`);
    lines.push(ok ? `landable at ${head.slice(0, 7)}` : `needs: ${needs.join("; ")}`);
    return { exit: ok ? 0 : 1, lines, data: { head, master, ok, needs, flaky, preexisting, skipped, full, alsoUpdate: nudges, fixedWaits: fixedWaits.waits, expectedMs: eta.expectedMs, limitMs: eta.limitMs, progress: this.progress, logs: logDir }, next: ok ? `round.mjs land ${branch}` : "hand it back to the owner with what it needs (session_send, only when idle)" };
  }

  // --- a check in the background, and waiting for its end (§chat.merge-round/check-time) ---------------

  backgroundFile(branch) {
    return join(this.dir, "background", `${branch.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }
  readBackground(file) {
    try { const r = JSON.parse(readFileSync(file, "utf8")); return r?.v === 1 ? r : null; } catch { return null; }
  }
  writeBackground(file, rec) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  /** In a background check (SOVA_ROUND_BACKGROUND names its record, SOVA_ROUND_BACKGROUND_LOG its log), adds `fields`
   *  to that record while it is still this run's. */
  backgroundNote(fields) {
    const file = process.env.SOVA_ROUND_BACKGROUND;
    if (!file) return;
    const rec = this.readBackground(file);
    if (rec && rec.log === process.env.SOVA_ROUND_BACKGROUND_LOG) this.writeBackground(file, { ...rec, ...fields });
  }

  /** `check <branch> --background`: the same check, detached, its output in a log; prints the pid, the log and the
   *  expected time once the check has printed it. One per branch at a time. */
  async checkBackground(branch, full) {
    const file = this.backgroundFile(branch);
    const prev = this.readBackground(file);
    if (prev && prev.exit === undefined && alive(prev.pid)) stop(1, `A background check of ${branch} is already running (pid ${prev.pid}, started ${ago(this.now - prev.at)} ago; log ${prev.log}).`, `round.mjs wait ${branch}`);
    const log = join(this.dir, "background", `${new Date(this.now).toISOString().replace(/[:.]/g, "-")}-${branch.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    const fd = openSync(log, "w", 0o600);
    // The record first, so the check finds it (by its log) whenever it writes.
    this.writeBackground(file, { v: 1, branch, pid: null, log, at: this.now, ...(full ? { full: true } : {}) });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "check", branch, ...(full ? ["full"] : []), "--repo", this.repoArg], { cwd: process.cwd(), env: { ...process.env, SOVA_ROUND_BACKGROUND: file, SOVA_ROUND_BACKGROUND_LOG: log }, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    if (!child.pid) stop(2, `The background check couldn't start: see ${log}.`);
    this.writeBackground(file, { ...(this.readBackground(file) ?? {}), v: 1, branch, pid: child.pid, log, at: this.now });
    child.unref();
    // The check prints its expected time once master is merged in and its plan read: echoed here when it does.
    const until = Date.now() + (Number(process.env.SOVA_ROUND_ETA_WAIT_MS) || 120_000);
    let eta = null;
    while (Date.now() < until) {
      try { eta = readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("Expected: ")) ?? null; } catch {}
      if (eta || this.readBackground(file)?.exit !== undefined || !alive(child.pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      exit: 0,
      lines: [`Background check of ${branch} started: pid ${child.pid}, log ${log}.`, eta ?? "It hasn't printed its expected time yet: the log will have it (`Expected: …`)."],
      data: { pid: child.pid, log },
      next: `wake at the expected time, then round.mjs wait ${branch} (it blocks until the check ends, then prints its digest); quote no other duration`,
    };
  }

  /** `wait <branch> [--timeout <s>]`: blocks until the branch's background check ends, then prints its output and exits
   *  with its exit; at the timeout, exit 1 saying it still runs. No background check: exit 2. */
  async wait() {
    const branch = this.args[1];
    const at = this.args.indexOf("--timeout");
    const secs = at >= 0 ? Number(this.args[at + 1]) : 20 * 60;
    if (!branch || branch.startsWith("-") || !(secs > 0) || this.args.length !== (at >= 0 ? 4 : 2)) stop(2, "usage: round.mjs wait <branch> [--timeout <seconds>]");
    const file = this.backgroundFile(branch);
    let rec = this.readBackground(file);
    if (!rec) stop(2, `No background check of ${branch} on record: start one with round.mjs check ${branch} --background.`);
    const poll = Number(process.env.SOVA_ROUND_WAIT_POLL_MS) || 5000;
    const until = Date.now() + secs * 1000;
    while (rec.exit === undefined && alive(rec.pid) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(50, until - Date.now()))));
      rec = this.readBackground(file) ?? rec;
    }
    if (rec.exit === undefined && alive(rec.pid)) {
      const end = rec.expectedMs ? rec.at + rec.expectedMs : null;
      return { exit: 1, lines: [`The background check of ${branch} still runs (pid ${rec.pid}, started ${ago(Date.now() - rec.at)} ago${end ? `; expected ${end > Date.now() ? `in about ${durationShown(end - Date.now())}` : `${durationShown(Date.now() - end)} ago`}` : ""}).`], next: `round.mjs wait ${branch} again` };
    }
    let text = "";
    try { text = readFileSync(rec.log, "utf8"); } catch {}
    const lines = text.split("\n").filter(Boolean);
    if (rec.exit === undefined) return { exit: 2, lines: [`The background check of ${branch} ended without recording its exit (killed?). Its log, ${rec.log}:`, ...lines], next: `round.mjs check ${branch} again` };
    return { exit: rec.exit, lines: [`The background check of ${branch} ended ${ago(Date.now() - (rec.endedAt ?? Date.now()))} ago (exit ${rec.exit}):`, ...lines] };
  }

  /** `full on|off`: every check a full run until told otherwise (§chat.merge-round/driver). */
  async full() {
    const v = this.args[1];
    if (this.args.length !== 2 || !["on", "off"].includes(v)) stop(2, "usage: round.mjs full on|off");
    const st = this.loadState();
    st.full = { on: v === "on", at: this.now };
    this.event("full", { on: v === "on" });
    this.saveState();
    return { exit: 0, lines: [v === "on" ? "Full runs on: every check runs every integration test, every group included, until `round.mjs full off`." : "Full runs off: checks run the everyday integration set plus the groups each branch triggers."], next: "round.mjs status" };
  }

  /** The integration step's plan: `{full, key, args, ran, titles, skipped, estimateMs, note?}`. A full run is the whole
   *  tier; otherwise the tree's own runner says what `--landing` picks (`--plan`), and a tree with no test groups, or a
   *  plan that can't be read, runs the whole tier and says why. */
  async integrationPlan(tree, master, env, full) {
    const whole = (note) => ({ full: true, key: "test-int", args: ["test:int"], ran: [], titles: [], skipped: [], estimateMs: 0, ...(note ? { note } : {}) });
    if (full) return whole();
    if (!existsSync(join(tree, "scripts", "test-groups.mjs"))) return whole("Integration tests: the whole tier (this tree has no scripts/test-groups.mjs).");
    const p = await run(this.pnpm, ["exec", "node", "scripts/run-tests.mjs", "--integration", "--landing", "--base", master, "--plan"], { cwd: tree, env, timeoutMs: 120_000 });
    let plan = null;
    try { plan = JSON.parse(p.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? ""); } catch {}
    if (p.code !== 0 || plan?.v !== 1 || !Array.isArray(plan.ran) || !Array.isArray(plan.skipped)) return whole(`Integration tests: the whole tier (the runner's --plan couldn't be read: ${p.timedOut ? "timed out" : `exit ${p.code}`}).`);
    const ran = plan.ran.filter((n) => typeof n === "string");
    const titleOf = (n) => [...(Array.isArray(plan.groups) ? plan.groups : []), ...plan.skipped].find((g) => g?.name === n && typeof g.title === "string")?.title ?? n;
    return {
      full: false, key: intKey({ ran }), args: ["test:int", "--", "--landing", "--base", master], ran,
      titles: ran.map(titleOf), estimateMs: Number.isFinite(plan.estimateMs) ? plan.estimateMs : 0,
      skipped: plan.skipped.filter((s) => typeof s?.name === "string" && !ran.includes(s.name)).map((s) => ({ name: s.name, title: typeof s.title === "string" ? s.title : s.name, why: s.why === "never" ? "never" : "untriggered" })),
    };
  }

  /** New fixed waits over 2 s in the changed tests, from the branch tree's `scripts/fixed-wait-scan.mjs` when it has one
   *  (feature-detected; never a need). → {waits: [...] | null, line?} */
  async fixedWaits(tree, master, env) {
    const scanner = join(tree, "scripts", "fixed-wait-scan.mjs");
    if (!existsSync(scanner)) return { waits: null };
    const r = await run(process.execPath, [scanner, "--base", master, "--json"], { cwd: tree, env, timeoutMs: 60_000 });
    let waits = null;
    try { waits = JSON.parse(r.stdout).waits; } catch {}
    if (!Array.isArray(waits)) return { waits: null, line: "fixed waits: the scan couldn't run (not blocking)." };
    const big = waits.filter((w) => typeof w?.file === "string" && Number(w.ms) > 2000);
    if (!big.length) return { waits: big };
    const shown = big.slice(0, 5).map((w) => `${w.file}:${w.line} (${Math.round(Number(w.ms) / 100) / 10} s)`).join(", ");
    return { waits: big, line: `fixed waits: ${big.length} new fixed wait${big.length === 1 ? "" : "s"} over 2 s in changed tests: ${shown}${big.length > 5 ? `, +${big.length - 5} more` : ""}. Ask the owner to wait on a condition instead (not blocking).` };
  }

  /** Each file that failed in the branch's full run, run again on its own in the branch's worktree, through the
   *  same runner on the same runtime as its `pnpm test`: "passes" (flaky), "fails", or why it couldn't tell. */
  async alone(files, tree, env, st) {
    const out = {};
    const runtime = env.SOVA_RUNTIME?.trim() === "node" ? "node" : "bun";
    for (const file of files) {
      const timeoutMs = timeoutFor(this.floor("master"), st.timings.master);
      this.say(`Rerunning ${file} on its own: ${this.addsShown(tree, file, timeoutMs)}; if it fails again it runs on master too, adding as much again.`);
      const r = await run(this.pnpm, ["exec", "node", "scripts/run-tests.mjs", "--runtime", runtime, file], { cwd: tree, env, timeoutMs });
      // 2 is the runner's own refusal (no bun, bad usage): nothing ran.
      out[file] = r.timedOut ? "timed out alone" : r.code === 2 ? `the test runner couldn't run it alone (${runtime})` : r.code === 0 ? "passes" : "fails";
    }
    return out;
  }

  /** What one run of a test file adds to the check (§chat.merge-round/check-time): its recorded time in `tree`'s
   *  durations file for its tier, else unknown; with the run's limit. */
  addsShown(tree, file, timeoutMs) {
    let ms = null;
    try {
      const d = JSON.parse(readFileSync(join(tree, ".cache", file.endsWith(".integration.test.ts") ? "test-durations-integration.json" : "test-durations.json"), "utf8"));
      const v = d?.v === 1 ? d.files?.[file]?.ms : null;
      if (Number.isFinite(v)) ms = v;
    } catch {}
    return `${ms === null ? "adds an unknown time (none recorded)" : `adds about ${durationShown(ms)}`}, at most ${durationShown(timeoutMs)}`;
  }

  /** Each file that also fails alone run again on master, in the main checkout at master's sha, through the same
   *  runner on the same runtime as the branch's `pnpm test`; cached per (master, file). */
  async onMaster(files, master, env, st) {
    const { main } = await this.repo();
    const out = {};
    const runs = (st.masterRuns[master] ??= {});
    for (const k of Object.keys(st.masterRuns)) if (k !== master) delete st.masterRuns[k];
    const mainHead = (await git(main, ["rev-parse", "HEAD"])).stdout.trim();
    for (const file of files) {
      if (runs[file]) { out[file] = runs[file].fails ? "pre-existing" : "new"; continue; }
      if ((await git(main, ["cat-file", "-e", `${master}:${file}`])).code !== 0) { out[file] = "new"; continue; }
      if (mainHead !== master) { out[file] = "can't tell: the main checkout isn't at master"; continue; }
      if ((await gitOut(main, ["status", "--porcelain", "--", file], "status")) !== "") { out[file] = "can't tell: it's dirty in the main checkout"; continue; }
      const runtime = env.SOVA_RUNTIME?.trim() === "node" ? "node" : "bun";
      const timeoutMs = timeoutFor(this.floor("master"), st.timings.master);
      this.say(`Running ${file} on master: ${this.addsShown(main, file, timeoutMs)}.`);
      const r = await run(this.pnpm, ["exec", "node", "scripts/run-tests.mjs", "--runtime", runtime, file], { cwd: main, env, timeoutMs });
      if (r.timedOut) { out[file] = "can't tell: it timed out on master"; continue; }
      // 2 is the runner's own refusal (no bun, bad usage): nothing ran.
      if (r.code === 2) { out[file] = `can't tell: the test runner couldn't run it on master (${runtime})`; continue; }
      runs[file] = { fails: r.code !== 0, at: this.now };
      out[file] = r.code !== 0 ? "pre-existing" : "new";
    }
    return out;
  }

  /** The spec check, census and each draft's status, printed for the captain, with the drafts' statuses
   *  (`check` holds a branch on a draft not confirmed promoted; nothing else here holds one). */
  async specChecks(tree) {
    const statuses = await this.draftStatuses(tree);
    const drafted = statuses.map(({ name, pending }) => (pending === null ? `draft ${name}: status unreadable.` : pending.length ? `draft ${name}: not promoted: ${pending.slice(0, 4).join(", ")}.` : `draft ${name}: promoted.`));
    if (!existsSync(join(tree, MANIFEST))) return { lines: ["spec: none in this project.", ...drafted], statuses };
    const tool = (file, args) => run(process.execPath, [join(this.specCore, file), ...args, "--root", tree, "--json"], { cwd: tree, timeoutMs: 120_000 });
    if (!existsSync(join(this.specCore, "sova-spec.mjs"))) return { lines: ["spec: the spec tools aren't installed, so the spec can't be checked.", ...drafted], statuses };
    const lines = [];
    const c = await tool("sova-spec.mjs", ["check"]);
    lines.push(`spec check: ${c.code === 0 ? "ok" : c.code === 1 ? "warnings" : "ERRORS"}.`);
    const census = await tool("sova-spec.mjs", ["census", "--changed", "--base", "master"]);
    let unclaimed = null;
    try { unclaimed = JSON.parse(census.stdout).census?.unclaimed ?? null; } catch {}
    if (census.code === 2 || !Array.isArray(unclaimed)) lines.push("spec census: couldn't run.");
    else if (unclaimed.length) lines.push(`spec census: ${unclaimed.length} unclaimed (${unclaimed.slice(0, 3).join(", ")}).`);
    else lines.push("spec census: clean.");
    lines.push(...drafted);
    return { lines, statuses };
  }

  /** Each draft in `tree`, by name, with what isn't official by the draft tool's one verdict (`official`, from
   *  core/official.mjs, the one Sova's readiness calls): [] when official, its ids otherwise (null: unreadable). */
  async draftStatuses(tree) {
    if (!tree) return [];
    let drafts = [];
    try { drafts = readdirSync(join(tree, DRAFTS), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort(); } catch {}
    if (!drafts.length) return [];
    // Without a spec or the draft tool no status can be read: each draft is unreadable, never "none".
    if (!existsSync(join(tree, MANIFEST)) || !existsSync(join(this.specCore, "sova-spec-draft.mjs"))) return drafts.map((name) => ({ name, pending: null }));
    const s = await run(process.execPath, [join(this.specCore, "sova-spec-draft.mjs"), "drafts", "--root", tree, "--json"], { cwd: tree, timeoutMs: 300_000 });
    let rows = null;
    try {
      const j = JSON.parse(s.stdout);
      if (Array.isArray(j.drafts)) rows = j.drafts;
    } catch {}
    return drafts.map((name) => {
      const row = rows?.find((d) => d?.name === name);
      if (!row || row.state === "unreadable" || typeof row.official !== "boolean") return { name, pending: null };
      if (row.official) return { name, pending: [] };
      const ids = [row.pending, row.conflict, row.promotedConflict].flatMap((l) => (Array.isArray(l) ? l : [])).map((id) => (typeof id === "string" ? id : "?"));
      return { name, pending: ids.length ? ids : ["(outside any §)"] };
    });
  }

  /** The drafts in `tree` with records not yet promoted, as [{ name, ids }]; with `unreadable`, also
   *  those whose status can't be read (ids null): every draft not confirmed promoted. */
  async unofficialDrafts(tree, { unreadable = false } = {}) {
    return (await this.draftStatuses(tree)).filter((d) => d.pending?.length || (unreadable && d.pending === null)).map((d) => ({ name: d.name, ids: d.pending }));
  }

  async land() {
    const { branch, head, tree } = await this.branchArg();
    const st = this.loadState();
    const rec = st.branches[branch];
    const master = await this.masterSha();
    const c = rec?.check;
    if (!c) stop(1, `${branch} has no check: run it first.`, `round.mjs check ${branch}`);
    if (!c.ok) stop(1, `${branch}'s last check needs: ${c.needs.join("; ")}.`, "hand it back to the owner");
    if (c.head !== head) stop(1, `${branch} moved since its check (${c.head.slice(0, 7)} → ${head.slice(0, 7)}): check again.`, `round.mjs check ${branch}`);
    if (c.masterSha !== master) stop(1, `master moved since ${branch}'s check (${c.masterSha.slice(0, 7)} → ${master.slice(0, 7)}): check again.`, `round.mjs check ${branch}`);
    if (!tree) stop(1, `${branch} has no worktree.`);
    const dirty = await this.dirtyIn(tree);
    if (dirty.length) stop(1, `${branch}'s worktree has ${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"} since its check.`);
    if (this.privateIn(tree)) stop(2, "The worktree's path holds a private name: ask the user how to land it.");
    const scan = await this.leakScanTo(head);
    if (scan.code === 1) return { exit: 1, lines: [...scan.lines, `Land nothing: ${branch} carries a leak-scan hit in commits origin/master doesn't have.`], next: "report the commit, file and line to the owner and the user; scrubbing unpushed commits is the user's call, case by case" };
    const path = homeShown(tree);
    const call = `worktree ${JSON.stringify({ action: "merge", path })}`;
    const go = await this.answerAt(this.readLanding(), branch, head);
    const owner = go?.kind === "go-ahead" ? `The user's ${goAheadWord(go.by)} at ${(go.at ?? head).slice(0, 7)}.` : "No go-ahead recorded at this head: land it only on the user's word (Land It, \"land it\" typed in its own chat, or round.mjs go).";
    if (go?.kind === "not-yet") stop(1, `The user said Not Yet to ${branch} at ${(go.at ?? head).slice(0, 7)}: it waits for a new commit.`, "round.mjs status");
    const scanned = scan.code === 0 ? [] : [...scan.lines, "The leak scan couldn't run here: push scans again."];
    return { exit: 0, lines: [`landable at ${head.slice(0, 7)} on master ${master.slice(0, 7)} (checked ${ago(this.now - c.at)} ago).`, ...scanned, owner, `call: ${call}`], data: { call: { action: "merge", path } }, next: `after the merge card, round.mjs landed ${branch}` };
  }

  /** The clean up's two commands for a landed branch's worktree, or why it can't run from here. */
  async cleanUp(main, branch, tree) {
    if (!tree) return { why: `${branch} has no worktree to remove.` };
    if (this.privateIn(tree) || this.privateIn(main)) return { why: "The worktree's path holds a private name: leave it, and ask the user to remove it." };
    // A sandboxed captain sees git's worktree records read-only: git would delete the folder's
    // files and then fail to unregister it, so it isn't started at all.
    const admin = await git(tree, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    try {
      if (admin.code !== 0) throw new Error(firstLine(admin));
      accessSync(dirname(admin.stdout.trim()), constants.W_OK);
      accessSync(admin.stdout.trim(), constants.W_OK);
    } catch {
      return { why: "Git's record of this worktree is read-only here (a sandboxed session), so it can't be removed from this session: leave it, and say so in the report." };
    }
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    return { commands: [`git -C ${shellPath(main)} worktree remove -- ${shellPath(tree)}`, `git -C ${shellPath(main)} branch -d -- ${q(branch)}`] };
  }

  async landed() {
    const { branch, head, tree } = await this.branchArg();
    const st = this.loadState();
    // Its head in master is all it takes: a branch its owner merged has no check on record.
    const rec = (st.branches[branch] ??= {});
    const { main } = await this.repo();
    const master = await this.masterSha();
    const anc = await git(main, ["merge-base", "--is-ancestor", head, master]);
    if (anc.code === 1) stop(1, `${branch} at ${head.slice(0, 7)} isn't in master yet: land it with the worktree tool first.`, `round.mjs land ${branch}`);
    if (anc.code !== 0) stop(2, `git merge-base failed: ${firstLine(anc)}`);
    const m = await this.mainFacts();
    const mainHead = (await git(main, ["rev-parse", "HEAD"])).stdout.trim();
    if (!m.onMaster || mainHead !== master) stop(2, "The main checkout isn't on master at its tip, so it can't be built.");
    const restartLine = this.applyNeed(st, await this.restartNeed(), { merge: { branch, sha: master }, failClosed: true });
    const restart = !!st.restart?.pending;
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    mkdirSync(join(this.dir, "logs"), { recursive: true, mode: 0o700 });
    const logFile = join(this.dir, "logs", `${new Date(this.now).toISOString().replace(/[:.]/g, "-")}-main-build.log`);
    const b = await run(this.pnpm, ["run", "build"], { cwd: main, env, timeoutMs: timeoutFor(this.floor("build"), st.timings.build), logFile });
    rec.landed = { sha: master, at: this.now };
    this.event("landed", { branch, sha: master, restart, built: b.code === 0 });
    this.saveState();
    const lines = [
      `${branch} is in master at ${master.slice(0, 7)}.`,
      `Main checkout build: ${b.code === 0 ? "ok" : b.timedOut ? "TIMED OUT" : `FAILED (exit ${b.code})`} (log ${logFile}).`,
      restartLine,
      restart ? "A restart is needed: round.mjs restart-check." : "No restart needed: only the build.",
    ];
    // Earlier landings' copies first, so this one's stays until a later landing finds it official in master.
    lines.push(...(await this.pruneKept(main)));
    // Removing the worktree deletes its drafts (local files): the whole drafts folder is copied once first.
    const drafts = await this.unofficialDrafts(tree, { unreadable: true });
    let kept = null;
    let keptWhy = null;
    if (tree && existsSync(join(tree, DRAFTS))) {
      try {
        cpSync(join(tree, DRAFTS), join(this.dir, "drafts", head), { recursive: true, force: true });
        kept = join(this.dir, "drafts", head);
      } catch (e) {
        keptWhy = e.code ?? "copy failed";
      }
    }
    const clean = keptWhy
      ? { why: `its drafts couldn't be kept (${keptWhy}), and removing it would delete them: leave it, and say so in the report.` }
      : await this.cleanUp(main, branch, tree);
    if (clean.why) lines.push(`Clean up: ${clean.why}`);
    if (kept && drafts.length) lines.push(`Unpromoted drafts kept at ${kept}/: ${drafts.map((d) => d.name).join(", ")}.`);
    // At landing, after its check passed: the drafts already official leave the worktree (the copy above kept).
    if (kept && rec.check?.ok && rec.check.head === head) lines.push(...(await this.tidyOfficial(tree, kept)));
    const who = rec.ask?.owner ?? ownerOf(rec)?.owner;
    if (who) {
      lines.push(`session_send to ${who}, after the clean up:`, landedText(branch, master, drafts, kept ?? join(tree, DRAFTS)));
      if (clean.commands) lines.push(`Only when the remove succeeded, add: Its worktree folder was removed.`);
    }
    const next = clean.commands
      ? `clean up from the main checkout, exactly: ${clean.commands[0]} (never --force), then ${clean.commands[1]}; report git's refusal as printed, never retry or force it; then round.mjs push`
      : "round.mjs push";
    return { exit: b.code === 0 ? 0 : 1, lines, data: { sha: master, restart, ...(clean.commands ? { cleanUp: clean.commands } : {}) }, next };
  }

  /** The drafts the draft tool confirms official deleted from the worktree (`prune --official --write`); `kept` holds their copy. */
  async tidyOfficial(tree, kept) {
    if (!existsSync(join(this.specCore, "sova-spec-draft.mjs"))) return [];
    const r = await run(process.execPath, [join(this.specCore, "sova-spec-draft.mjs"), "prune", "--official", "--write", "--root", tree, "--json"], { cwd: tree, timeoutMs: 300_000 });
    let gone = null;
    try { gone = JSON.parse(r.stdout).deleted.map((d) => d.name); } catch {}
    return [gone ? `Official drafts tidied out of the worktree (a copy at ${kept}/): ${gone.join(", ") || "none"}.` : `Official drafts: the prune failed, so none was deleted (a copy at ${kept}/).`];
  }

  /** Copies kept by earlier landings that the draft tool confirms are already official in master's spec are
   *  deleted (`prune --official --from`); every other copy stays. A prune that fails deletes nothing. */
  async pruneKept(main) {
    const base = join(this.dir, "drafts");
    let folders = [];
    try { folders = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[0-9a-f]{7,64}$/.test(d.name)).map((d) => d.name).sort(); } catch {}
    if (!folders.length) return [];
    if (!existsSync(join(main, MANIFEST)) || !existsSync(join(this.specCore, "sova-spec-draft.mjs"))) return ["Kept draft copies: not pruned (no spec or spec tools in the main checkout), all kept."];
    const pruned = [];
    let keptCount = 0;
    const failed = [];
    for (const f of folders) {
      const dir = join(base, f);
      const r = await run(process.execPath, [join(this.specCore, "sova-spec-draft.mjs"), "prune", "--official", "--from", dir, "--write", "--root", main, "--json"], { cwd: main, timeoutMs: 300_000 });
      let j = null;
      try { j = JSON.parse(r.stdout); } catch {}
      if (r.code !== 0 || !Array.isArray(j?.deleted)) { failed.push(f.slice(0, 7)); continue; }
      for (const d of j.deleted) pruned.push(`${f.slice(0, 7)}/${d.name}`);
      keptCount += Array.isArray(j.kept) ? j.kept.length : 0;
      try { if (!readdirSync(dir).length) rmSync(dir, { recursive: true }); } catch {}
    }
    const out = [];
    if (pruned.length) out.push(`Kept draft copies already official in master, deleted: ${pruned.join(", ")}.`);
    if (keptCount) out.push(`Kept draft copies not confirmed official: ${keptCount}, kept.`);
    if (failed.length) out.push(`Kept draft copies: the prune failed for ${failed.join(", ")}; nothing there was deleted.`);
    return out;
  }

  async push() {
    const sid = this.sessionId();
    const st = this.loadState();
    const sess = st.sessions[sid];
    if (!sess) stop(2, "This session has no round yet: run `round.mjs start` first.");
    if (sess.hold) stop(1, "Push hold: the settings were missing at this session's first round, and the user hasn't answered yet. Merge locally; push nothing.", "wait for the answers, add them, then round.mjs names-answered");
    const { main } = await this.repo();
    const m = await this.mainFacts();
    if (!m.onMaster) stop(1, "The main checkout isn't on master: push nothing, and ask the user.");
    const fetch = await git(main, ["fetch", "--no-tags", "origin", "master"], { timeoutMs: 60_000 });
    if (fetch.code !== 0) stop(2, `git fetch origin master failed: ${firstLine(fetch)}`);
    const master = await this.masterSha();
    const origin = await gitOut(main, ["rev-parse", "--verify", "refs/remotes/origin/master^{commit}"], "rev-parse origin/master");
    if (origin === master) return { exit: 0, lines: ["Nothing to push: origin/master is at master."], next: "round.mjs restart-check, if a restart is pending; else the report" };
    const ff = await git(main, ["merge-base", "--is-ancestor", origin, master]);
    if (ff.code === 1) stop(1, `master isn't a fast-forward of origin/master (${origin.slice(0, 7)}): someone pushed, or master was rewritten. Push nothing; ask the user.`);
    if (ff.code !== 0) stop(2, `git merge-base failed: ${firstLine(ff)}`);
    const scan = await run(process.execPath, [join(HERE, "leak-scan.mjs"), "--repo", main, "--range", `${origin}..${master}`], { cwd: main, timeoutMs: 120_000 });
    const scanned = `${scan.stdout}${scan.stderr}`.split("\n").filter(Boolean);
    if (scan.code !== 0) {
      this.event("push-refused", { why: scan.code === 1 ? "leak-scan hits" : "leak-scan couldn't check" });
      this.saveState();
      return { exit: scan.code === 1 ? 1 : 2, lines: [...scanned, "Push nothing."], next: scan.code === 1 ? "report the commit, file and line; rewriting unpushed commits is the user's call" : "ask the user" };
    }
    const p = await git(main, ["push", "origin", "master"], { timeoutMs: 120_000 });
    if (p.code !== 0) stop(2, `git push origin master failed: ${firstLine(p)}`);
    this.event("pushed", { from: origin, to: master });
    this.saveState();
    return { exit: 0, lines: [...scanned, `Pushed ${origin.slice(0, 7)}..${master.slice(0, 7)} to origin/master.`], next: st.restart?.pending ? "round.mjs restart-check" : "round.mjs report" };
  }

  /** Is a restart needed? It reads no live records: a restart cuts no chat, worker or reply off (§app/chat-processes), so busy sessions never hold it. */
  async restartCheck() {
    const st = this.loadState();
    const unit = this.settings.restartUnit ?? DEFAULT_UNIT;
    if (!/^[A-Za-z0-9@._-]+\.service$/.test(unit) || this.mask(unit) !== unit) stop(2, "The settings' restartUnit isn't a plain unit name: ask the user to restart.");
    const needLine = this.applyNeed(st, await this.restartNeed());
    const pending = !!st.restart?.pending;
    this.event("restart-check", { pending });
    this.saveState();
    if (!pending) return { exit: 0, lines: [needLine, "No restart pending."], next: "round.mjs report" };
    // macOS: the unit is a launchd agent whose label is the unit's name without .service (as self-host's launchdTargetOf).
    const restart = this.platform === "darwin" ? `launchctl kickstart -k gui/${process.getuid()}/${unit.replace(/\.service$/, "")}` : `systemctl --user restart ${unit}`;
    const lines = [needLine, "Restart the live server (chats, workers and replies run on through it):", restart, "If it fails, ask the user to restart; never another way."];
    return { exit: 0, lines, next: "that call, then the report; the next start confirms the head it came back on" };
  }

  async report() {
    const sid = this.sessionId();
    const st = this.loadState();
    const sess = st.sessions[sid];
    if (!sess) stop(2, "This session has no round yet: run `round.mjs start` first.");
    const since = sess.roundStartedAt ?? 0;
    const ev = st.events.filter((e) => e.at >= since);
    const of = (k) => ev.filter((e) => e.kind === k);
    const lines = ["Round report"];
    lines.push(`- Merged: ${of("landed").map((e) => `${e.branch} at ${e.sha.slice(0, 7)}${e.built ? "" : " (main build FAILED)"}`).join(", ") || "none"}`);
    const pushed = of("pushed").at(-1);
    const refused = of("push-refused").at(-1);
    lines.push(`- Push: ${sess.hold ? "held (the user hasn't answered the start interview)" : pushed ? `pushed to ${pushed.to.slice(0, 7)}` : refused ? `refused: ${refused.why}` : "nothing pushed"}`);
    const checks = of("check");
    // What each check didn't run, or that it ran everything (§chat.merge-round/round).
    const ran = (e) => (e.full ? " (full run)" : e.skipped?.length ? ` (${skippedShown(e.skipped).join("; ")})` : "");
    lines.push(`- Checks: ${checks.map((e) => `${e.branch} ${e.ok ? "landable" : `needs: ${st.branches[e.branch]?.check?.needs?.join("; ") ?? "?"}`}${ran(e)}`).join(" · ") || "none run"}`);
    const rc = of("restart-check").at(-1);
    lines.push(`- Restart: ${st.restart?.pending ? `pending (${(st.restart.merges ?? []).map((m) => m.branch).join(", ") || `the server runs ${String(st.restart.serverHead ?? "?").slice(0, 7)}`})${rc ? ", checked" : ", not checked"}` : st.restart?.confirmedAt >= since ? "done and confirmed" : "none needed"}`);
    // Branches with no live owner reach the user once per branch and head (§chat.merge-round/round).
    st.toldUser ??= {};
    const forUser = (st.lastStatus?.forUser ?? []).filter((b) => st.toldUser[b.branch] !== `${b.head}:${b.group}`);
    for (const b of forUser) st.toldUser[b.branch] = `${b.head}:${b.group}`;
    lines.push(`- For you, once (no live owner, so no Landing card): ${forUser.map((b) => `${b.branch} (${b.group === "archived" ? "owner archived" : "no session tracks this worktree"}: say "land ${b.branch}" here to land it)`).join(", ") || "nothing new"}`);
    // A card Sova showed is named by its chat, with a link, never as "its card is shown" alone.
    const waiting = st.lastStatus?.waiting ?? [];
    if (waiting.length) lines.push(`- Waiting for your Land It (or "land it" typed there): ${waiting.map((b) => `${b.branch} at ${b.head.slice(0, 7)} in ${b.chat}`).join(", ")}`);
    lines.push(`- Queued for a Landing card: ${of("queued").map((e) => `${e.branch} (${e.owner})`).join(" · ") || "none"}`);
    lines.push("- Handed back: (fill in: branch, owner, why)");
    if (sess.firstRound) lines.push("- Settings: (fill in the kinds and counts discover-names.mjs printed, and any names it says origin already has, masked as printed)");
    this.saveState();
    const quiet = !sess.firstRound && !sess.hold && !st.restart?.pending && !forUser.length && st.lastStatus?.board && st.lastStatus.at >= since && !["landed", "pushed", "push-refused", "check", "queued"].some((k) => of(k).length);
    if (quiet) return { exit: 0, lines: ["Nothing new on the merge board."], next: "report exactly that one line, unless something was handed back; end the turn" };
    return { exit: 0, lines, next: "end the turn" };
  }
}

const COMMANDS = { start: "start", "names-answered": "namesAnswered", status: "status", note: "note", go: "go", ask: "ask", check: "check", wait: "wait", full: "full", land: "land", landed: "landed", push: "push", "restart-check": "restartCheck", report: "report" };

/** Whether a process lives (one we may not signal still does). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

export async function main(argv = process.argv.slice(2)) {
  let round;
  let result;
  try {
    round = new Round(argv);
    const method = COMMANDS[round.args[0]];
    if (!method) stop(2, `usage: round.mjs <${Object.keys(COMMANDS).join("|")}> [args] [--repo <dir>] [--json]`);
    result = await round[method]();
  } catch (err) {
    result = err instanceof Exit ? { exit: err.code, lines: err.lines, next: err.next } : { exit: 2, lines: [`round.mjs: ${err?.message ?? err}`] };
  }
  const mask = round?.mask ?? ((s) => s);
  const next = result.next ?? (result.exit === 2 ? "fail closed: say it couldn't be checked" : undefined);
  const text = round?.json
    ? JSON.stringify({ command: round.args[0] ?? null, exit: result.exit, lines: result.lines, ...(result.data ?? {}), next: next ?? null })
    : [...result.lines, ...(next ? [`next: ${next}`] : [])].join("\n");
  process.stdout.write(`${mask(homeShown(text))}\n`);
  // A background check records its exit once its whole digest is in the log (`wait` reads both).
  if (round?.args[0] === "check" && !round.background) round.backgroundNote({ exit: result.exit, endedAt: Date.now() });
  return result.exit;
}

const invoked = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main().then((code) => { process.exitCode = code; });
