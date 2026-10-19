// Run: pnpm test server/conversation-draft.test.ts. Client projects are plain folders in the OS temp
// dir; the spec draft tool is the in-process fake (server/spec-tool-fake.ts), Sova's own writing is real.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-conv-draft-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const writer = await import("./spec-draft-writer");
writer.setDraftToolForTest((await import("./spec-tool-fake")).fakeDraftTool());
const cd = await import("./conversation-draft");

const SID = "3f2a9c1e-0b7d-4e55-9a1c-1234567890ab";

/** A client project with a small seed spec: an archery website. */
function seed(name: string): string {
  const root = join(tmp, name);
  const spec = join(root, ".sova", "spec");
  mkdirSync(join(spec, "claims", "site"), { recursive: true });
  writeFileSync(
    join(spec, "manifest.json"),
    `${JSON.stringify({ formatVersion: 1, claims: { "§site/pages": { kind: "surface", authority: "accepted" }, "§site.pages/home": { kind: "behavior", authority: "accepted" } } }, null, 2)}\n`,
  );
  writeFileSync(join(spec, "claims", "site", "pages.md"), "# §site/pages — The site's pages\n\nThe website's pages.\n\n## §site.pages/home — Home page\n\nThe home page shows the next class dates.\n");
  return root;
}

/** Every file of the current spec (drafts aside), as bytes: what "current unchanged" compares. */
function currentBytes(root: string): Record<string, string> {
  const spec = join(root, ".sova", "spec");
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) {
      const abs = join(dir, n);
      const rel = relative(spec, abs);
      if (rel === "drafts" || rel === ".gitignore") continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out[rel] = readFileSync(abs, "utf8");
    }
  };
  walk(spec);
  return out;
}

const item = (n: number, statement: string, more: Partial<import("../shared/conversation-drafts").DraftItem> = {}): import("../shared/conversation-drafts").DraftItem => ({
  id: `r${n}`,
  kind: more.target ? "change" : "new",
  title: statement,
  text: statement,
  area: "Content editing",
  areaKey: "content-editing",
  quote: `I want ${statement.toLowerCase()}`,
  by: "p_alperen",
  name: "Alperen",
  agreedAt: "2026-10-17T10:00:00Z",
  entryId: `u${n}`,
  status: "agreed",
  ...more,
});

describe("conversation draft name", () => {
  test("conv- and the session id, a name the draft tool takes", () => {
    const name = cd.conversationDraftName(SID);
    assert.equal(name, `conv-${SID}`);
    assert.match(name, /^[a-z0-9][a-z0-9_-]{0,63}$/);
  });
});

describe("catching up", () => {
  test("a project with no spec gets an empty draft; current stays absent", async () => {
    const root = join(tmp, "nospec");
    mkdirSync(root, { recursive: true });
    const out = await cd.catchUpDraft(root, SID, []);
    assert.equal(out.draft, `conv-${SID}`);
    assert.ok(writer.draftExists(root, out.draft));
    assert.equal(existsSync(join(root, ".sova", "spec", "manifest.json")), false);
    assert.deepEqual(cd.draftChangesOf(root, out.draft), []);
  });

  test("agreed requirements are written to the draft, and current is byte for byte unchanged", async () => {
    const root = seed("new-reqs");
    const before = currentBytes(root);
    const out = await cd.catchUpDraft(root, SID, [item(1, "The founder edits class dates himself."), item(2, "Prices show in riyals.")]);
    assert.deepEqual(currentBytes(root), before);
    assert.equal(out.items.length, 2);
    assert.ok(out.items.every((i) => i.recordId?.startsWith("§requirements.content-editing/")));
    const changes = cd.draftChangesOf(root, out.draft);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.status, c.title]).sort(),
      [
        ["new", "added", "Prices show in riyals."],
        ["new", "added", "The founder edits class dates himself."],
      ],
    );
    assert.ok(changes.every((c) => /— Alperen, 2026-10-17/.test(c.text!)));
  });

  test("a change names the record it changes, in prose and manifest; the record itself is untouched", async () => {
    const root = seed("change");
    const before = currentBytes(root);
    const h = cd.targetHash(root, "§site.pages/home");
    assert.ok(h);
    const out = await cd.catchUpDraft(root, SID, [item(1, "The home page shows the next tournament too.", { target: "§site.pages/home", basedOnHash: h! })]);
    assert.deepEqual(out.clashes, []);
    assert.deepEqual(currentBytes(root), before);
    const changes = cd.draftChangesOf(root, out.draft);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.kind, "change");
    assert.equal(changes[0]!.changes, "§site.pages/home");
    assert.match(changes[0]!.text!, /^Changes §site\.pages\/home\.$/m);
    const draftPages = readFileSync(join(writer.draftSpecDir(root, out.draft), "claims", "site", "pages.md"), "utf8");
    assert.equal(draftPages, before["claims/site/pages.md"]);
  });

  test("the draft follows current: a record merged meanwhile is in it, and the next catch-up keeps each record id", async () => {
    const root = seed("follow");
    const first = await cd.catchUpDraft(root, SID, [item(1, "Galleries per class.")]);
    // Another draft merged meanwhile: a new record in current.
    const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
    m.claims["§site.pages/contact"] = { kind: "behavior", authority: "accepted" };
    writeFileSync(join(root, ".sova/spec/manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
    writeFileSync(join(root, ".sova/spec/claims/site/pages.md"), `${readFileSync(join(root, ".sova/spec/claims/site/pages.md"), "utf8")}\n## §site.pages/contact — Contact\n\nA contact form.\n`);
    const again = await cd.catchUpDraft(root, SID, first.items);
    assert.equal(again.items[0]!.recordId, first.items[0]!.recordId);
    const dm = JSON.parse(readFileSync(join(writer.draftSpecDir(root, again.draft), "manifest.json"), "utf8"));
    assert.ok(dm.claims["§site.pages/contact"]);
    assert.deepEqual(cd.draftChangesOf(root, again.draft).map((c) => c.id), [first.items[0]!.recordId]);
  });

  test("a record id another conversation took in current meanwhile moves to a free slug", async () => {
    const root = seed("slug");
    const first = await cd.catchUpDraft(root, SID, [item(1, "Galleries per class.")]);
    const rid = first.items[0]!.recordId!;
    const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
    m.claims[rid] = { kind: "note", authority: "accepted", decision: "other-session:m9" };
    writeFileSync(join(root, ".sova/spec/manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
    const again = await cd.catchUpDraft(root, SID, first.items);
    assert.notEqual(again.items[0]!.recordId, rid);
    assert.equal(again.items[0]!.recordId, `${rid}-b`);
  });

  test("a change whose target moved in current, or went, is a clash, and stays in the draft", async () => {
    const root = seed("clash");
    const h = cd.targetHash(root, "§site.pages/home")!;
    const items = [item(1, "Home shows tournaments.", { target: "§site.pages/home", basedOnHash: h })];
    const file = join(root, ".sova/spec/claims/site/pages.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("next class dates", "next class dates and prices"));
    const moved = await cd.catchUpDraft(root, SID, items);
    assert.deepEqual(
      moved.clashes.map((c) => [c.target, c.reason]),
      [["§site.pages/home", "changed"]],
    );
    assert.equal(cd.draftChangesOf(root, moved.draft).length, 1);
    writeFileSync(file, "# §site/pages — The site's pages\n\nThe website's pages.\n");
    const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
    delete m.claims["§site.pages/home"];
    writeFileSync(join(root, ".sova/spec/manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
    const gone = await cd.catchUpDraft(root, SID, items);
    assert.deepEqual(
      gone.clashes.map((c) => c.reason),
      ["gone"],
    );
  });
});

describe("a coding session's context from a draft", () => {
  test("names the draft and holds each requirement in full; null when the draft changes nothing", async () => {
    const root = seed("ctx");
    const empty = await cd.catchUpDraft(root, SID, []);
    assert.equal(cd.codingContextOf(root, empty.draft), null);
    const h = cd.targetHash(root, "§site.pages/home")!;
    const out = await cd.catchUpDraft(root, SID, [item(1, "Galleries per class."), item(2, "Home shows tournaments.", { target: "§site.pages/home", basedOnHash: h })]);
    const ctx = cd.codingContextOf(root, out.draft)!;
    assert.match(ctx, new RegExp(`conv-${SID}`));
    assert.match(ctx, /## New requirements\n\n### New requirement: Galleries per class\./);
    assert.match(ctx, /## Changes to existing behaviour\n\n### Change to/);
    assert.match(ctx, /Change to §site\.pages\/home: Home shows tournaments\./);
    assert.match(ctx, /I want galleries per class\./);
  });
});

describe("seeding from the decisions a conversation already recorded", () => {
  test("its live decisions, oldest first; superseded ones and other sessions' are left out", () => {
    const d = (id: string, at: string, more: Record<string, unknown> = {}) => ({ id: `${SID}:${id}`, sessionId: SID, area: "A", areaKey: "a", statement: id, quote: id, by: "p", name: "P", at, entryId: id, state: "drafted", ...more }) as any;
    const rows = [d("late", "2026-10-17T12:00:00Z"), d("early", "2026-10-17T09:00:00Z"), d("gone", "2026-10-17T10:00:00Z", { state: "superseded", supersededBy: "x" }), d("other", "2026-10-17T08:00:00Z", { sessionId: "other" }), d("prom", "2026-10-17T11:00:00Z", { state: "promoted" })];
    const items = cd.itemsOfDecisions(rows, SID, [{ id: "r1" } as any], (r) => (r.statement === "late" ? { changes: "§site.pages/home", changesHash: "h" } : {}));
    assert.deepEqual(items.map((i) => [i.id, i.text]), [["r2", "early"], ["r3", "prom"], ["r4", "late"]]);
    assert.deepEqual([items[2]!.kind, items[2]!.target, items[2]!.basedOnHash], ["change", "§site.pages/home", "h"]);
    assert.equal(items[0]!.kind, "new");
    assert.ok(items.every((i) => i.seeded && i.decisionId?.startsWith(SID)));
    // Seeding twice adds nothing.
    assert.deepEqual(cd.itemsOfDecisions(rows, SID, items), []);
  });
});
