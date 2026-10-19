// `agree`: stamps the draft's records with who agreed and when, records doc-only evidence for those with no
// code, and promotes them only when promote's own plan is clean; otherwise it writes nothing to the current
// spec. Black-box tests for core/sova-spec-draft.mjs on a Git fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../core/sova-spec-draft.mjs");
// The runtime's SPEC_AGREE_SOURCE, SPEC_AGREE_GIVEN and PI_CODING_AGENT_DIR are dropped too: a test says where its
// go-ahead came from (or that there is none), and pi's sessions are the fixture's own, under its HOME.
const DROPPED = new Set(["SPEC_AGREE_SOURCE", "SPEC_AGREE_GIVEN", "PI_CODING_AGENT_DIR"]);
const fixtureEnv = (root, extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !DROPPED.has(k))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home"), ...extra });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const git = (root, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
};
const ID = "§app.list/title-chars", FILE = ".sova/spec/claims/app/list.md", MANIFEST = ".sova/spec/manifest.json";
const D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const TOP = "# §app/list\n\nThe session list.\n";
const promise = (sentence) => `${TOP}\n## ${ID}\n\n${sentence}\n`;
const SIXTY = "A session title shows at most 60 characters, then an ellipsis.";

/** A pi session file under agentDir/sessions: a header, then entries [id, type, role?]. */
function piSession(agentDir, file, id, entries) {
  write(agentDir, `sessions/--proj--/${file}`, [{ type: "session", version: 3, id, timestamp: "2026-10-19T00:00:00.000Z", cwd: "/p" },
    ...entries.map(([eid, type, role]) => ({ type, id: eid, parentId: null, timestamp: "2026-10-19T00:00:01.000Z", ...(role ? { message: { role, content: [{ type: "text", text: "t" }] } } : { customType: "x" }) }))]
    .map((e) => JSON.stringify(e)).join("\n") + "\n");
}
// The fixture's pi sessions, at pi's default agent dir under the fixture's HOME: s1 named by its file, and 01a1-5137
// found by its header alone.
function piSessions(root) {
  const agentDir = join(root, "home", ".pi", "agent");
  piSession(agentDir, "2026-10-19T00-00-00-000Z_s1.jsonl", "s1", [["e3", "message", "user"], ["a1", "message", "assistant"], ["c1", "custom_message"], ["e7", "message", "user"]]);
  piSession(agentDir, "renamed.jsonl", "01a1-5137", [["e9f2", "message", "user"]]);
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "sova-agree-"));
  roots.push(root);
  piSessions(root);
  write(root, MANIFEST, JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims: { "§app/list": { kind: "surface", authority: "accepted" } } }, null, 2) + "\n");
  write(root, FILE, TOP);
  write(root, "src/list.js", "export const MAX = 60;\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}
function run(root, ...args) { return runEnv(root, {}, ...args); }
function runEnv(root, env, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root, env) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
/** A draft holding the decided promise, its record without agreed (rec merged in). */
function decided(root, name, rec = {}, sentence = SIXTY) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  write(root, D(name, "claims/app/list.md"), promise(sentence));
  editManifest(root, D(name, "manifest.json"), (m) => { m.claims[ID] = { kind: "behavior", requires: [], ...rec }; });
}
const SOURCE = "chat:c1#m3";
const agree = (root, name, ...more) => run(root, "agree", name, "--id", ID, "--by", "user", "--source", SOURCE, "--verification", "agreed in alignment al_1", ...more, "--write");
const currentSpec = (root) => read(root, MANIFEST) + read(root, FILE);
const evidenceOf = (root, name) => JSON.parse(read(root, `.sova/spec/drafts/${name}/draft.json`)).evidence ?? [];
const codes = (j) => [...(j.findings ?? []).map((f) => f.code), ...(j.refusals ?? []).map((r) => r.code)];

test("agree lands a decided promise with no code in the current spec: agreed {by, at}, doc-only evidence, a receipt naming the plan", () => {
  const root = project();
  decided(root, "talk");
  const a = agree(root, "talk");
  assert.equal(a.exit, 0, JSON.stringify(a));
  const rec = JSON.parse(read(root, MANIFEST)).claims[ID];
  assert.ok(rec, "the record is in the current spec");
  assert.equal(rec.agreed.by, "user");
  assert.equal(rec.agreed.source, SOURCE, "the stamp says where the go-ahead was given");
  assert.match(rec.agreed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/, "now, to the UTC minute");
  assert.equal(rec.authority, "accepted");
  assert.equal(rec.code, undefined);
  assert.ok(read(root, FILE).includes(SIXTY));
  assert.ok(evidenceOf(root, "talk").some((e) => e.mode === "doc-only" && e.ids.some((i) => (i.id ?? i) === ID)), "doc-only evidence recorded");
  assert.match(JSON.stringify(a), /"plan[^"]*":"[0-9a-f]{12,64}"/, "the receipt carries promote's plan sha");
});

test("guard: a conflict with the current spec (the same § promoted since the draft was made) refuses and writes nothing", () => {
  const root = project();
  decided(root, "talk");
  // elsewhere, the same § lands with other words
  decided(root, "other", {}, "A session title shows at most 80 characters.");
  assert.equal(agree(root, "other").exit, 0);
  const before = currentSpec(root);
  const a = agree(root, "talk");
  assert.notEqual(a.exit, 0, "refused");
  assert.equal(currentSpec(root), before, "the current spec is byte-identical");
  assert.ok(read(root, FILE).includes("80 characters") && !read(root, FILE).includes(SIXTY));
});

test("guard: a record that maps code is stamped but never promoted by agree", () => {
  const root = project();
  decided(root, "build", { code: ["src/list.js"] });
  const before = currentSpec(root);
  const a = agree(root, "build");
  assert.equal(currentSpec(root), before, "the current spec is byte-identical");
  assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID], undefined);
  const rec = JSON.parse(read(root, D("build", "manifest.json"))).claims[ID];
  assert.equal(rec.agreed?.by, "user", `stamped in the draft (agree said ${JSON.stringify(codes(a))})`);
  assert.ok(!evidenceOf(root, "build").some((e) => e.mode === "doc-only"), "no doc-only evidence for code");
});

test("guard: agree run twice is idempotent", () => {
  const root = project();
  decided(root, "talk");
  assert.equal(agree(root, "talk").exit, 0);
  const once = currentSpec(root), at = JSON.parse(read(root, MANIFEST)).claims[ID].agreed.at;
  const b = agree(root, "talk");
  assert.equal(b.exit, 0, JSON.stringify(b));
  assert.equal(currentSpec(root), once, "the current spec is byte-identical after the second run");
  assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID].agreed.at, at);
});

test("agree says where the go-ahead was given: with no --source and no SPEC_AGREE_SOURCE it stamps nothing", () => {
  const root = project();
  decided(root, "talk");
  const before = read(root, D("talk", "manifest.json")) + currentSpec(root);
  const a = run(root, "agree", "talk", "--id", ID, "--by", "user", "--verification", "the brief says the user agreed", "--write");
  assert.equal(a.exit, 1);
  assert.deepEqual(codes(a), ["agree-unsourced"]);
  assert.equal(read(root, D("talk", "manifest.json")) + currentSpec(root), before, "nothing written, draft or current");
  // a blank variable is no source either
  assert.deepEqual(codes(runEnv(root, { SPEC_AGREE_SOURCE: "  " }, "agree", "talk", "--id", ID, "--by", "user", "--verification", "v")), ["agree-unsourced"]);
});

test("the runtime's SPEC_AGREE_SOURCE is the source when --source is absent; a malformed --source is a usage error", () => {
  const root = project();
  decided(root, "talk");
  const a = runEnv(root, { SPEC_AGREE_SOURCE: "pi-session:s1#e7" }, "agree", "talk", "--id", ID, "--by", "user", "--verification", "v", "--write");
  assert.equal(a.exit, 0, JSON.stringify(a));
  assert.equal(a.ids[0].agreed.source, "pi-session:s1#e7", "the output names the source");
  assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID].agreed.source, "pi-session:s1#e7", "the landed record carries it");
  const root2 = project();
  decided(root2, "talk");
  const b = runEnv(root2, {}, "agree", "talk", "--id", ID, "--by", "user", "--source", "review:r9", "--verification", "v");
  assert.equal(b.ids[0].agreed.source, "review:r9", "with no variable, --source is the source");
  for (const bad of ["", "a\nb", "x".repeat(201)]) assert.equal(run(root2, "agree", "talk", "--id", ID, "--by", "user", "--source", bad, "--verification", "v").exit, 2, JSON.stringify(bad));
});

test("an agreed this draft gave is kept only for the same person and source; another source restamps it", () => {
  const root = project();
  decided(root, "build", { code: ["src/list.js"] });
  const first = agree(root, "build", "--at", "2026-10-05T10:00Z").ids[0].agreed;
  assert.equal(agree(root, "build").ids[0].stamped, false, "same by and source: kept");
  const other = runEnv(root, {}, "agree", "build", "--id", ID, "--by", "user", "--source", "chat:c1#m8", "--verification", "v", "--write").ids[0];
  assert.equal(other.stamped, true);
  assert.equal(other.agreed.source, "chat:c1#m8");
  assert.notEqual(other.agreed.source, first.source);
});

test("promote refuses a new agreed with no source (agreed-unsourced) and keeps current's unsourced agreed as it is", () => {
  const root = project();
  decided(root, "hand", { authority: "accepted", agreed: { by: "user", at: "2026-10-05" } });
  assert.equal(run(root, "evidence", "hand", "--id", ID, "--by", "t", "--verification", "v", "--doc-only", "--write").exit, 0);
  const p = run(root, "promote", "hand", "--id", ID);
  assert.ok(codes(p).includes("agreed-unsourced"), JSON.stringify(p));
  // an older stamp current already has needs no source: a reworded build keeps it
  editManifest(root, MANIFEST, (m) => { m.claims[ID] = { kind: "behavior", authority: "accepted", requires: [], agreed: { by: "user", at: "2026-10-01" } }; });
  write(root, FILE, promise(SIXTY));
  git(root, "add", "-A"); git(root, "commit", "-qm", "legacy stamp");
  assert.equal(run(root, "new", "reword", "--write").exit, 0);
  write(root, D("reword", "claims/app/list.md"), promise("A session title shows at most 60 characters, followed by an ellipsis."));
  assert.equal(run(root, "evidence", "reword", "--id", ID, "--by", "t", "--verification", "v", "--doc-only", "--write").exit, 0);
  const q = run(root, "promote", "reword", "--id", ID);
  assert.ok(!codes(q).includes("agreed-unsourced"), JSON.stringify(q));
  assert.equal(q.exit, 0, JSON.stringify(q));
});

// The relay defect of 2026-10-19: a worker held the right reference in SPEC_AGREE_SOURCE and typed a description
// in --source instead. A set SPEC_AGREE_SOURCE is the source; --source may only repeat it; a description is never one.
const ENV_REF = "pi-session:s1#e7";
const agreeEnv = (root, env, ...more) => runEnv(root, env, "agree", "talk", "--id", ID, "--by", "user", "--verification", "v", ...more, "--write");
const unchanged = (root) => read(root, D("talk", "manifest.json")) + currentSpec(root);

test("SPEC_AGREE_SOURCE set: no --source, or the same reference, stamps with the env reference", () => {
  for (const more of [[], ["--source", ENV_REF]]) {
    const root = project();
    decided(root, "talk");
    const a = agreeEnv(root, { SPEC_AGREE_SOURCE: ENV_REF }, ...more);
    assert.equal(a.exit, 0, JSON.stringify(a));
    assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID].agreed.source, ENV_REF, `stamped with the env reference (${more.join(" ") || "no --source"})`);
  }
});

test("SPEC_AGREE_SOURCE set: a different --source is refused, says to omit it, and writes nothing", () => {
  for (const other of ["the user approved the plan in the lead's chat (al_2)", "pi-session:s1#e3"]) {
    const root = project();
    decided(root, "talk");
    const before = unchanged(root);
    const a = agreeEnv(root, { SPEC_AGREE_SOURCE: ENV_REF }, "--source", other);
    assert.equal(a.exit, 1, JSON.stringify(a));
    assert.deepEqual(codes(a), ["agree-source-mismatch"]);
    assert.match(JSON.stringify(a), /omit --source/, "the refusal says what to do");
    assert.ok(JSON.stringify(a).includes(ENV_REF), "and names the reference that will be used");
    assert.equal(unchanged(root), before, "nothing written, draft or current");
  }
});

test("no SPEC_AGREE_SOURCE: a description in --source is refused; a reference is accepted", () => {
  for (const description of ["user said yes in chat", "go-ahead given in alignment al_2", "al_2", "lead's chat, turn after the plan", "pi-session:s1", "pi-session:#e7"]) {
    const root = project();
    decided(root, "talk");
    const before = unchanged(root);
    const a = agreeEnv(root, {}, "--source", description);
    assert.equal(a.exit, 1, `${description}: ${JSON.stringify(a)}`);
    assert.deepEqual(codes(a), ["agree-source-not-reference"], description);
    assert.match(JSON.stringify(a), /reference/);
    assert.equal(unchanged(root), before, `nothing written for ${JSON.stringify(description)}`);
  }
  for (const ref of ["pi-session:01a1-5137#e9f2", "https://github.com/o/r/pull/7#issuecomment-12", "chat:c1#m3"]) {
    const root = project();
    decided(root, "talk");
    const a = agreeEnv(root, {}, "--source", ref);
    assert.equal(a.exit, 0, `${ref}: ${JSON.stringify(a)}`);
    assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID].agreed.source, ref);
  }
});

test("a description in SPEC_AGREE_SOURCE is no source either", () => {
  const root = project();
  decided(root, "talk");
  const before = unchanged(root);
  const a = agreeEnv(root, { SPEC_AGREE_SOURCE: "the user agreed earlier" });
  assert.equal(a.exit, 1, JSON.stringify(a));
  assert.deepEqual(codes(a), ["agree-source-not-reference"]);
  assert.equal(unchanged(root), before);
});

test("promote refuses a hand-written agreed whose source is a description, as agree does", () => {
  const root = project();
  decided(root, "hand", { authority: "accepted", agreed: { by: "user", at: "2026-10-05", source: "the user said yes" } });
  assert.equal(run(root, "evidence", "hand", "--id", ID, "--by", "t", "--verification", "v", "--doc-only", "--write").exit, 0);
  const p = run(root, "promote", "hand", "--id", ID);
  assert.ok(codes(p).includes("agreed-unsourced"), JSON.stringify(p));
});

// A pi-session reference must point back at a real user message: the session file under
// ${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions (by its name, else its header), and in it a message entry by the user.
test("a pi-session source that resolves to no user message is refused (agree-source-unresolved), from --source or the variable", () => {
  for (const [env, more, why] of [
    [{}, ["--source", "pi-session:nope#nope"], "no such session"],
    [{}, ["--source", "pi-session:s1#zz"], "no such entry"],
    [{}, ["--source", "pi-session:s1#a1"], "an assistant message"],
    [{}, ["--source", "pi-session:s1#c1"], "a custom entry"],
    [{ SPEC_AGREE_SOURCE: "pi-session:nope#nope" }, [], "the variable's"],
  ]) {
    const root = project();
    decided(root, "talk");
    const before = unchanged(root);
    const a = agreeEnv(root, env, ...more);
    assert.equal(a.exit, 1, `${why}: ${JSON.stringify(a)}`);
    assert.deepEqual(codes(a), ["agree-source-unresolved"], why);
    assert.match(JSON.stringify(a), /user message/, "the refusal says what it needs");
    assert.equal(unchanged(root), before, `nothing written (${why})`);
  }
});

test("a pi-session source resolves by file name or header, under PI_CODING_AGENT_DIR when it is set", () => {
  const root = project();
  decided(root, "talk");
  const other = join(root, "elsewhere");
  piSession(other, "2026-10-19T00-00-00-000Z_s9.jsonl", "s9", [["u1", "message", "user"]]);
  // the variable moves the sessions: s1 (under HOME) is not there
  assert.deepEqual(codes(agreeEnv(root, { PI_CODING_AGENT_DIR: other }, "--source", "pi-session:s1#e7")), ["agree-source-unresolved"]);
  const a = agreeEnv(root, { PI_CODING_AGENT_DIR: other }, "--source", "pi-session:s9#u1");
  assert.equal(a.exit, 0, JSON.stringify(a));
  const root2 = project();
  decided(root2, "talk");
  const b = agreeEnv(root2, {}, "--source", "pi-session:01a1-5137#e9f2");
  assert.equal(b.exit, 0, `found by its header: ${JSON.stringify(b)}`);
});

test("a worker (SPEC_AGREE_GIVEN set by the spawn path) given no reference refuses any --source; given one, it stamps that", () => {
  const root = project();
  decided(root, "talk");
  const before = unchanged(root);
  for (const ref of ["chat:c1#m3", "pi-session:s1#e7"]) {
    const a = agreeEnv(root, { SPEC_AGREE_GIVEN: "" }, "--source", ref);
    assert.equal(a.exit, 1, JSON.stringify(a));
    assert.deepEqual(codes(a), ["agree-source-not-given"], ref);
    assert.match(JSON.stringify(a), /report the records ready/);
  }
  assert.equal(unchanged(root), before);
  const b = agreeEnv(root, { SPEC_AGREE_GIVEN: ENV_REF, SPEC_AGREE_SOURCE: ENV_REF });
  assert.equal(b.exit, 0, JSON.stringify(b));
  assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID].agreed.source, ENV_REF);
});

test("promote refuses a hand-written pi-session source that resolves to no user message, and takes one that does", () => {
  const root = project();
  decided(root, "hand", { authority: "accepted", agreed: { by: "user", at: "2026-10-05", source: "pi-session:nope#nope" } });
  assert.equal(run(root, "evidence", "hand", "--id", ID, "--by", "t", "--verification", "v", "--doc-only", "--write").exit, 0);
  assert.ok(codes(run(root, "promote", "hand", "--id", ID)).includes("agreed-source-unresolved"));
  const root2 = project();
  decided(root2, "hand", { authority: "accepted", agreed: { by: "user", at: "2026-10-05", source: "pi-session:s1#e7" } });
  assert.equal(run(root2, "evidence", "hand", "--id", ID, "--by", "t", "--verification", "v", "--doc-only", "--write").exit, 0);
  const p = run(root2, "promote", "hand", "--id", ID);
  assert.equal(p.exit, 0, JSON.stringify(p));
});
