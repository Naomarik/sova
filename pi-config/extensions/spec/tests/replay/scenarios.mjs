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
  // A tool that fails internally measured nothing: the scenario crashes (exit 2), never a guard's pass.
  const sound = (r) => { if (/(^|\+)internal(\+|$)|^no-json/.test(outcome(r))) throw new Error(`promote ${name} ${id}: ${outcome(r)}: ${(r.json?.findings ?? []).map((f) => f.message).join("; ").split("\n")[0]}`); return r; };
  const preview = sound(ctx.tools.draft(repo.root, ctx.ws.home, ["promote", name, "--id", id]));
  const refusals = (preview.json?.refusals ?? []).map((x) => x.code).sort();
  const plan = preview.json?.plan;
  if (refusals.length || !plan) return { refused: refusals.length ? refusals : [outcome(preview)], preview };
  const write = sound(ctx.tools.draft(repo.root, ctx.ws.home, ["promote", name, "--id", id, "--plan", plan, "--write"]));
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

  rows.push(...sameSpot(ctx));
  rows.push(...manifestMerge(ctx));
  rows.push(...claimsMergeRows(ctx));
  return rows;
}

/** A new note H2 in a draft, inserted right before `before` (a heading line of the draft's claim file). */
function addH2(repo, draft, id, text, before = "## §a.top/two", record = { kind: "note", authority: "accepted" }) {
  replaceIn(repo, draftClaim(draft, "§a.top/one"), before, `## ${id}\n\n${text}\n\n${before}`);
  const rel = `.sova/spec/drafts/${draft}/spec/manifest.json`;
  const m = JSON.parse(repo.read(rel));
  m.claims[id] = record;
  repo.write(rel, JSON.stringify(m, null, 2) + "\n");
}

const docOnly = (ctx, repo, name, id) =>
  ctx.tools.draft(repo.root, ctx.ws.home, ["evidence", name, "--id", id, "--by", "replay", "--verification", "fixture: replay scenario", "--doc-only", "--write"]);

/** The H2 ids of a claim file, in order. */
const h2Order = (text) => [...text.matchAll(/^## (§\S+)/gm)].map((m) => m[1]);

/**
 * Two drafts from one base each add a new H2 at the same spot (after §a.top/one), landed in both orders; and two
 * drafts adding the same new id with different text. A target row today: the second landing conflicts whole-file.
 */
function sameSpot(ctx) {
  const land = (order) => {
    const repo = standard(ctx, `a-same-spot-${order.join("")}`);
    const texts = { A: ["§a.top/zeta", "Zeta is added by A."], B: ["§a.top/alpha", "Alpha is added by B."] };
    for (const k of ["A", "B"]) {
      ctx.tools.draft(repo.root, ctx.ws.home, ["new", `d${k.toLowerCase()}`, "--write"]);
      addH2(repo, `d${k.toLowerCase()}`, ...texts[k]);
      docOnly(ctx, repo, `d${k.toLowerCase()}`, texts[k][0]);
    }
    const out = order.map((k) => `${k}:${promote(ctx, repo, `d${k.toLowerCase()}`, texts[k][0]).refused.join("+") || "promoted"}`);
    const file = repo.read(currentClaim("§a.top/one"));
    const kept = ["A", "B"].every((k) => file.includes(texts[k][1]) || repo.read(draftClaim(`d${k.toLowerCase()}`, "§a.top/one")).includes(texts[k][1])) && file.includes("Plain H3 prose.") && !/^(<<<<<<<|>>>>>>>|=======)/m.test(file);
    return { out, file, kept };
  };
  const ab = land(["A", "B"]), ba = land(["B", "A"]);
  // The same new id, different text on each side.
  const repo = standard(ctx, "a-same-spot-same-id");
  for (const [k, text] of [["C", "Mid says C."], ["D", "Mid says D."]]) {
    ctx.tools.draft(repo.root, ctx.ws.home, ["new", `d${k.toLowerCase()}`, "--write"]);
    addH2(repo, `d${k.toLowerCase()}`, "§a.top/mid", text);
    docOnly(ctx, repo, `d${k.toLowerCase()}`, "§a.top/mid");
  }
  const c = promote(ctx, repo, "dc", "§a.top/mid"), d = promote(ctx, repo, "dd", "§a.top/mid");
  const sameIdKept = repo.read(currentClaim("§a.top/one")).includes("Mid says C.") && repo.read(draftClaim("dd", "§a.top/one")).includes("Mid says D.");
  return [row("a", "a.target.same-spot", {
    orderAB: ab.out.join(" "), orderBA: ba.out.join(" "), identical: ab.file === ba.file,
    h2s: h2Order(ab.file).join(","), sameId: `${c.refused.join("+") || "promoted"}, then ${d.refused.join("+") || "promoted"}`,
  }, [
    guard("a.same-spot.same-id-stops", c.refused.length === 0 && d.refused.includes("conflict"), `first: ${c.refused.join("+") || "promoted"}; second: ${d.refused.join("+") || "promoted"}`),
    guard("a.same-spot.no-prose-lost", ab.kept && ba.kept && sameIdKept, "each added H2 is current or still in its refused draft, in both orders; H3 prose kept; no conflict markers"),
  ])];
}

/**
 * The manifest merge driver (`.gitattributes` → `merge-manifest`), configured repo-locally to the tree under test:
 * two branches each promote a new record onto one base and merge; then two branches change the same record.
 */
function manifestMerge(ctx) {
  const setup = (label, driver) => {
    const repo = standard(ctx, label);
    repo.write(".gitattributes", ".sova/spec/manifest.json merge=sova-spec-manifest\n");
    repo.commit("attributes", [".gitattributes"]);
    if (driver) repo.git(["config", "merge.sova-spec-manifest.driver", `node "${join(ctx.tools.core, "sova-spec-draft.mjs")}" merge-manifest --root . --base %O --ours %A --theirs %B --write`]);
    return repo;
  };
  const records = (repo) => Object.keys(JSON.parse(repo.read(".sova/spec/manifest.json")).claims);
  const twoRecords = (driver) => {
    const repo = setup(`a-manifest-${driver ? "driver" : "plain"}`, driver);
    const base = repo.head();
    const add = (branch, draft, id, text, file, before) => {
      repo.checkout("-b", branch, base);
      ctx.tools.draft(repo.root, ctx.ws.home, ["new", draft, "--write"]);
      replaceIn(repo, `.sova/spec/drafts/${draft}/spec/claims/${file}`, before, `${before}\n\n## ${id}\n\n${text}`);
      const rel = `.sova/spec/drafts/${draft}/spec/manifest.json`;
      const m = JSON.parse(repo.read(rel));
      m.claims[id] = { kind: "note", authority: "accepted" };
      repo.write(rel, JSON.stringify(m, null, 2) + "\n");
      docOnly(ctx, repo, draft, id);
      return promote(ctx, repo, draft, id);
    };
    const x = add("x", "dx", "§a.top/xnote", "X's note.", "a/top.md", "Two does Y.");
    const y = add("y", "dy", "§b.other/ynote", "Y's note.", "b/other.md", "Other does Z.");
    const m = repo.merge("x");
    const ids = m.status === 0 ? records(repo) : [];
    if (m.status !== 0) repo.git(["merge", "--abort"], { allowFail: true });
    return { promoted: x.refused.length === 0 && y.refused.length === 0, merged: m.status === 0, both: ids.includes("§a.top/xnote") && ids.includes("§b.other/ynote") };
  };
  const plain = twoRecords(false), driven = twoRecords(true);
  // The same record changed differently on both branches must still stop.
  const repo = setup("a-manifest-same", true);
  const base = repo.head();
  const edit = (branch, value) => {
    repo.checkout("-b", branch, base);
    const m = JSON.parse(repo.read(".sova/spec/manifest.json"));
    m.claims["§b/other"].evidence = value;
    repo.write(".sova/spec/manifest.json", JSON.stringify(m, null, 2) + "\n");
    repo.commit(`edit ${branch}`, [".sova/spec/manifest.json"]);
  };
  edit("p", "reviewed");
  edit("q", "verified");
  const same = repo.merge("p");
  return [row("a", "a.manifest-merge", {
    withoutDriver: plain.merged ? "merged" : "conflict", withDriver: driven.merged ? "merged" : "conflict", sameRecord: same.status === 0 ? "merged" : "stopped",
  }, [
    guard("a.manifest-merge.setup", plain.promoted && driven.promoted, "both branches promoted their record"),
    guard("a.manifest-merge.two-records-merge", driven.merged && driven.both, `with the driver: ${driven.merged ? "merged" : "conflict"}, ${driven.both ? "both records present" : "a record missing"}`),
    guard("a.manifest-merge.same-record-stops", same.status !== 0, `the same record changed on both sides: ${same.status === 0 ? "merged" : "stopped"}`),
  ])];
}

const CLAIMS_ATTR = ".sova/spec/claims/**/*.md merge=sova-spec-claims";
const MARKERS = /^(<<<<<<<|>>>>>>>|=======)/m;

/** Whether the tree's draft tool has `merge-claims` (an old tree answers `command: null`, unknown command). */
export function hasClaimsDriver(ctx) {
  const r = ctx.tools.draft(ctx.ws.home, ctx.ws.home, ["merge-claims"]);
  return r.json?.command === "merge-claims";
}

/** `standard`, with both drivers' attributes committed and each driver the tree has configured repo-locally. */
function driven(ctx, label) {
  const repo = standard(ctx, label);
  repo.write(".gitattributes", `.sova/spec/manifest.json merge=sova-spec-manifest\n${CLAIMS_ATTR}\n`);
  repo.commit("attributes", [".gitattributes"]);
  const draftCli = join(ctx.tools.core, "sova-spec-draft.mjs");
  repo.git(["config", "merge.sova-spec-manifest.driver", `"${process.execPath}" "${draftCli}" merge-manifest --root . --base %O --ours %A --theirs %B --write`]);
  if (hasClaimsDriver(ctx)) repo.git(["config", "merge.sova-spec-claims.driver", `"${process.execPath}" "${draftCli}" merge-claims --root . --base %O --ours %A --theirs %B --path %P --write`]);
  return repo;
}

const unmerged = (repo) => repo.git(["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean).sort();

/** Merge `theirs` into a new branch made at `ours`: the conflicted paths and the resulting files, then the merge is undone. */
function mergeAt(repo, ours, theirs, files) {
  repo.checkout("-b", `m-${ours}-${theirs}`, ours);
  const m = repo.merge(theirs);
  const conflicts = m.status === 0 ? [] : unmerged(repo);
  const out = Object.fromEntries(files.map((f) => [f, repo.read(f)]));
  if (m.status !== 0) repo.git(["merge", "--abort"], { allowFail: true });
  return { status: m.status, conflicts, files: out };
}

/**
 * The claims merge driver (`.gitattributes` → `merge-claims`) and landing-order-independent manifest keys.
 * Two branches each promote a new H2 at the same spot of one claims file (the pair `sameSpot` lands in one tree),
 * merged in both orders with both drivers configured: conflicted paths, and bytes against the in-tree promotion.
 * Then the hand path PROMOTE.md documents for a conflicted claims file, counted in tool calls; the same H2 changed on
 * both branches; a non-spec Markdown file changed at one spot on both.
 */
export function claimsMergeRows(ctx) {
  const A = ["§a.top/zeta", "Zeta is added by A."], B = ["§a.top/alpha", "Alpha is added by B."];
  const CLAIM = currentClaim("§a.top/one"), MANIFEST = ".sova/spec/manifest.json";
  const stage = (repo, draft, [id, text]) => {
    ctx.tools.draft(repo.root, ctx.ws.home, ["new", draft, "--write"]);
    addH2(repo, draft, id, text);
    docOnly(ctx, repo, draft, id);
  };
  // In one tree: both orders, the reference bytes.
  const inTree = (order) => {
    const repo = standard(ctx, `a-claims-tree-${order.join("")}`);
    stage(repo, "da", A);
    stage(repo, "db", B);
    const out = order.map((k) => promote(ctx, repo, `d${k.toLowerCase()}`, (k === "A" ? A : B)[0]).refused.join("+") || "promoted");
    return { out, claim: repo.read(CLAIM), manifest: repo.read(MANIFEST) };
  };
  const tAB = inTree(["A", "B"]), tBA = inTree(["B", "A"]);

  // Across branches: x promotes A, y promotes B, from one base.
  const repo = driven(ctx, "a-claims-git");
  const base = repo.head();
  repo.checkout("-b", "x", base); stage(repo, "da", A); const px = promote(ctx, repo, "da", A[0]);
  repo.checkout("-b", "y", base); stage(repo, "db", B); const py = promote(ctx, repo, "db", B[0]);
  const yx = mergeAt(repo, "y", "x", [CLAIM, MANIFEST]), xy = mergeAt(repo, "x", "y", [CLAIM, MANIFEST]);
  const bothKept = (text) => text.includes(A[1]) && text.includes(B[1]) && text.includes("Plain H3 prose.") && text.includes("Two does Y.");
  const clean = (r) => r.conflicts.length === 0 && r.status === 0;

  // The documented hand path when the claims file conflicts (PROMOTE.md: master's file, then the branch's text again
  // through a new draft), on y merging x; one tool call per step, as an agent would run them.
  let handCalls = null, handEqual = null, handH2s = null;
  if (!clean(yx)) {
    let calls = 0;
    const call = (fn) => { calls++; return fn(); };
    repo.checkout("-b", "hand", "y");
    call(() => repo.merge("x"));
    call(() => unmerged(repo));                                                         // see what conflicted
    call(() => repo.git(["checkout", "x", "--", MANIFEST, CLAIM]));                      // master's (x's) manifest and claims file
    call(() => repo.commit("merge x, spec from x", [MANIFEST, CLAIM]));                  // conclude the merge
    call(() => ctx.tools.draft(repo.root, ctx.ws.home, ["new", "db2", "--write"]));     // a new draft from current
    call(() => replaceIn(repo, draftClaim("db2", "§a.top/one"), "## §a.top/two", `## ${B[0]}\n\n${B[1]}\n\n## §a.top/two`)); // re-add the H2
    call(() => { const rel = ".sova/spec/drafts/db2/spec/manifest.json"; const m = JSON.parse(repo.read(rel)); m.claims[B[0]] = { kind: "note", authority: "accepted" }; repo.write(rel, JSON.stringify(m, null, 2) + "\n"); }); // and its record
    call(() => docOnly(ctx, repo, "db2", B[0]));                                        // evidence
    const pre = call(() => ctx.tools.draft(repo.root, ctx.ws.home, ["promote", "db2", "--id", B[0]]));       // preview
    call(() => ctx.tools.draft(repo.root, ctx.ws.home, ["promote", "db2", "--id", B[0], "--plan", pre.json?.plan ?? "", "--write"]));
    call(() => repo.commit("re-apply db", [".sova/spec"]));                             // commit the claims
    handCalls = calls;
    handEqual = repo.read(CLAIM) === tAB.claim;
    handH2s = h2Order(repo.read(CLAIM)).join(",");
  }

  // Guard: the same H2 changed differently on each branch still conflicts, and neither sentence is lost.
  const same = driven(ctx, "a-claims-same-h2");
  const sBase = same.head();
  for (const [b, who] of [["p", "P"], ["q", "Q"]]) {
    same.checkout("-b", b, sBase);
    // Promoting such an edit is a.same-h2's business; here only the merge of two promoted results counts.
    replaceIn(same, CLAIM, "One does X.", `One does X, said by ${who}.`);
    same.commit(`edit ${b}`, [CLAIM]);
  }
  const sm = mergeAt(same, "q", "p", [CLAIM]);
  const sameText = sm.files[CLAIM];

  // Guard: a non-spec Markdown file changed at one spot on both branches gets Git's own conflict, markers and all.
  const plain = driven(ctx, "a-claims-non-spec");
  const pBase = plain.head();
  for (const b of ["u", "v"]) {
    plain.checkout("-b", b, pBase);
    plain.write("docs/notes.md", `notes\n${b} adds a line.\n`);
    plain.commit(`notes ${b}`, ["docs/notes.md"]);
  }
  const pm = mergeAt(plain, "v", "u", ["docs/notes.md"]);
  const attr = plain.git(["check-attr", "merge", "--", "docs/notes.md"]).stdout;

  return [row("a", "a.target.claims-driver", {
    driver: hasClaimsDriver(ctx) ? "configured" : "absent",
    conflictsYX: yx.conflicts.length, conflictsXY: xy.conflicts.length, conflictedPaths: [...new Set([...yx.conflicts, ...xy.conflicts])].join(","),
    equalsInTree: clean(yx) && clean(xy) && yx.files[CLAIM] === tAB.claim && xy.files[CLAIM] === tAB.claim,
    ordersIdentical: yx.files[CLAIM] === xy.files[CLAIM], inTreeH2s: h2Order(tAB.claim).join(","), handCalls, handEqualsInTree: handEqual, handH2s,
  }, [
    guard("a.claims-driver.setup", px.refused.length === 0 && py.refused.length === 0 && tAB.out.concat(tBA.out).every((o) => o === "promoted") && tAB.claim === tBA.claim,
      `branches: ${px.refused.join("+") || "promoted"}, ${py.refused.join("+") || "promoted"}; in tree: ${tAB.out.join(" ")} / ${tBA.out.join(" ")}, ${tAB.claim === tBA.claim ? "identical" : "differ"}`),
    guard("a.claims-driver.no-prose-lost", bothKept(yx.files[CLAIM]) && bothKept(xy.files[CLAIM]) && (!clean(yx) || !MARKERS.test(yx.files[CLAIM])) && (!clean(xy) || !MARKERS.test(xy.files[CLAIM])),
      "both new H2s, the H3 prose and §a.top/two's prose in the merged file, in both orders; markers only on a conflict"),
    guard("a.claims-driver.same-h2-stops", sm.conflicts.includes(CLAIM), `the same H2 changed on both branches: ${sm.conflicts.join(",") || "merged"}`),
    guard("a.claims-driver.same-h2-no-prose-lost", sameText.includes("said by P.") && sameText.includes("said by Q."), "both sentences in the conflicted file"),
    guard("a.claims-driver.non-spec-untouched", /merge: unspecified$/.test(attr) && pm.conflicts.includes("docs/notes.md") && MARKERS.test(pm.files["docs/notes.md"]),
      `docs/notes.md: ${attr.replace(/^.*: merge: /, "attribute ")}; ${pm.conflicts.length ? "Git's conflict" : "merged"}`),
  ]), row("a", "a.target.manifest-order", {
    inTreeIdentical: tAB.manifest === tBA.manifest,
    gitIdentical: yx.files[MANIFEST] === xy.files[MANIFEST],
    gitEqualsInTree: yx.files[MANIFEST] === tAB.manifest && xy.files[MANIFEST] === tAB.manifest,
    manifestConflicts: [yx, xy].filter((r) => r.conflicts.includes(MANIFEST)).length,
  })];
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
    notes.push([w.text, g.driftNote(toolName, input, [{ type: "text", text: "" }]), c.text, c.failure].filter(Boolean).join("\n"));
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

/**
 * One hook's session, run in fresh repositories until two runs give the same notes (paths aside), at most 5. The
 * hooks bound each git and census call with a timeout (TOOL_TIMEOUT_MS) and add an "incomplete check" note when
 * one runs out; on a loaded machine that adds notes the tree didn't cause. Notes that never repeat are an error.
 */
async function stableSession(ctx, hook, run) {
  const seen = new Map();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const repo = standard(ctx, `c-${hook}`);
    const outside = ctx.ws.dir("outside");
    const steps = sessionScript(outside);
    const notes = await run(ctx, repo, steps);
    const key = JSON.stringify(notes.map((n) => n.split(repo.root).join("<repo>").split(outside).join("<outside>")));
    if (seen.has(key)) return { repo, steps, notes };
    seen.set(key, attempt);
  }
  throw new Error(`c.${hook}: no two of 5 sessions gave the same notes (hook timeouts under load?)`);
}

export async function hookNoise(ctx) {
  const rows = [];
  for (const [hook, run] of [["pi", piSession], ["claude", claudeSession]]) {
    const { repo, steps, notes } = await stableSession(ctx, hook, run);
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
  drafted(ctx, repo, "feat", "§a.top/one", "One does X.", "One does X, featured.");
  implement(repo, "src/one.txt", 1, "DONE");
  evidence(ctx, repo, "done", "§a.top/one");
  const pd = promote(ctx, repo, "done", "§a.top/one");
  // feat now conflicts (the same H2 changed differently on both sides): redone as feat-2 from current, the usual hand re-apply.
  implement(repo, "src/one.txt", 3, "FEAT");
  evidence(ctx, repo, "feat", "§a.top/one");
  const pf = promote(ctx, repo, "feat", "§a.top/one");
  // Only a refused feat needs redoing; if it landed, feat-2 has nothing to re-apply, and e.setup says so.
  let pf2 = { refused: ["not-needed"] };
  if (pf.refused.includes("conflict")) {
    drafted(ctx, repo, "feat-2", "§a.top/one", "One does X, done.", "One does X, done and featured.");
    evidence(ctx, repo, "feat-2", "§a.top/one");
    pf2 = promote(ctx, repo, "feat-2", "§a.top/one");
  } else ctx.tools.draft(repo.root, ctx.ws.home, ["new", "feat-2", "--write"]);
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

// ── (h) Agreed, not built ────────────────────────────────────────────────────

/**
 * A requirements chat's outcome: a draft adds a behavior with `agreed: {by, at}` and no code, records --doc-only
 * evidence and promotes. A second draft tries the same for a behavior that maps code. Whatever lands must not read
 * as built: no code, and no reviewed/verified evidence label.
 */
export async function agreement(ctx) {
  const repo = standard(ctx, "h-agreed");
  const agreed = { by: "replay", at: "2023-11-14" };
  const attempt = (draft, id, text, extra) => {
    ctx.tools.draft(repo.root, ctx.ws.home, ["new", draft, "--write"]);
    addH2(repo, draft, id, text, "## §a.top/two", { kind: "behavior", authority: "accepted", requires: [], agreed, ...extra });
    const ev = docOnly(ctx, repo, draft, id);
    const p = /^exit0$/.test(outcome(ev)) ? promote(ctx, repo, draft, id) : { refused: [`evidence:${outcome(ev)}`] };
    return p.refused.join("+") || "promoted";
  };
  const unbuilt = attempt("talk", "§a.top/agreed-rule", "The agreed rule says what a chat decided.", {});
  const built = attempt("talk-built", "§a.top/built-rule", "The built rule maps code.", { code: ["src/one.txt"] });
  const current = JSON.parse(repo.read(".sova/spec/manifest.json")).claims;
  const readsBuilt = (id) => current[id] && ((current[id].code ?? []).length > 0 || ["reviewed", "verified"].includes(current[id].evidence));
  return [...fieldOnly(ctx), row("h", "h.target.agreed-promoted", unbuilt === "promoted" ? 1 : 0), row("h", "h.agreed", { unbuilt, built }, [
    // Nothing that landed on doc-only evidence reads as built (no code, no reviewed/verified label).
    guard("h.unbuilt-not-built", !readsBuilt("§a.top/agreed-rule") && !readsBuilt("§a.top/built-rule"), ["§a.top/agreed-rule", "§a.top/built-rule"].map((id) => current[id] ? `${id}: code ${JSON.stringify(current[id].code ?? [])}, evidence ${current[id].evidence ?? "none"}` : `${id}: not current`).join("; ")),
    guard("h.doc-only-refuses-code", built !== "promoted" && !current["§a.top/built-rule"], `an agreed record that maps code, on doc-only evidence: ${built}`),
  ])];
}

/**
 * M6's field records: a change that only sets embeds/about/core on a built behavior may land on doc-only evidence
 * (a target: 0 until the drafts rule exists); the same field change bundled with a prose, code-list or label change
 * never does (a guard: it must still be verified against code). Each case in its own repo, on §a.top/one (maps code).
 */
function fieldOnly(ctx) {
  const id = "§a.top/one";
  const cases = {
    "field-only": () => {},
    "with-prose": (repo, d) => replaceIn(repo, draftClaim(d, id), "One does X.", "One does X, and now W."),
    "with-code": (repo, d) => editDraftRecord(repo, d, id, (r) => { r.code = [...r.code, "src/two.txt"]; }),
    "with-label": (repo, d) => editDraftRecord(repo, d, id, (r) => { r.authority = "migrated"; }),
  };
  const out = {};
  for (const [name, extra] of Object.entries(cases)) {
    const repo = standard(ctx, `h-field-${name}`);
    const draft = `field-${name}`;
    ctx.tools.draft(repo.root, ctx.ws.home, ["new", draft, "--write"]);
    editDraftRecord(repo, draft, id, (r) => { r.core = true; });
    extra(repo, draft);
    const ev = docOnly(ctx, repo, draft, id);
    // A refusal by its code: the bundled-change one (doc-only-bundled) apart from doc-only's plain refusal.
    const codes = [...new Set([ev.json?.code, ...(ev.json?.findings ?? []).map((f) => f.code)].filter(Boolean))].sort();
    const p = /^exit0$/.test(outcome(ev)) ? promote(ctx, repo, draft, id) : { refused: [`evidence:${codes.join(",") || outcome(ev)}`] };
    const current = JSON.parse(repo.read(".sova/spec/manifest.json")).claims[id];
    out[name] = { outcome: p.refused.join("+") || "promoted", landed: current.core === true };
  }
  const bundled = ["with-prose", "with-code", "with-label"];
  return [
    row("h", "h.target.field-only-doc-only", out["field-only"].outcome === "promoted" && out["field-only"].landed ? 1 : 0),
    row("h", "h.field-doc-only", Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.outcome])), [
      guard("h.field-bundle-refused", bundled.every((k) => out[k].outcome !== "promoted" && !out[k].landed),
        bundled.map((k) => `${k}: ${out[k].outcome}`).join("; ")),
    ]),
  ];
}

export const SCENARIOS = { a: merging, b: evidenceDrift, c: hookNoise, d: invocations, e: leftovers, f: sliceQuality, g: fullness, h: agreement };

/** Load a module of the arm's tree (each tree's own copy, so two arms never share module state). */
export function moduleLoader(tree) {
  return (rel) => import(pathToFileURL(join(tree, rel)).href);
}
