#!/usr/bin/env node
// Legacy spec/*.md -> redirect stubs. Migration mechanics only.
//   node redirects.mjs plan  [--out DIR]   write DIR/plan.json, DIR/stubs/spec/*.md and DIR.patch (default /tmp/sova-spec-redirects)
//   node redirects.mjs apply  --plan FILE  [--only spec/a.md,...]   replace legacy files with their stubs
// apply refuses a file whose live bytes differ from the captured "before" hash (concurrent drift),
// refuses a dirty/untracked file unless the legacy-working draft holds its captured variant, and
// runs verify.mjs first. It never touches spec/brainstorms/. Nothing else is written.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimFileOf } from "./migrate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const DRAFT = ".sova/spec/drafts/legacy-working";

function stub(e, h1) {
  const target = `.sova/spec/claims/${claimFileOf(e.id)}`;
  const draftNote = e.state === "untracked"
    ? `> This document was never committed. At migration time it became the proposal draft \`${DRAFT}/\`\n> (\`spec/claims/${claimFileOf(e.id)}\` there, labelled candidate). It is not current documentation.\n`
    : `> Moved. This document now lives at [${target}](../${target}) as \`${e.id}\`.\n` +
      (e.state === "modified" ? `> Uncommitted edits to this file at migration time are the proposal draft \`${DRAFT}/\`, not current.\n` : "");
  return `${h1}\n\n${draftNote}> Old headings and \`§N\` citations resolve through \`.sova/spec/migration/legacy-map.json\`; the exact\n> original bytes are kept under \`.sova/spec/migration/legacy/\`.\n`;
}

function plan(out) {
  const inv = JSON.parse(readFileSync(join(HERE, "inventory.json"), "utf8"));
  const files = [];
  let patch = "";
  for (const e of inv.files) {
    if (!e.worktreeSha256) continue;
    const live = readFileSync(join(ROOT, e.path));
    const h1 = live.toString("utf8").split("\n")[0];
    if (!h1.startsWith("# ")) throw new Error(`${e.path}: line 1 is not an H1`);
    const body = stub(e, h1);
    const stubPath = join(out, "stubs", e.path);
    mkdirSync(dirname(stubPath), { recursive: true });
    writeFileSync(stubPath, body);
    files.push({ path: e.path, state: e.state, before: e.worktreeSha256, after: sha(Buffer.from(body)), stub: `stubs/${e.path}`, liveMatchesCapture: sha(live) === e.worktreeSha256 });
    try { execFileSync("diff", ["-u", "--label", `a/${e.path}`, "--label", `b/${e.path}`, join(ROOT, e.path), stubPath]); }
    catch (err) { if (err.status !== 1) throw err; patch += err.stdout.toString(); }
  }
  writeFileSync(join(out, "plan.json"), JSON.stringify({ capturedHead: inv.head, capturedAt: inv.capturedAt, draft: DRAFT, files }, null, 2) + "\n");
  writeFileSync(`${out}.patch`, patch);
  const drifted = files.filter((f) => !f.liveMatchesCapture);
  console.log(`plan: ${files.length} stubs in ${out}; patch ${out}.patch${drifted.length ? `; DRIFT (recapture first): ${drifted.map((f) => f.path).join(", ")}` : ""}`);
  process.exit(drifted.length ? 1 : 0);
}

function apply(planFile) {
  const p = JSON.parse(readFileSync(planFile, "utf8"));
  const only = opt("--only") ? new Set(opt("--only").split(",")) : null;
  const todo = p.files.filter((f) => !only || only.has(f.path));
  try { execFileSync("node", [join(HERE, "verify.mjs"), "--live"], { stdio: "inherit" }); }
  catch { console.error("verify.mjs failed or live drift: nothing written"); process.exit(2); }
  const refused = [];
  for (const f of todo) {
    const live = existsSync(join(ROOT, f.path)) ? sha(readFileSync(join(ROOT, f.path))) : null;
    if (live !== f.before) refused.push(`${f.path}: live bytes changed since capture`);
    if (f.state !== "clean" && !existsSync(join(ROOT, DRAFT, "draft.json"))) refused.push(`${f.path}: ${f.state}, but ${DRAFT} does not exist yet`);
    if (sha(readFileSync(join(dirname(planFile), f.stub))) !== f.after) refused.push(`${f.path}: stub changed since planning`);
  }
  if (refused.length) { for (const r of refused) console.error(`refused ${r}`); console.error("nothing written"); process.exit(2); }
  for (const f of todo) writeFileSync(join(ROOT, f.path), readFileSync(join(dirname(planFile), f.stub)));
  console.log(`applied ${todo.length} redirect stubs`);
}

const [cmd] = args;
if (cmd === "plan") plan(resolve(opt("--out", "/tmp/sova-spec-redirects")));
else if (cmd === "apply" && opt("--plan")) apply(resolve(opt("--plan")));
else { console.error("usage: redirects.mjs plan [--out DIR] | apply --plan FILE [--only spec/a.md,...]"); process.exit(2); }
