#!/usr/bin/env node
// Legacy spec/*.md -> .sova/spec documentation. Migration mechanics only, not a product tool.
//   node migrate.mjs capture            copy HEAD and worktree bytes of spec/*.md into legacy/, write inventory.json
//   node migrate.mjs build --out DIR    write DIR/current/{manifest.json,claims/**}, DIR/draft/{...}, DIR/legacy-map.json
// Build reads only the captured bytes under legacy/, so it is reproducible. It never writes spec/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { headings, slug, forward } from "./transform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
const json = (o) => JSON.stringify(o, null, 2) + "\n";
const put = (p, b) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, b); };

// Legacy file -> claim ID of its H1, and the doc kind. Namespaces carry no digits.
export const FILES = {
  "00-ground-rules.md": ["§design/ground-rules", "note"],
  "01-app-shell.md": ["§app/shell", "surface"],
  "02-session-list.md": ["§app/session-list", "surface"],
  "03-transcript.md": ["§chat/transcript", "surface"],
  "04-composer.md": ["§chat/composer", "surface"],
  "04b-images.md": ["§chat/images", "surface"],
  "04c-model-menu.md": ["§chat/model-menu", "surface"],
  "04d-slash-commands.md": ["§chat/slash-commands", "surface"],
  "04e-markdown.md": ["§chat/markdown", "surface"],
  "04f-context-window.md": ["§chat/context-window", "surface"],
  "04g-mode-menu.md": ["§chat/mode-menu", "surface"],
  "04i-playbooks.md": ["§chat/playbooks", "surface"],
  "05-new-session-dialog.md": ["§app/new-session-dialog", "surface"],
  "06-extension-dialogs.md": ["§app/extension-dialogs", "surface"],
  "07-deviations.md": ["§design/deviations", "note"],
  "08-token-index.md": ["§design/token-index", "note"],
  "09-copy-deck.md": ["§design/copy-deck", "note"],
  "10-insights.md": ["§app/insights", "surface"],
  "11-subagents-pane.md": ["§app/subagents-pane", "surface"],
  "12-settings-dialog.md": ["§app/settings-dialog", "surface"],
  "13-timeline.md": ["§chat/timeline", "surface"],
  "14-workspaces.md": ["§workspace/groups", "surface"],
  "14b-fanout.md": ["§workspace/fanout", "surface"],
  "overview.md": ["§design/overview", "note"],
};
// Legacy "§N" citations (overview: "point at the file whose number matches").
export const SECTION_NUMBERS = {
  "§0": "00-ground-rules.md", "§1": "01-app-shell.md", "§2": "02-session-list.md", "§3": "03-transcript.md",
  "§4": "04-composer.md", "§4b": "04b-images.md", "§4c": "04c-model-menu.md", "§4d": "04d-slash-commands.md",
  "§4e": "04e-markdown.md", "§4f": "04f-context-window.md", "§4g": "04g-mode-menu.md", "§4i": "04i-playbooks.md",
  "§5": "05-new-session-dialog.md", "§6": "06-extension-dialogs.md", "§7": "07-deviations.md", "§8": "08-token-index.md",
  "§9": "09-copy-deck.md", "§10": "10-insights.md", "§11": "11-subagents-pane.md", "§12": "12-settings-dialog.md",
  "§13": "13-timeline.md", "§14": "14-workspaces.md", "§14b": "14b-fanout.md",
};
// Zero-padded spellings seen in prose and code (§03, §05, §09, §04h) resolve like the plain ones.
export const SECTION_ALIASES = { "§00": "§0", "§01": "§1", "§02": "§2", "§03": "§3", "§04": "§4", "§05": "§5",
  "§06": "§6", "§07": "§7", "§08": "§8", "§09": "§9", "§04b": "§4b", "§04c": "§4c", "§04d": "§4d", "§04e": "§4e",
  "§04f": "§4f", "§04g": "§4g", "§04h": "§4h", "§04i": "§4i", "§copy-deck": "§9" };
// Cited but never present in the tree or its history: resolved to "absent", never invented.
export const ABSENT = { "§4h": "spec/04h-file-mentions.md (Session info / file mentions) is absent from the tree and from Git history" };
// Readability overrides for long heading slugs, keyed "file\theading text".
const SLUG_OVERRIDES = {
  "04f-context-window.md\tHonesty: what the row's number is, and isn't": "honesty",
  "04f-context-window.md\tThe sidebar ring: a deliberate exception": "sidebar-ring",
  "04f-context-window.md\tWidth budget: what collapses first": "width-budget",
};
// H2 headings that are rationale or reference lists rather than behavior.
const NOTE_H2 = new Set(["rejected", "decisions", "open-questions", "tokens", "classes", "class-table", "class-index", "file-map"]);
const LABELS = { authority: "migrated", evidence: "unreviewed" };
// Explicit semantic dependencies, authored after parity. Each source passage was read in full; each
// edge quotes the migrated prose that makes the target something the source relies on (the quote is
// matched with whitespace collapsed). A §N citation or link alone is a reference, never an edge.
// Every other behavior keeps no `requires`: uninvestigated.
export const EDGES = {
  "§app.session-list/content-rules": [
    ["§chat.composer/behavior", "a husk with a stored draft is** (§4 Drafts)"],
    ["§chat.context-window/sidebar-ring", "the same `contextStep` the head's gauge uses, so a row and the session it opens step together"],
    ["§app.shell/remote-session-chips", "the same reading as the head chip (spec/01 \"Remote session chips\")"],
  ],
  "§chat.composer/behavior": [
    ["§chat.images/composer-attachments", "Each is a file already uploaded into the session's attachments folder (§4b)"],
  ],
  "§chat.images/composer-attachments": [
    ["§chat.composer/composer-flyout", "The flyout's **Attach images** row (§4 \"Composer flyout\") closes the flyout"],
    ["§chat.images/lightbox", "opens the lightbox on just that image"],
    ["§chat.composer/behavior", "Drafts keep their attachments per session, durably"],
    ["§design.copy-deck/images", "change the numbers here and in the copy deck together"],
  ],
  "§chat.model-menu/menu": [
    ["§chat.composer/composer-flyout", "The flyout owns the popover; this panel is what's inside it"],
  ],
  "§chat.timeline/rewind": [
    ["§chat.transcript/message-actions", "sends the identical `rewind` request over the same socket, with the same two-step confirm and the same refusals"],
  ],
  "§workspace.groups/the-group-composer": [
    ["§workspace.groups/member-states", "`code` is the closed set the state table above names"],
    ["§design.copy-deck/workspace", "**The banner is composed from `code` and the member's own name** (§9)"],
    ["§chat.composer/behavior", "the same optimistic rule §4 gives"],
    ["§chat.composer/anatomy", "Expanded (the §4 composer)"],
    ["§design.ground-rules/color-budget", "§0 allows one accent button in view"],
    ["§design.ground-rules/voice", "the three beats §0 requires"],
  ],
  "§workspace.groups/a-pane": [
    ["§chat/transcript", "Nothing about the transcript, the composer, the model menu or the mode menu changes inside a pane — §3, §4 and their sub-sections apply verbatim"],
    ["§chat/composer", "Nothing about the transcript, the composer, the model menu or the mode menu changes inside a pane — §3, §4 and their sub-sections apply verbatim"],
    ["§chat/model-menu", "Nothing about the transcript, the composer, the model menu or the mode menu changes inside a pane — §3, §4 and their sub-sections apply verbatim"],
    ["§chat/mode-menu", "Nothing about the transcript, the composer, the model menu or the mode menu changes inside a pane — §3, §4 and their sub-sections apply verbatim"],
  ],
  "§app.settings-dialog/modes": [
    ["§app.settings-dialog/models", "A model Settings → Models keeps from subagents reads \"— off for subagents\""],
  ],
};

export function claimFileOf(id) { const [ns, name] = id.slice(1).split("/"); return `${ns}/${name}.md`; }
export const fileMap = () => Object.fromEntries(Object.entries(FILES).map(([f, [id]]) => [f, claimFileOf(id)]));

// IDs for one legacy file: Map(lineIndex -> id) and heading records. Collisions get -b, -c ... (no digits).
export function assignIds(file, text, reserved = new Set()) {
  const [h1id, docKind] = FILES[file];
  const [ns, name] = h1id.slice(1).split("/");
  const lines = text.split("\n");
  const ids = new Map(), recs = [];
  const used = new Set();
  let sawH1 = false;
  for (const h of headings(lines)) {
    if (h.level > 2) continue;
    if (h.level === 1) {
      if (sawH1 || h.i !== 0) throw new Error(`${file}:${h.i + 1}: only one H1, on line 1, is supported`);
      sawH1 = true; ids.set(h.i, h1id); recs.push({ id: h1id, kind: docKind, line: h.i + 1, heading: h.text }); continue;
    }
    let s = SLUG_OVERRIDES[`${file}\t${h.text}`] ?? slug(h.text);
    if (!s) throw new Error(`${file}:${h.i + 1}: heading has no letters`);
    let id = `§${ns}.${name}/${s}`;
    for (let k = 1; used.has(id) || reserved.has(id); k++) id = `§${ns}.${name}/${s}-${String.fromCharCode(97 + k)}`;
    used.add(id); ids.set(h.i, id);
    recs.push({ id, kind: docKind === "note" || NOTE_H2.has(s) ? "note" : "behavior", line: h.i + 1, heading: h.text });
  }
  if (!sawH1) throw new Error(`${file}: no H1`);
  return { ids, recs };
}

function capture() {
  if (existsSync(join(HERE, "inventory.json"))) throw new Error("already captured: inventory.json exists. Keep it; move it aside deliberately to recapture.");
  const head = git("rev-parse", "HEAD").toString().trim();
  const at = new Date().toISOString();
  const status = git("status", "--porcelain=v1", "--untracked-files=all", "--", "spec").toString();
  const present = readdirSync(join(ROOT, "spec")).filter((f) => f.endsWith(".md") && lstatSync(join(ROOT, "spec", f)).isFile()).sort();
  const unknown = present.filter((f) => !FILES[f]);
  if (unknown.length) throw new Error(`unmapped legacy files: ${unknown.join(", ")}`);
  const entries = [];
  for (const f of Object.keys(FILES)) {
    const rel = `spec/${f}`;
    const e = { path: rel, id: FILES[f][0], kind: FILES[f][1] };
    let hb = null;
    try { hb = git("show", `${head}:${rel}`); e.headBlob = git("rev-parse", `${head}:${rel}`).toString().trim(); } catch { /* not in HEAD */ }
    const wp = join(ROOT, rel);
    const wb = existsSync(wp) ? readFileSync(wp) : null;
    if (hb) { e.headSha256 = sha(hb); e.headBytes = hb.length; put(join(HERE, "legacy/head", rel), hb); }
    if (wb) { e.worktreeSha256 = sha(wb); e.worktreeBytes = wb.length; e.worktreeBlob = git("hash-object", "--", rel).toString().trim(); }
    e.state = !hb ? (wb ? "untracked" : "absent") : !wb ? "deleted" : sha(hb) === sha(wb) ? "clean" : "modified";
    if (wb && e.state !== "clean") put(join(HERE, "legacy/worktree", rel), wb);
    e.retained = { ...(hb ? { head: `migration/legacy/head/${rel}` } : {}), ...(wb && e.state !== "clean" ? { worktree: `migration/legacy/worktree/${rel}` } : {}) };
    entries.push(e);
  }
  put(join(HERE, "inventory.json"), json({
    _: "Exact legacy spec/*.md bytes captured before migration. Current docs are built from HEAD bytes; modified/untracked worktree bytes build the legacy-working draft. Hashes are SHA-256 of the file bytes; blobs are Git object ids.",
    capturedAt: at, head, gitStatus: status.split("\n").filter(Boolean), excluded: "spec/brainstorms/** (research, not product documentation)", files: entries,
  }));
  console.log(`captured ${entries.length} files at ${head.slice(0, 12)}: ${entries.map((e) => `${e.path.slice(5)}=${e.state}`).filter((s) => !s.endsWith("=clean")).join(", ")}`);
}

function buildVariant(variant, inv, reserved) {
  const fm = fileMap();
  const manifestClaims = {};
  const files = {}, map = {};
  for (const e of inv.files) {
    const src = variant === "current" ? e.retained.head : e.retained.worktree ?? e.retained.head;
    if (!src) continue; // untracked docs exist only in the draft
    if (variant === "draft" && e.state === "deleted") continue;
    const text = readFileSync(join(HERE, "..", src), "utf8");
    if (sha(Buffer.from(text, "utf8")) !== (variant === "current" || !e.retained.worktree ? e.headSha256 : e.worktreeSha256)) throw new Error(`${src} does not match inventory`);
    const legacyName = e.path.slice(5);
    const { ids, recs } = assignIds(legacyName, text, reserved);
    const claimFile = claimFileOf(e.id);
    const { text: out, links } = forward(text, { claimFile, ids, fileMap: fm });
    files[claimFile] = out;
    for (const r of recs) manifestClaims[r.id] = { kind: r.kind, ...(EDGES[r.id] ? { requires: [...new Set(EDGES[r.id].map(([t]) => t))].sort() } : {}), ...LABELS };
    map[e.path] = { source: src, sourceSha256: sha(Buffer.from(text, "utf8")), claimFile: `claims/${claimFile}`, claimSha256: sha(Buffer.from(out, "utf8")),
      headings: recs.map((r) => ({ line: r.line, heading: r.heading, id: r.id, kind: r.kind })), links };
  }
  const sorted = Object.fromEntries(Object.keys(manifestClaims).sort().map((k) => [k, manifestClaims[k]]));
  const manifest = {
    formatVersion: 1,
    _: `Sova's product documentation, migrated from the legacy spec/*.md at ${inv.head.slice(0, 12)}. Migration moved requirement authority, not proof of implementation: a migrated record is authority 'migrated', evidence 'unreviewed'. A behavior without \`requires\` has uninvestigated dependencies; cross-document links and legacy §N citations in the prose are ordinary references, not dependencies. Legacy paths, headings and §N resolve through migration/legacy-map.json.`,
    grammar: { claimsRoot: "claims/", directoryKinds: ["section"] },
    claims: sorted,
  };
  return { manifest, files, map };
}

// id -> passage text (H1 lede to the first H2; H2 to the next H1/H2), per claims tree.
function spans(files) {
  const m = new Map();
  for (const text of Object.values(files)) {
    const lines = text.split("\n");
    const hs = headings(lines).filter((h) => h.level <= 2);
    hs.forEach((h, k) => m.set(h.text.split(" ")[0], lines.slice(h.i, hs[k + 1]?.i ?? lines.length).join("\n")));
  }
  return m;
}

// The migration output, rebuilt from the captured bytes. retiredIds may never name a new heading.
// withDraft false builds current only (the worktree variants are local-only and may be absent).
export function buildVariants(inv, retiredIds, withDraft = true) {
  const cur = buildVariant("current", inv, retiredIds);
  if (!withDraft) return { cur };
  const draft = buildVariant("draft", inv, retiredIds);
  // A draft record whose passage is new or differs from current is a proposal, not migrated authority.
  const curSpans = spans(cur.files), draftSpans = spans(draft.files);
  for (const [id, rec] of Object.entries(draft.manifest.claims)) if (curSpans.get(id) !== draftSpans.get(id)) rec.authority = "candidate";
  return { cur, draft };
}

function build(out) {
  const inv = JSON.parse(readFileSync(join(HERE, "inventory.json"), "utf8"));
  const pilot = JSON.parse(readFileSync(join(HERE, "pilot/manifest.json"), "utf8"));
  const cur0 = buildVariant("current", inv, new Set());
  // Retired pilot IDs may never be reused for a new heading.
  const retiredIds = new Set(Object.keys(pilot.claims).filter((id) => !cur0.manifest.claims[id]));
  const { cur, draft } = buildVariants(inv, retiredIds);
  for (const [name, v] of [["current", cur], ["draft", draft]]) {
    put(join(out, name, "manifest.json"), json(v.manifest));
    for (const [f, t] of Object.entries(v.files)) put(join(out, name, "claims", f), t);
  }
  // §N resolution, per variant (§4i exists only in the draft).
  const sections = {};
  for (const [n, f] of Object.entries(SECTION_NUMBERS)) sections[n] = { legacy: `spec/${f}`, id: FILES[f][0], current: cur.map[`spec/${f}`] ? `claims/${claimFileOf(FILES[f][0])}` : null, draft: `claims/${claimFileOf(FILES[f][0])}` };
  for (const [n, why] of Object.entries(ABSENT)) sections[n] = { absent: why };
  // Pilot IDs: a root that keeps its meaning stays; the rest are retired with the headings that now carry their legacy prose.
  const pilotIds = {};
  for (const [id, rec] of Object.entries(pilot.claims)) {
    if (cur.manifest.claims[id]) { pilotIds[id] = { status: "retained", meaning: "same surface; the pilot's candidate lede is archived, the migrated legacy text is current", archived: "migration/pilot/" }; continue; }
    const succ = new Set();
    for (const inc of rec.incumbent ?? []) {
      const hs = cur.map[inc.file].headings;
      for (let k = 0; k < hs.length; k++) {
        const end = (hs[k + 1]?.line ?? Infinity) - 1;
        if (hs[k].line <= inc.lines[1] && inc.lines[0] <= end) succ.add(hs[k].id);
      }
    }
    pilotIds[id] = { status: "retired", successors: [...succ].sort(), ...(succ.size ? {} : { why: rec.kind === "section" ? "pilot section over pilot claims; no legacy prose" : "no legacy prose; candidate text only" }), archived: "migration/pilot/", reuse: "never" };
  }
  put(join(out, "legacy-map.json"), json({
    _: "How legacy spec paths, headings and §N citations resolve after migration. Successors of retired pilot IDs are the migrated headings holding the legacy prose the candidate was drawn from; that is a location, not an equivalence. Links are rewritten only between migrated files.",
    transform: "Each H1/H2 outside fences gains '§id — ' after its marker; relative links to legacy spec files point at the claims file. Nothing else changes. See transform.mjs; verify.mjs inverts it.",
    head: inv.head, sections, aliases: SECTION_ALIASES, files: { current: cur.map, draft: draft.map }, pilotIds,
    dependencies: Object.fromEntries(Object.entries(EDGES).map(([id, es]) => [id, es.map(([to, quote]) => ({ to, quote }))])),
  }));
  const count = (v) => Object.values(v.manifest.claims).reduce((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {});
  console.log(`current: ${Object.keys(cur.files).length} files ${JSON.stringify(count(cur))}; draft: ${Object.keys(draft.files).length} files ${JSON.stringify(count(draft))}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "capture") capture();
  else if (cmd === "build" && rest[0] === "--out" && rest[1]) build(resolve(rest[1]));
  else { console.error("usage: migrate.mjs capture | build --out DIR"); process.exit(2); }
}
