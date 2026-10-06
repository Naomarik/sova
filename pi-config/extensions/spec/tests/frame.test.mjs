// Optional record fields embeds, core and about: check validates them, packet/toc/read honour them, the
// frame is its own stream under a visible 12,000-byte cap, and a spec without them reads exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../core/sova-spec.mjs");
const roots = [];
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function write(root, path, text) { const abs = join(root, path); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }

const FILES = {
  "s/seed.md": "# §s/seed — Editor\n\nThe editor pane, where a draft is written.\n\n## §s.seed/edit — Editing\n\nEditing saves the draft when the writer pauses, as §s.dep/rule allows. The toolbar is drawn inside the editor as §s/panel.\n\n## §s.seed/limits — Limits\n\nA draft holds at most 200 lines.\n",
  "s/dep.md": "# §s/dep — Saving\n\nWhen drafts may be written.\n\n## §s.dep/rule — Save rule\n\nA save runs only when no other save is in flight.\n",
  "s/panel.md": "# §s/panel — Toolbar\n\nThe formatting toolbar, drawn inside a host surface.\n\n## §s.panel/bold — Bold\n\nBold wraps the selection in stars.\n\n## §s.panel/link — Link\n\nLink asks for an address.\n",
  "design/rules.md": "# §design/rules — Ground rules\n\nRules every surface follows.\n\n## §design.rules/voice — Voice\n\nEvery message says what happened and what to do next.\n\n## §design.rules/theme — Theme\n\nReference colours, reached through their area.\n",
  "design/copy.md": "# §design/copy — Copy deck\n\nThe exact words surfaces show.\n\n## §design.copy/editor — Editor copy\n\nThe save hint reads \"Saved\"; the copy for §s/seed lives here.\n\n## §design.copy/edit-only — Edit copy\n\nThe pause hint reads \"Paused\".\n",
};
const CLAIMS = {
  "§s/seed": { kind: "surface" },
  "§s.seed/edit": { kind: "behavior", requires: ["§s.dep/rule"], embeds: ["§s/panel"] },
  "§s.seed/limits": { kind: "behavior", requires: [] },
  "§s/dep": { kind: "surface" },
  "§s.dep/rule": { kind: "behavior", requires: [] },
  "§s/panel": { kind: "surface" },
  "§s.panel/bold": { kind: "behavior", requires: [] },
  "§s.panel/link": { kind: "behavior", requires: [] },
  "§design/rules": { kind: "note", core: true },
  "§design.rules/voice": { kind: "note", core: true },
  "§design.rules/theme": { kind: "note", core: false },
  "§design/copy": { kind: "note" },
  "§design.copy/editor": { kind: "note", about: ["§s/seed"] },
  "§design.copy/edit-only": { kind: "note", about: ["§s.seed/edit"] },
};
// Strip the three fields: the same spec as a project that never used them.
const plain = (claims) => Object.fromEntries(Object.entries(claims).map(([id, { embeds, core, about, ...r }]) => [id, r]));

function fixture(claims = CLAIMS, files = FILES) {
  const root = mkdtempSync(join(tmpdir(), "spec-frame-")); roots.push(root);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims }));
  for (const [p, t] of Object.entries(files)) write(root, `.sova/spec/claims/${p}`, t);
  return root;
}
function run(root, args, core = CORE) {
  const r = spawnSync(process.execPath, [core, ...args, "--root", root], { cwd: root, encoding: "utf8" });
  assert.equal(r.error, undefined);
  return r;
}
const json = (root, args, core) => { const r = run(root, [...args, "--json"], core); const j = JSON.parse(r.stdout); assert.equal(r.status, j.exit); return j; };
function stream(root, args) {
  const items = [];
  let j = json(root, args), pages = [j];
  items.push(...j.items);
  while (j.next) { j = json(root, [...args, "--cursor", j.next]); pages.push(j); items.push(...j.items); }
  const texts = new Map();
  for (const it of items) texts.set(it.id, (texts.get(it.id) ?? "") + (it.text ?? ""));
  return { items, texts, pages };
}
const sha = (t) => createHash("sha256").update(t).digest("hex");

test("check accepts the fields and validates their targets and shapes", () => {
  const ok = json(fixture(), ["check"]);
  assert.equal(ok.exit, 0, JSON.stringify(ok.findings));
  const warn = json(fixture({ ...CLAIMS, "§s.seed/edit": { ...CLAIMS["§s.seed/edit"], embeds: ["§s.dep/rule", "§s/none"] },
    "§design.copy/editor": { kind: "note", about: ["§design/rules", "§s/gone"] } }), ["check"]);
  const codes = warn.findings.map((f) => `${f.code} ${f.message}`);
  assert.ok(codes.some((c) => c.startsWith("embeds-not-surface") && c.includes("§s.dep/rule")), codes.join("\n"));
  assert.ok(codes.some((c) => c.startsWith("dangling-edge") && c.includes("embeds §s/none")));
  assert.ok(codes.some((c) => c.startsWith("about-wrong-kind") && c.includes("§design/rules")));
  assert.ok(codes.some((c) => c.startsWith("dangling-edge") && c.includes("about §s/gone")));
  assert.equal(warn.exit, 1);
  for (const [bad, code] of [[{ embeds: "§s/panel" }, "record-invalid"], [{ embeds: ["panel"] }, "id-invalid"], [{ core: "yes" }, "record-invalid"]]) {
    const j = json(fixture({ ...CLAIMS, "§s.seed/limits": { kind: "behavior", requires: [], ...bad } }), ["check"]);
    assert.equal(j.exit, 2, JSON.stringify(bad));
    assert.ok(j.findings.some((f) => f.code === code && f.id === "§s.seed/limits"), JSON.stringify(j.findings));
  }
});

test("about on a record that is not a note is a warning, never an untrusted graph", () => {
  const root = fixture({ ...CLAIMS, "§s.seed/limits": { kind: "behavior", requires: [], about: ["§s/seed"] } });
  const j = json(root, ["check"]);
  assert.equal(j.exit, 1);
  assert.ok(j.findings.some((f) => f.code === "about-not-note" && f.id === "§s.seed/limits" && f.severity === "warn"));
  assert.notEqual(json(root, ["read", "§s.seed/edit"]).exit, 2);
});

test("packet: embeds is followed whole, about notes travel, the frame is its own named stream", () => {
  const root = fixture();
  const { items, texts, pages } = stream(root, ["packet", "§s.seed/edit"]);
  for (const id of ["§s/panel", "§s.panel/bold", "§s.panel/link", "§design.copy/editor", "§design.copy/edit-only"]) assert.ok(texts.has(id), id);
  for (const id of ["§design.rules/voice", "§design/rules"]) assert.ok(!texts.has(id), `${id} never inside the prose stream`);
  const inv = stream(root, ["packet", "§s.seed/edit", "--part", "inventory"]).items.map((i) => i.value);
  assert.deepEqual(inv.find((p) => p.id === "§s/panel").reasons, [{ reason: "embeds", of: "§s.seed/edit" }]);
  assert.deepEqual(inv.find((p) => p.id === "§design.copy/editor").reasons, [{ reason: "about", of: "§s/seed" }]);
  assert.deepEqual(inv.find((p) => p.id === "§design.copy/edit-only").reasons, [{ reason: "about", of: "§s.seed/edit" }]);
  const frameText = ["§design/rules", "§design.rules/voice"];
  const bytes = frameText.reduce((n, id) => n + Buffer.byteLength(stream(root, ["read", id]).texts.get(id)), 0);
  for (const p of pages) assert.deepEqual(p.frame, { passages: 2, bytes, cap: 12000, overCap: false });
  assert.equal(pages[0].counts.frame, 2);
  const frame = stream(root, ["packet", "§s.seed/edit", "--part", "frame"]);
  assert.deepEqual([...frame.texts.keys()], frameText, "file and line order; core: false is out");
  assert.equal(frame.items.reduce((n, i) => n + Buffer.byteLength(i.text), 0), bytes);
  assert.ok(items.every((i) => i.text !== undefined));
});

test("packet: the notes about any claim it delivers travel with it, once each, naming every delivered claim they serve", () => {
  const files = { ...FILES, "design/copy.md": FILES["design/copy.md"] + "\n## §design.copy/save-copy — Save copy\n\nThe busy hint reads \"Saving…\".\n\n## §design.copy/stray — Stray copy\n\nCopy for a claim this packet never reaches.\n" };
  const claims = { ...CLAIMS, "§design.copy/save-copy": { kind: "note", about: ["§s.dep/rule", "§s.seed/limits"] }, "§design.copy/stray": { kind: "note", about: ["§s.panel/link"] } };
  const root = fixture(claims, files);
  // The H1 seed delivers its H2s, so the note about §s.seed/edit and the note about a dependency's H2 come too.
  const inv = stream(root, ["packet", "§s/seed", "--part", "inventory"]).items.map((i) => i.value);
  const ids = inv.map((p) => p.id);
  for (const id of ["§design.copy/editor", "§design.copy/edit-only", "§design.copy/save-copy", "§design.copy/stray"]) assert.equal(ids.filter((x) => x === id).length, 1, id);
  assert.deepEqual(inv.find((p) => p.id === "§design.copy/save-copy").reasons, [{ reason: "about", of: "§s.dep/rule" }, { reason: "about", of: "§s.seed/limits" }]);
  assert.deepEqual(inv.find((p) => p.id === "§design.copy/stray").reasons, [{ reason: "about", of: "§s.panel/link" }], "reached through the embedded panel");
  const notes = ids.slice(ids.indexOf("§design.copy/edit-only"));
  assert.deepEqual(notes, ["§design.copy/edit-only", "§design.copy/editor", "§design.copy/save-copy", "§design.copy/stray"], "after the closure, in note id order");
  // An H2 seed: notes about claims outside its closure stay out, a sibling H2 it does not deliver included.
  const limits = stream(root, ["packet", "§s.seed/limits", "--part", "inventory"]).items.map((i) => i.value.id);
  assert.ok(limits.includes("§design.copy/save-copy") && limits.includes("§design.copy/editor"));
  assert.ok(!limits.includes("§s.seed/edit"), "the sibling H2 is not delivered");
  assert.ok(!limits.includes("§design.copy/edit-only"), `a note about an undelivered sibling H2 is not carried: ${limits.join(" ")}`);
  assert.ok(!limits.includes("§design.copy/stray"), limits.join(" "));
});

test("toc: an about note whose own text names nothing takes the requested claim's sentence naming it as its why", () => {
  const files = { ...FILES, "s/seed.md": FILES["s/seed.md"].replace("A draft holds at most 200 lines.", "A draft holds at most 200 lines. The words it shows are in §design.copy/edit-only, the inventory.") };
  const claims = { ...CLAIMS, "§design.copy/edit-only": { kind: "note", about: ["§s.seed/limits"] } };
  const root = fixture(claims, files);
  const out = json(root, ["toc", "§s.seed/limits", "--dir", "out"]).lines.find((l) => l.id === "§design.copy/edit-only");
  assert.equal(out.group, "about");
  assert.deepEqual([out.why, out.whySource], ["The words it shows are in §design.copy/edit-only, the inventory.", "prose"]);
  const into = json(root, ["toc", "§s.seed/limits", "--dir", "in"]).lines.find((l) => l.id === "§design.copy/edit-only");
  assert.deepEqual([into.why, into.whySource], ["The words it shows are in §design.copy/edit-only, the inventory.", "prose"]);
  // A note that names its target keeps its own sentence; one named by nobody keeps the declared field.
  const editor = json(root, ["toc", "§s/seed", "--dir", "out"]).lines.find((l) => l.id === "§design.copy/editor");
  assert.equal(editor.whySource, "prose");
  assert.match(editor.why, /the copy for §s\/seed lives here/);
  const plainSeed = json(fixture(), ["toc", "§s.seed/edit", "--dir", "out"]).lines.find((l) => l.id === "§design.copy/edit-only");
  assert.deepEqual([plainSeed.why, plainSeed.whySource], ["about §s.seed/edit (declared on the note)", "declared"]);
});

test("a spec without the fields: packet, scope, toc and read outputs carry no frame and no new reasons", () => {
  const withF = fixture(), without = fixture(plain(CLAIMS));
  const j = json(without, ["packet", "§s.seed/edit"]);
  assert.equal(j.frame, undefined);
  assert.deepEqual(Object.keys(j.counts), ["prose", "inventory", "frontier", "code", "findings"]);
  const empty = json(without, ["packet", "§s.seed/edit", "--part", "frame"]);
  assert.equal(empty.status, "done"); assert.deepEqual(empty.items, []); assert.equal(empty.counts.frame, 0);
  assert.equal(json(without, ["toc", "§s.seed/edit", "--dir", "out"]).frame, undefined);
  assert.equal(json(without, ["read", "§s.seed/edit"]).frame, undefined);
  assert.ok(!run(without, ["toc", "§s.seed/edit", "--dir", "out"]).stdout.includes("frame:"));
  assert.ok(run(withF, ["toc", "§s.seed/edit", "--dir", "out"]).stdout.includes("frame: 2 passage(s)"));
  const s = json(without, ["scope", "§s.seed/edit"]);
  assert.ok(!s.passages.some((p) => p.reasons.some((r) => r.reason === "embeds" || r.reason === "about")));
});

test("toc lists embeds, about notes (directly and through the H1) and embedded-by, never twice", () => {
  const root = fixture();
  const out = json(root, ["toc", "§s.seed/edit", "--dir", "out"]);
  const g = (group) => out.lines.filter((l) => l.group === group).map((l) => l.id);
  assert.deepEqual(g("requires"), ["§s.dep/rule"]);
  assert.deepEqual(g("embeds"), ["§s/panel"]);
  assert.deepEqual(g("about"), ["§design.copy/edit-only", "§design.copy/editor"]);
  assert.deepEqual(g("named"), []);
  const viaH1 = out.lines.find((l) => l.id === "§design.copy/editor");
  assert.equal(viaH1.via, "§s/seed");
  assert.equal(viaH1.whySource, "prose");
  assert.equal(out.lines.find((l) => l.id === "§design.copy/edit-only").whySource, "declared", "the about field is the written reason");
  assert.equal(out.frame.passages, 2);
  const inn = json(root, ["toc", "§s/panel", "--dir", "in"]);
  assert.deepEqual(inn.lines.map((l) => [l.id, l.group]), [["§s.seed/edit", "embedded-by"]]);
  const text = run(root, ["toc", "§s.seed/edit", "--dir", "out"]).stdout;
  assert.match(text, /OUT: embeds \(drawn inside it; read delivers them whole\) \(1\)/);
  assert.match(text, /§design\.copy\/editor — Editor copy .* about its H1 §s\/seed/);
});

test("read delivers the seed and what it embeds, whole; names the notes about it; read --frame reads the frame", () => {
  const root = fixture();
  const r = stream(root, ["read", "§s.seed/edit"]);
  assert.deepEqual([...r.texts.keys()], ["§s.seed/edit", "§s/panel", "§s.panel/bold", "§s.panel/link"]);
  const decls = json(root, ["check"]).declarations;
  for (const [id, t] of r.texts) assert.equal(decls.find((d) => d.id === id).textSha256, sha(t), `${id} byte-exact`);
  assert.deepEqual(r.items.slice(1).map((i) => i.embeddedIn), ["§s.seed/edit", "§s.seed/edit", "§s.seed/edit"]);
  const last = r.pages.at(-1);
  assert.deepEqual(last.footer.about, ["§design.copy/edit-only", "§design.copy/editor"]);
  assert.ok(!last.footer.named.includes("§s/panel"), "an embedded surface is delivered, not merely named");
  const summary = json(root, ["packet", "§s.seed/edit"]).frame;
  // The first page carries the frame, outside the page budget; --no-frame and continuations carry only its summary.
  const { items: frameItems, ...rest } = r.pages[0].frame;
  assert.deepEqual(rest, summary);
  assert.deepEqual(frameItems.map((i) => i.id), ["§design/rules", "§design.rules/voice"]);
  for (const i of frameItems) assert.equal(decls.find((d) => d.id === i.id).textSha256, sha(i.text));
  assert.deepEqual(json(root, ["read", "§s.seed/edit", "--no-frame"]).frame, summary);
  const small = stream(root, ["read", "§s.seed/edit", "--budget", "1024"]);
  assert.ok(small.pages.length > 1);
  assert.ok(small.pages[0].frame.items, "outside the budget: a 1,024-byte first page still carries it");
  for (const pg of small.pages.slice(1)) assert.deepEqual(pg.frame, summary, "never on a continuation");
  assert.deepEqual(json(root, ["read", "§design.rules/voice"]).frame.items.map((i) => i.id), ["§design/rules"], "not twice");
  const text = run(root, ["read", "§s.seed/edit"]).stdout;
  assert.match(text, /── §s\/panel — Toolbar \[surface\].*embedded in §s\.seed\/edit/);
  assert.match(text, /notes about it, not delivered by this read: §design\.copy\/edit-only, §design\.copy\/editor/);
  assert.match(text, /── frame: always applies, delivered once on this first page \(2 passage\(s\), \d+ B of the 12000 B cap; --no-frame drops it\)\n── §design\/rules — Ground rules \[note\]/);
  assert.match(run(root, ["read", "§s.seed/edit", "--no-frame"]).stdout, /frame: 2 passage\(s\), \d+ B of the 12000 B cap: read it with read --frame/);
  const f = stream(root, ["read", "--frame"]);
  assert.deepEqual([...f.texts.keys()], ["§design/rules", "§design.rules/voice"]);
  assert.equal(f.pages[0].frameRead, true);
  assert.equal(f.pages[0].id, null);
  for (const bad of [["read", "--frame", "§s/seed"], ["read", "--frame", "--whole"]]) {
    const j = json(root, bad); assert.equal(j.exit, 2); assert.equal(j.code, "usage");
  }
  assert.equal(json(root, ["toc", "§s/seed", "--dir", "out", "--frame"]).code, "usage", "--frame is read's");
});

test("impact walks embeds back to the embedding claim", () => {
  const j = json(fixture(), ["impact", "§s/panel"]);
  assert.ok(j.consumers.some((c) => c.id === "§s.seed/edit" && c.depth === 1));
});

test("a frame over 12,000 bytes is a visible finding and is still delivered whole", () => {
  const big = "Every message says what happened. ".repeat(400);
  const root = fixture(CLAIMS, { ...FILES, "design/rules.md": FILES["design/rules.md"].replace("Every message says what happened and what to do next.", big) });
  const c = json(root, ["check"]);
  assert.ok(c.findings.some((f) => f.code === "frame-over-cap" && f.severity === "warn"), JSON.stringify(c.findings));
  const p = json(root, ["packet", "§s.seed/edit"]);
  assert.equal(p.frame.overCap, true); assert.ok(p.frame.bytes > 12000);
  assert.ok(stream(root, ["packet", "§s.seed/edit", "--part", "findings"]).items.some((i) => i.value.code === "frame-over-cap"));
  const f = stream(root, ["packet", "§s.seed/edit", "--part", "frame"]);
  assert.equal([...f.texts.values()].reduce((n, t) => n + Buffer.byteLength(t), 0), p.frame.bytes, "not cut");
  assert.ok(f.pages.length > 1, "paged, not truncated");
  const rf = stream(root, ["read", "--frame"]);
  assert.equal([...rf.texts.values()].reduce((n, t) => n + Buffer.byteLength(t), 0), p.frame.bytes);
  assert.match(run(root, ["read", "§s.seed/limits", "--no-frame"]).stdout, /OVER the cap, delivered whole/);
  const first = json(root, ["read", "§s.seed/limits"]);
  assert.equal(first.frame.items.reduce((n, i) => n + Buffer.byteLength(i.text), 0), p.frame.bytes, "whole on read's first page too");
});

// Older cores exit 2 on unknown label values or kinds; the fields are neither, so master's core must still read them.
test("the baseline core (a95768b7) still runs on a manifest carrying the fields", (t) => {
  const repo = spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
  const has = repo && spawnSync("git", ["-C", repo, "cat-file", "-e", "a95768b7^{commit}"]).status === 0;
  if (!has) return t.skip("baseline commit a95768b7 not in this repository");
  const old = mkdtempSync(join(tmpdir(), "spec-old-core-")); roots.push(old);
  const tar = spawnSync("git", ["-C", repo, "archive", "a95768b7", "pi-config/extensions/spec/core"], { maxBuffer: 64 << 20 });
  assert.equal(tar.status, 0);
  assert.equal(spawnSync("tar", ["-x", "-C", old], { input: tar.stdout }).status, 0);
  const oldCore = join(old, "pi-config/extensions/spec/core/sova-spec.mjs");
  assert.ok(existsSync(oldCore));
  const root = fixture(), bare = fixture(plain(CLAIMS));
  for (const args of [["check"], ["scope", "§s.seed/edit"], ["impact", "§s/panel"]]) {
    const a = json(root, args, oldCore), b = json(bare, args, oldCore);
    assert.notEqual(a.exit, 2, `${args.join(" ")}: ${JSON.stringify(a.findings)}`);
    assert.equal(a.exit, b.exit);
    assert.deepEqual(a.findings, b.findings, "the old core ignores the fields");
  }
  const p = run(root, ["packet", "§s.seed/edit"], oldCore);
  assert.notEqual(p.status, 2); assert.notEqual(JSON.parse(p.stdout).status, "refused");
});
