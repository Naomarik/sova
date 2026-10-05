// The replay scenarios. Each takes one arm's context and returns rows: { scenario, metric, value, guards }.
// A guard is { name, ok, detail }; every guard is evaluated in every arm. Values are plain JSON and carry
// no temp paths (the runner normalizes the workspace path), so two runs of one tree compare equal.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Repo, seedSpec, editDraftRecord, replaceIn, outcome } from "./lib.mjs";
import { sliceQuality } from "./scenario-f.mjs";
import { fullness } from "./scenario-g.mjs";

const row = (scenario, metric, value, guards = []) => ({ scenario, metric, value, guards });
const guard = (name, ok, detail = "") => ({ name, ok: Boolean(ok), detail });

// ── The shared fixture ───────────────────────────────────────────────────────

const TOP = "# §a/top\n\nThe top surface.\n\n## §a.top/one\n\nOne does X.\n\n### Detail\n\nPlain H3 prose.\n\n## §a.top/two\n\nTwo does Y.\n";
const SEVEN = (tag) => ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].map((l) => `${tag} ${l}`).join("\n") + "\n";

/** master with §a/top (H2s one, two), §b/other, code under src/ (seven lines each, so edits far apart merge cleanly). */
function standard(ctx, name) {
  const repo = new Repo(ctx.ws.dir(name), ctx.ws.home).init();
  seedSpec(repo, {
    boundary: { include: ["src"], exclude: [] },
    claims: {
      "§a/top": { kind: "surface", authority: "accepted" },
      "§a.top/one": { kind: "behavior", authority: "accepted", requires: [], code: ["src/one.txt"] },
      "§a.top/two": { kind: "behavior", authority: "accepted", requires: [], code: ["src/two.txt"] },
      "§b/other": { kind: "behavior", authority: "accepted", requires: [], code: ["src/other.txt"] },
    },
    files: {
      ".sova/spec/claims/a/top.md": TOP,
      ".sova/spec/claims/b/other.md": "# §b/other\n\nOther does Z.\n",
      "src/one.txt": SEVEN("one"), "src/two.txt": SEVEN("two"), "src/other.txt": SEVEN("other"),
      "src/nested/keep.txt": "keep\n",
      "docs/notes.md": "notes\n",
    },
  });
  repo.commit("base");
  return repo;
}

const CLAIM_FILE = { "§a.top/one": "a/top.md", "§a.top/two": "a/top.md", "§b/other": "b/other.md" };
const draftClaim = (name, id) => `.sova/spec/drafts/${name}/spec/claims/${CLAIM_FILE[id]}`;
const currentClaim = (id) => `.sova/spec/claims/${CLAIM_FILE[id]}`;

/** The drafting half: a new draft whose prose of `id` says `to` instead of `from`. */
function drafted(ctx, repo, name, id, from, to) {
  const r = ctx.tools.draft(repo.root, ctx.ws.home, ["new", name, "--write"]);
  if (r.json?.exit !== 0) throw new Error(`draft new ${name}: ${r.stdout}`);
  replaceIn(repo, draftClaim(name, id), from, to);
  editDraftRecord(repo, name, id, (rec) => { rec.authority = "accepted"; });
}

/** Commit an implementation edit: line `line` of `file` gets `tag`. */
function implement(repo, file, line, tag) {
  const lines = repo.read(file).split("\n");
  lines[line - 1] += ` ${tag}`;
  repo.write(file, lines.join("\n"));
  return repo.commit(`impl ${tag}`, [file]);
}

const evidence = (ctx, repo, name, id) =>
  ctx.tools.draft(repo.root, ctx.ws.home, ["evidence", name, "--id", id, "--by", "replay", "--verification", "fixture: replay scenario", "--commit", "HEAD", "--write"]);

/** Promote `id` from `name`: preview, and when it plans cleanly, write it and commit the current spec. */
function promote(ctx, repo, name, id) {
  const preview = ctx.tools.draft(repo.root, ctx.ws.home, ["promote", name, "--id", id]);
  const refusals = (preview.json?.refusals ?? []).map((x) => x.code).sort();
  const plan = preview.json?.plan;
  if (refusals.length || !plan) return { refused: refusals.length ? refusals : [outcome(preview)], preview };
  const write = ctx.tools.draft(repo.root, ctx.ws.home, ["promote", name, "--id", id, "--plan", plan, "--write"]);
  const wrote = (write.json?.refusals ?? []).map((x) => x.code);
  if (write.json?.exit !== 0 || wrote.length) return { refused: wrote.length ? wrote.sort() : [outcome(write)], preview: write };
  repo.commit(`promote ${name}`, [".sova/spec"]);
  return { refused: [], preview: write };
}

/** Each refusal's reasons, reduced to kinds (the messages carry hashes and commit ids). */
function reasonKinds(preview) {
  const kinds = new Set();
  for (const r of preview.json?.refusals ?? []) {
    const m = r.message ?? "";
    if (/in the working tree differs/.test(m)) kinds.add("working-tree-differs");
    if (/is not an ancestor of HEAD|was rewritten/.test(m)) kinds.add("not-ancestor");
    if (/is not the recorded bytes/.test(m)) kinds.add("commit-bytes-differ");
    if (/no longer exists/.test(m)) kinds.add("commit-gone");
    if (/prose changed after evidence/.test(m)) kinds.add("prose-changed");
    if (/record changed after evidence/.test(m)) kinds.add("record-changed");
  }
  return [...kinds].sort();
}

// ── (a) Merging drafts ───────────────────────────────────────────────────────

/** Two drafts from one base on parallel branches; A lands on master, B merges master in and promotes. */
function parallelDrafts(ctx, label, editA, editB) {
  const repo = standard(ctx, label);
  const base = repo.head();
  drafted(ctx, repo, "da", ...editA.draft);
  drafted(ctx, repo, "db", ...editB.draft);
  repo.checkout("-b", "task-a", base);
  implement(repo, ...editA.code);
  const evA = evidence(ctx, repo, "da", editA.draft[0]);
  const a = promote(ctx, repo, "da", editA.draft[0]);
  repo.checkout("master");
  repo.merge("task-a");
  repo.checkout("-b", "task-b", base);
  implement(repo, ...editB.code);
  const m = repo.merge("master");
  if (m.status !== 0) throw new Error(`${label}: merging master into task-b conflicted in code: ${m.stderr}`);
  const evB = evidence(ctx, repo, "db", editB.draft[0]);
  const b = promote(ctx, repo, "db", editB.draft[0]);
  const current = repo.read(currentClaim(editA.draft[0]));
  const draftB = repo.read(draftClaim("db", editB.draft[0]));
  // No prose lost: A's sentence is current; B's is current or still in its draft (refused); nothing else went missing.
  const aText = editA.draft[2], bText = editB.draft[2];
  const kept = current.includes(aText) && (current.includes(bText) || (b.refused.length > 0 && draftB.includes(bText)))
    && current.includes("Plain H3 prose.") && !/^(<<<<<<<|>>>>>>>|=======)/m.test(current);
  return { repo, a, b, evA: outcome(evA), evB: outcome(evB), kept, current };
}

export async function merging(ctx) {
  const rows = [];
  const diff = parallelDrafts(ctx, "a-diff-h2",
    { draft: ["§a.top/one", "One does X.", "One does X, said by A."], code: ["src/one.txt", 1, "A"] },
    { draft: ["§a.top/two", "Two does Y.", "Two does Y, said by B."], code: ["src/two.txt", 7, "B"] });
  const handDiff = [diff.a, diff.b].filter((p) => p.refused.includes("conflict")).length;
  rows.push(row("a", "a.diff-h2.hand-reapply", handDiff, [
    guard("a.diff-h2.first-lands", diff.a.refused.length === 0, `draft A: ${diff.a.refused.join("+") || "promoted"}`),
    guard("a.diff-h2.no-prose-lost", diff.kept, "A's sentence current; B's current or still in its refused draft; H3 prose kept; no conflict markers"),
  ]));
  rows.push(row("a", "a.diff-h2.second-outcome", diff.b.refused.join("+") || "promoted", [guard("a.diff-h2.evidence-recorded", diff.evB === "exit0", `evidence: ${diff.evB}`)]));

  const same = parallelDrafts(ctx, "a-same-h2",
    { draft: ["§a.top/one", "One does X.", "One does X, said by A."], code: ["src/one.txt", 1, "A"] },
    { draft: ["§a.top/one", "One does X.", "One does X, said by B."], code: ["src/one.txt", 7, "B"] });
  rows.push(row("a", "a.same-h2.second-outcome", same.b.refused.join("+") || "promoted", [
    guard("a.same-h2.conflict-stops", same.b.refused.includes("conflict"), `draft B: ${same.b.refused.join("+") || "promoted"}`),
    guard("a.same-h2.no-prose-lost", same.kept, "A's sentence current; B's still in its draft unless promoted; no conflict markers"),
  ]));

  // A stacked chain: integration branch → task branch → master, judged per operation as the hooks judge it.
  const guardMod = await ctx.module("mode/spec-guard.ts");
  for (const shape of ["stacked", "absorbed"]) {
    const repo = standard(ctx, `a-${shape}`);
    const base = repo.head();
    drafted(ctx, repo, "dint", "§b/other", "Other does Z.", "Other does Z, integrated.");
    drafted(ctx, repo, "dtask", "§a.top/two", "Two does Y.", "Two does Y, tasked.");
    repo.checkout("-b", "integration", base);
    implement(repo, "src/other.txt", 1, "INT");
    evidence(ctx, repo, "dint", "§b/other");
    const pi = promote(ctx, repo, "dint", "§b/other");
    repo.checkout("-b", "task", base);
    implement(repo, "src/two.txt", 1, "TASK");
    evidence(ctx, repo, "dtask", "§a.top/two");
    const pt = promote(ctx, repo, "dtask", "§a.top/two");
    let mid;
    if (shape === "stacked") {
      const before = repo.head();
      repo.merge("integration");
      mid = await guardMod.judgeOp({ top: repo.root, before, after: repo.head(), kind: "merge" }, ctx.tools.core, guardMod.localIO, base);
    } else {
      repo.checkout("master");
      repo.merge("integration");
      const tip = repo.head();
      repo.checkout("task");
      const before = repo.head();
      repo.merge("master");
      mid = await guardMod.judgeOp({ top: repo.root, before, after: repo.head(), kind: "merge" }, ctx.tools.core, guardMod.localIO, tip);
    }
    repo.checkout("master");
    const tip = repo.head();
    repo.merge("task");
    const land = await guardMod.judgeOp({ top: repo.root, before: tip, after: repo.head(), kind: "merge" }, ctx.tools.core, guardMod.localIO, tip);
    const midIds = mid.landing ? mid.foreign ?? [] : [];
    const landIds = land.foreign ?? [];
    const expect = shape === "stacked" ? ["§a.top/two", "§b/other"] : ["§a.top/two"];
    const setup = pi.refused.length === 0 && pt.refused.length === 0;
    rows.push(row("a", `a.${shape}.mid-merge-listed`, midIds.join(",") || "none"));
    rows.push(row("a", `a.${shape}.relisted-at-master`, midIds.filter((id) => landIds.includes(id)).length, [
      guard(`a.${shape}.setup-promoted`, setup, `integration: ${pi.refused.join("+") || "promoted"}; task: ${pt.refused.join("+") || "promoted"}`),
      guard(`a.${shape}.master-landing-listed`, land.landing && expect.every((id) => landIds.includes(id)), `master landing ${land.landing ? "lists" : "is no landing; lists"} ${landIds.join(",") || "none"}; needs ${expect.join(",")}`),
    ]));
  }
  return rows;
}

// ── (b) Evidence ─────────────────────────────────────────────────────────────

export async function evidenceDrift(ctx) {
  const rows = [];
  const results = {};
  for (const kind of ["merge", "rebase", "edit"]) {
    const repo = standard(ctx, `b-${kind}`);
    const base = repo.head();
    drafted(ctx, repo, "dev", "§a.top/one", "One does X.", "One does X, evidenced.");
    // master moves on: unrelated lines of the claimed file (merge), or another file (rebase).
    if (kind === "merge") implement(repo, "src/one.txt", 7, "MASTER");
    if (kind === "rebase") implement(repo, "src/two.txt", 7, "MASTER");
    repo.checkout("-b", "task", base);
    implement(repo, "src/one.txt", 1, "TASK");
    const ev = evidence(ctx, repo, "dev", "§a.top/one");
    if (kind === "merge") { const m = repo.merge("master"); if (m.status !== 0) throw new Error(m.stderr); }
    if (kind === "rebase") { repo.tick++; repo.git(["rebase", "-q", "master"]); }
    if (kind === "edit") implement(repo, "src/one.txt", 1, "AGAIN");
    const p = promote(ctx, repo, "dev", "§a.top/one");
    results[kind] = p;
    const label = p.refused.length ? `${p.refused.join("+")}[${reasonKinds(p.preview).join(",")}]` : "promoted";
    const guards = [guard(`b.${kind}.evidence-recorded`, outcome(ev) === "exit0", `evidence: ${outcome(ev)}`)];
    if (kind === "edit") guards.push(guard("b.edit.goes-stale", p.refused.some((c) => c.startsWith("evidence-")), `promote: ${label}`));
    rows.push(row("b", `b.${kind}.refusal`, label, guards));
  }
  rows.push(row("b", "b.refused-cases", Object.values(results).filter((p) => p.refused.length).length));
  return rows;
}

// ── (c) Hook noise ───────────────────────────────────────────────────────────

/**
 * One scripted session. Each step is a tool call: its kind, and the effect on disk the call would have had
 * (the harness applies it between the pre and post hooks; no shell runs).
 */
function sessionScript(outside) {
  const one = (r) => r.read("src/one.txt");
  return [
    { kind: "read", path: "src/one.txt", what: "read-only tool" },
    { kind: "bash", command: "git status --short", what: "read-only command" },
    { kind: "edit", path: "src/one.txt", effect: (r) => r.write("src/one.txt", one(r).replace("one l3", "one l3 drift")), what: "planted drift: claimed code, claim unchanged" },
    { kind: "bash", command: `cd ${outside} && ls`, what: "command outside the repo" },
    { kind: "bash", command: "cd $S/$p && ls", what: "shell-variable path" },
    { kind: "bash", command: "cd src && ls; cd nested && ls", what: "a relative cd after a cd" },
    { kind: "bash", command: "cat > src/new.txt <<'EOF'\nnew\nEOF", effect: (r) => r.write("src/new.txt", "new\n"), what: "new unclaimed file in the boundary" },
    { kind: "edit", path: "src/one.txt", effect: (r) => r.write("src/one.txt", one(r)), what: "no-op repeat of the edit" },
    { kind: "bash", command: "git diff --stat", what: "read-only command" },
    { kind: "bash", command: `cd ${outside} && ls`, what: "outside the repo, again" },
    { kind: "bash", command: "printf 'more\\n' >> docs/notes.md", effect: (r) => r.write("docs/notes.md", r.read("docs/notes.md") + "more\n"), what: "outside the boundary, unmapped" },
    { kind: "bash", command: "cat > docs/notes.md <<'EOF'\nTo build: make clean; cd build && make\nEOF", effect: (r) => r.write("docs/notes.md", "To build: make clean; cd build && make\n"), what: "a heredoc body that mentions cd, rewriting a file already seen" },
  ];
}

/**
 * Each note's lines classified; a note is information-free when every line is noise. "Git view unavailable"
 * is outside the repo for a path not under its root, misresolved for one under it (a path the shell never
 * was at, e.g. a second relative cd joined to the session cwd).
 */
function classify(notes, root) {
  const seen = new Set();
  const counts = { notes: 0, infoFree: 0, assessment: 0, gitViewOutside: 0, gitViewMisresolved: 0, repeat: 0 };
  for (const note of notes) {
    if (!note) continue;
    counts.notes++;
    const lines = note.split("\n").filter((l) => l.trim());
    const kinds = new Set();
    let noise = 0;
    for (const l of lines) {
      if (/assessment observation unavailable|assessment-observation-unavailable/i.test(l)) { kinds.add("assessment"); noise++; }
      else if (/Git view unavailable/.test(l)) { kinds.add(l.includes(`${root}/`) ? "gitViewMisresolved" : "gitViewOutside"); noise++; }
      else if (seen.has(l)) { kinds.add("repeat"); noise++; }
    }
    for (const l of lines) seen.add(l);
    if (lines.length && noise === lines.length) {
      counts.infoFree++;
      for (const k of kinds) counts[k]++;
    }
  }
  return counts;
}

const flagged = (notes) => {
  const lines = notes.filter(Boolean).flatMap((n) => n.split("\n"));
  return {
    drift: lines.some((l) => l.includes("src/one.txt") && l.includes("§a.top/one")),
    unclaimed: lines.some((l) => l.includes("src/new.txt") && /unclaimed/.test(l)),
  };
};

async function piSession(ctx, repo, steps) {
  const g = await ctx.module("mode/spec-guard.ts");
  const census = new g.CensusHook({ core: () => ctx.tools.core });
  const writes = new g.SpecWriteGuard();
  const commands = [];
  const notes = [];
  await census.prime(repo.root);
  let n = 0;
  for (const s of steps) {
    const id = `call-${++n}`;
    const toolName = s.kind;
    const input = s.kind === "bash" ? { command: s.command } : { path: s.path };
    if (s.kind === "bash") commands.push(s.command);
    const call = { cwd: repo.root, toolName, input };
    await writes.before(id, call);
    await census.before(call);
    s.effect?.(repo);
    const w = await writes.after(id, call);
    const c = await census.after({ ...call, orphansSaid: w.lost, commands, sessionStart: "2023-11-14T00:00:00.000Z" });
    // The tool_result composition of mode/index.ts: write guard, promote drift, census digest, a failure.
    notes.push([w.text, g.driftNote(toolName, input, [{ type: "text", text: "" }]), c.text, c.failure ? `${g.DIGEST_TAG} ${c.failure}` : undefined].filter(Boolean).join("\n"));
  }
  return notes;
}

async function claudeSession(ctx, repo, steps) {
  const h = await ctx.module("claude-code/spec-hooks.ts");
  const stateDir = ctx.ws.dir("hook-state");
  const o = { core: ctx.tools.core, stateDir };
  const ev = (extra) => ({ session_id: "replay", prompt_id: "p1", cwd: repo.root, ...extra });
  await h.runHook("turn", ev({ hook_event_name: "UserPromptSubmit" }), o);
  const notes = [];
  for (const s of steps) {
    const tool_name = s.kind === "bash" ? "Bash" : s.kind === "read" ? "Read" : "Edit";
    const tool_input = s.kind === "bash" ? { command: s.command } : { file_path: join(repo.root, s.path) };
    await h.runHook("pre", ev({ hook_event_name: "PreToolUse", tool_name, tool_input }), o);
    s.effect?.(repo);
    const out = await h.runHook("post", ev({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: { stdout: "" } }), o);
    notes.push(out?.hookSpecificOutput?.additionalContext ?? "");
  }
  return notes;
}

export async function hookNoise(ctx) {
  const rows = [];
  for (const [hook, run] of [["pi", piSession], ["claude", claudeSession]]) {
    const repo = standard(ctx, `c-${hook}`);
    const outside = ctx.ws.dir("outside");
    const steps = sessionScript(outside);
    const notes = await run(ctx, repo, steps);
    const c = classify(notes, repo.root);
    const f = flagged(notes);
    const guards = [
      guard(`c.${hook}.drift-flagged`, f.drift, "a note names src/one.txt with §a.top/one"),
      guard(`c.${hook}.unclaimed-flagged`, f.unclaimed, "a note names src/new.txt as unclaimed"),
    ];
    rows.push(row("c", `c.${hook}.notes`, c.notes, guards));
    rows.push(row("c", `c.${hook}.notes-per-call`, Math.round((c.notes / steps.length) * 100) / 100));
    rows.push(row("c", `c.${hook}.info-free`, c.infoFree));
    rows.push(row("c", `c.${hook}.info-free.assessment-unavailable`, c.assessment));
    rows.push(row("c", `c.${hook}.info-free.git-view-outside`, c.gitViewOutside));
    rows.push(row("c", `c.${hook}.info-free.git-view-misresolved`, c.gitViewMisresolved));
    rows.push(row("c", `c.${hook}.info-free.census-repeat`, c.repeat));
    rows.push(row("c", `c.${hook}.calls-with-note`, steps.map((s, i) => (notes[i] ? `${i + 1}` : null)).filter(Boolean).join(",") || "none"));
  }
  return rows;
}

// ── (d) Invocation shapes ────────────────────────────────────────────────────

const LONG_ID = "§app.insights/aggregate-chips-live-vs-working";
const LONG_TEXT = `## ${LONG_ID}\n\n` + Array.from({ length: 24 }, (_, i) => `Sentence ${i + 1} says what the chips show — live “sessions” vs working ones, \`code\` and all.`).join(" ") + "\n";

/** The exact span a passage's text should be: its heading line up to the next § heading, trailing blank lines dropped. */
function sourceSpan(text, id) {
  const lines = text.split(/(?<=\n)/);
  const start = lines.findIndex((l) => new RegExp(`^#{1,6} ${id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`).test(l));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^#{1,6} §/.test(lines[end])) end++;
  return lines.slice(start, end).join("").replace(/\n\s*$/, "\n");
}

/** Every prose passage a packet stream returns, reassembled by following `next` at the same budget. */
function readPackets(ctx, repo, args) {
  const texts = new Map();
  let r = ctx.tools.spec(repo.root, ctx.ws.home, args);
  const first = r;
  for (let pages = 0; pages < 200 && r.json?.items; pages++) {
    for (const it of r.json.items) if (typeof it.text === "string") texts.set(it.id, (texts.get(it.id) ?? "") + it.text);
    if (!r.json.next) break;
    r = ctx.tools.spec(repo.root, ctx.ws.home, [...args, "--cursor", r.json.next]);
  }
  return { first, texts };
}

export async function invocations(ctx) {
  const repo = new Repo(ctx.ws.dir("d-shapes"), ctx.ws.home).init();
  const files = {
    ".sova/spec/claims/app/insights.md": `# §app/insights\n\nThe insights surface.\n\n${LONG_TEXT}`,
    "src/chips.txt": "chips\n",
  };
  seedSpec(repo, {
    boundary: { include: ["src"], exclude: [] },
    claims: {
      "§app/insights": { kind: "surface", authority: "accepted", evidence: "verified" },
      [LONG_ID]: { kind: "behavior", authority: "accepted", evidence: "verified", requires: [], code: ["src/chips.txt"] },
    },
    files,
  });
  repo.commit("base");
  ctx.tools.draft(repo.root, ctx.ws.home, ["new", "shapes", "--write"]);
  const shapes = [
    ["packet-budget-1024", ["packet", LONG_ID, "--budget", "1024"]],
    ["packet-budget-below-range", ["packet", LONG_ID, "--budget", "512"]],
    ["census-stray-positional", ["census", "--changed", "src/chips.txt"]],
    ["promote-no-selection", ["promote", "shapes"], "draft"],
    ["spec-at-draft-dir", ["census", "--changed", "--spec", ".sova/spec/drafts/shapes"]],
  ];
  const rows = [];
  let usable = 0;
  for (const [name, args, which] of shapes) {
    const r = which === "draft" ? ctx.tools.draft(repo.root, ctx.ws.home, args) : ctx.tools.spec(repo.root, ctx.ws.home, args);
    const code = outcome(r);
    if (/^exit[01]$/.test(code)) usable++;
    rows.push(row("d", `d.${name}`, code));
  }
  // Exactness: every passage any packet shape returns is the claim's own bytes, nothing more or less, and a
  // usable result carries the whole seed passage (an empty "done" is no answer).
  const source = files[".sova/spec/claims/app/insights.md"];
  const problems = [];
  let passages = 0;
  for (const args of [["packet", LONG_ID], ["packet", LONG_ID, "--budget", "1024"]]) {
    const { first, texts } = readPackets(ctx, repo, args);
    if (/^exit[01]$/.test(outcome(first)) && !texts.has(LONG_ID)) problems.push(`${args.slice(2).join(" ") || "default budget"}: no seed passage`);
    for (const [id, text] of texts) {
      passages++;
      if (text !== sourceSpan(source, id)) problems.push(`${args.slice(2).join(" ") || "default budget"}: ${id}`);
    }
  }
  rows.push(row("d", "d.usable-results", `${usable}/${shapes.length}`, [
    guard("d.packet-text-exact", passages > 0 && problems.length === 0, problems.length ? `differs: ${problems.join("; ")}` : `${passages} passage(s) byte-equal to their source span`),
  ]));
  return rows;
}

// ── (e) Draft leftovers ──────────────────────────────────────────────────────

export async function leftovers(ctx) {
  const repo = standard(ctx, "e-drafts");
  const base = repo.head();
  drafted(ctx, repo, "done", "§a.top/one", "One does X.", "One does X, done.");
  drafted(ctx, repo, "feat", "§a.top/two", "Two does Y.", "Two does Y, featured.");
  implement(repo, "src/one.txt", 1, "DONE");
  evidence(ctx, repo, "done", "§a.top/one");
  const pd = promote(ctx, repo, "done", "§a.top/one");
  // feat now conflicts (same claim file): redone as feat-2 from current, the usual hand re-apply.
  implement(repo, "src/two.txt", 1, "FEAT");
  evidence(ctx, repo, "feat", "§a.top/two");
  const pf = promote(ctx, repo, "feat", "§a.top/two");
  drafted(ctx, repo, "feat-2", "§a.top/two", "Two does Y.", "Two does Y, featured.");
  evidence(ctx, repo, "feat-2", "§a.top/two");
  const pf2 = promote(ctx, repo, "feat-2", "§a.top/two");
  drafted(ctx, repo, "live", "§b/other", "Other does Z.", "Other does Z, live.");
  const names = ["done", "feat", "feat-2", "live"];
  const outputs = {
    check: ctx.tools.spec(repo.root, ctx.ws.home, ["check"]),
    census: ctx.tools.spec(repo.root, ctx.ws.home, ["census"]),
    landing: ctx.tools.spec(repo.root, ctx.ws.home, ["foreign", "--base", base, "--landing"]),
  };
  const rows = [];
  for (const name of names) {
    const s = ctx.tools.draft(repo.root, ctx.ws.home, ["status", name]).json;
    const states = (s?.ids ?? []).map((i) => `${i.id}:${i.current}`).join(",") || "no-ids";
    const listed = (outputs.landing.json?.unpromotedDrafts ?? []).some((d) => d.draft === name || d.draft?.endsWith(`/${name}`));
    const mentions = Object.entries(outputs).filter(([, r]) => new RegExp(`drafts/${name}(?![\\w-])|"${name}"`).test(r.stdout)).map(([k]) => k);
    rows.push(row("e", `e.${name}.reported`, `status=${states}; promotions=${s?.promotions?.length ?? "?"}; landing-unpromoted=${listed ? "listed" : "no"}; mentioned-by=${mentions.join("+") || "none"}`));
  }
  // Paths are no hint: only the words of a message or field name count.
  const cleanup = Object.values(outputs).filter((r) => /leftover|superseded|safe to (delete|remove)|fully promoted/i.test(r.stdout.split(ctx.ws.base).join(""))).length;
  rows.push(row("e", "e.cleanup-hints", cleanup, [
    guard("e.setup", pd.refused.length === 0 && pf.refused.includes("conflict") && pf2.refused.length === 0, `done: ${pd.refused.join("+") || "promoted"}; feat: ${pf.refused.join("+") || "promoted"}; feat-2: ${pf2.refused.join("+") || "promoted"}`),
  ]));
  return rows;
}

export const SCENARIOS = { a: merging, b: evidenceDrift, c: hookNoise, d: invocations, e: leftovers, f: sliceQuality, g: fullness };

/** Load a module of the arm's tree (each tree's own copy, so two arms never share module state). */
export function moduleLoader(tree) {
  return (rel) => import(pathToFileURL(join(tree, rel)).href);
}
