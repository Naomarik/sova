// Run: npx tsx --test src/lib/needs-you-row.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, SessionSummary } from "../../shared/protocol";
import type { NeedsYouRow } from "./needs-you";
import { itemRow, NEEDS_KINDS, rowLabels, sessionRow } from "./needs-you-row";

const HOME = "/h/me";
const item = (x: Partial<AttentionItem>): AttentionItem => ({ id: "i", path: "", title: "Notes", where: "/h/me/w/notes", tier: "act", kind: "release-failed", since: 1, detail: "v0.4.0: Publish failed: origin refused", href: "#/projects/prj_1/releases", ...x });
const row = (x: Omit<Partial<NeedsYouRow>, "session"> & { session?: Partial<SessionSummary> } = {}): NeedsYouRow =>
  ({ detail: "2 open questions in al_3", details: ["2 open questions in al_3"], since: 1, kind: "open-questions", soft: false, ...x, session: { path: "/s/a.jsonl", cwd: "/h/me/w/notes", title: "Fix the build", ...x.session } }) as NeedsYouRow;

test("every kind has a chip word and a tone the Chip takes; a word never rests on colour alone", () => {
  for (const [kind, k] of Object.entries(NEEDS_KINDS)) {
    assert.ok(k.word.trim().length > 0, kind);
    assert.ok(k.word.length <= 12, `${kind}: a chip's word stays short: ${k.word}`);
    assert.ok(k.tone === undefined || ["error", "warn", "success", "info", "accent"].includes(k.tone), kind);
  }
  assert.equal(NEEDS_KINDS["release-failed"].word, "Failed");
  assert.equal(NEEDS_KINDS["needs-input"].word, "Your turn");
  assert.equal(NEEDS_KINDS["release-ready"].word, "Ready");
  assert.equal(NEEDS_KINDS["open-questions"].word, "Question");
});

test("a no-session kind listed in Needs you has a title or is an owner's item, whose own title is its request", () => {
  const noSession = Object.entries(NEEDS_KINDS).filter(([k]) => /^(deploy|release|whatsapp|outreach|held|project-stakeholder|conflict)/.test(k));
  assert.ok(noSession.length >= 11);
  for (const [kind, k] of noSession) assert.ok(k.title, kind);
  assert.equal(itemRow(item({ kind: "owner-request", title: "The page is slow", where: "Acme", org: { orgId: "o", orgName: "Acme", projectId: "p", projectName: "Shop" }, href: "#/orgs/o/requests/r" }), { home: HOME, now: 0 }).title, "The page is slow");
});

test("a chat's row: its project or folder, its title, its sentences as hover text, newest first; no word for what it opens", () => {
  const r = sessionRow(row(), { href: "#/s/a", home: HOME });
  assert.deepEqual({ name: r.name, place: r.place, title: r.title, tip: r.tip, word: r.chip.word }, { name: "notes", place: "~/w/notes", title: "Fix the build", tip: "Fix the build\n2 open questions in al_3", word: "Question" });
  assert.deepEqual(Object.keys(r).filter((k) => /action|detail/i.test(k)), [], "a slim row has no line for it");
  assert.equal(sessionRow(row({ details: ["Waiting on a dialog.", "429 rate limited"] }), { href: "#", home: HOME }).tip, "Fix the build\nWaiting on a dialog.\n429 rate limited");
  assert.equal(sessionRow(row({ details: [] }), { href: "#", home: HOME }).tip, "Fix the build", "an item with no sentence adds nothing");
  assert.equal(sessionRow(row({ session: { project: { projectId: "p", projectName: "Notes", kind: "folder" } } }), { href: "#", home: HOME }).name, "Notes");
  assert.equal(sessionRow(row({ session: { org: { orgId: "o", orgName: "Acme", projectId: "p", projectName: "Shop", kind: "coding" } as SessionSummary["org"] } }), { href: "#", home: HOME }).name, "Acme · Shop");
  assert.equal(sessionRow(row(), { href: "#", home: HOME, host: "laptop" }).name, "notes · laptop");
});

test("a project's item: the project's name, what it is, its sentence as hover text; the folder leaves the row", () => {
  const r = itemRow(item({}), { home: HOME, now: 0 });
  assert.deepEqual({ name: r.name, place: r.place, title: r.title, tip: r.tip, word: r.chip.word }, { name: "Notes", place: "~/w/notes", title: "Publish failed", tip: "Publish failed\nv0.4.0: Publish failed: origin refused", word: "Failed" });
  const ready = itemRow(item({ kind: "release-ready", detail: "Ready to publish · v0.4.0" }), { home: HOME, now: 0 });
  assert.deepEqual({ title: ready.title, tip: ready.tip }, { title: "Ready to publish", tip: "Ready to publish\nReady to publish · v0.4.0" });
  assert.equal(itemRow(item({ kind: "whatsapp-down", title: "WhatsApp sending", where: "Settings → Outreach" }), { home: HOME, now: 0 }).place, null, "not a folder");
});

test("a held act names what waits and recounts its minutes", () => {
  const goesAt = 10 * 60_000;
  const it = item({ kind: "held-act", title: "Notes", where: "Projects", detail: "stale", held: { id: "h", goesAt, what: "Publishing v0.4.0." } });
  const r = itemRow(it, { home: HOME, now: 0 });
  assert.equal(r.title, "Publishing v0.4.0");
  assert.match(r.tip, /10 min/);
  assert.match(itemRow(it, { home: HOME, now: 6 * 60_000 }).tip, /4 min/);
});

test("two listed projects of one name show just enough of the path to tell them apart", () => {
  const rows = [
    { key: "a", name: "Notes", place: "~/work/notes" },
    { key: "b", name: "Notes", place: "~/play/notes" },
    { key: "c", name: "Shop", place: "~/shop" },
  ];
  const l = rowLabels(rows);
  assert.deepEqual([l.get("a"), l.get("b"), l.get("c")], ["Notes · work/notes", "Notes · play/notes", "Shop"]);
  // One segment is enough here: no more than that.
  const short = rowLabels([{ key: "a", name: "Notes", place: "~/x/alpha" }, { key: "b", name: "Notes", place: "~/x/beta" }]);
  assert.deepEqual([short.get("a"), short.get("b")], ["Notes · alpha", "Notes · beta"]);
  // Deeper paths go only as deep as they must, whichever is shorter.
  const deep = rowLabels([{ key: "a", name: "N", place: "/a/b/c/notes" }, { key: "b", name: "N", place: "/z/b/c/notes" }, { key: "c", name: "N", place: "/notes" }]);
  assert.deepEqual([deep.get("a"), deep.get("b"), deep.get("c")], ["N · a/b/c/notes", "N · z/b/c/notes", "N · notes"]);
});

test("two items of one project are one project: no path; a row with no folder keeps its name", () => {
  const l = rowLabels([{ key: "a", name: "Notes", place: "~/w/notes" }, { key: "b", name: "Notes", place: "~/w/notes/" }, { key: "c", name: "Notes", place: null }]);
  assert.deepEqual([l.get("a"), l.get("b"), l.get("c")], ["Notes", "Notes", "Notes"]);
});

test("a failed Publish is titled as the tab says it; any other failed step keeps the kind's title; the hover text keeps the whole sentence", () => {
  const publish = itemRow(item({}), { home: HOME, now: 0 });
  assert.equal(publish.tip, "Publish failed\nv0.4.0: Publish failed: origin refused");
  assert.equal(itemRow(item({ detail: "The open release: Publish failed" }), { home: HOME, now: 0 }).title, "Publish failed");
  const step = itemRow(item({ detail: "v0.4.0: Smoke test failed: 500 on /search" }), { home: HOME, now: 0 });
  assert.deepEqual({ title: step.title, tip: step.tip }, { title: "Release step failed", tip: "Release step failed\nv0.4.0: Smoke test failed: 500 on /search" });
});
