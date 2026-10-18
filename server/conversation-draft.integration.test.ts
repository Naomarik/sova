// Run: pnpm test:int server/conversation-draft.integration.test.ts. A conversation's draft through the
// REAL spec draft tool (pi-config/extensions/spec/core/sova-spec-draft.mjs, child processes), in plain
// folders under the OS temp dir: it loads, it changes only itself, and the draft-changes listing reads
// what the real tool wrote.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import * as writer from "./spec-draft-writer";
import * as cd from "./conversation-draft";
import type { DraftItem } from "../shared/conversation-drafts";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-conv-draft-int-");
after(() => rmSync(tmp, { recursive: true, force: true }));

const SID = "9b1d2c3e-aaaa-4bbb-8ccc-0123456789ab";

function current(root: string): Record<string, string> {
  const spec = join(root, ".sova", "spec");
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const rel = relative(spec, p);
      if (rel === "drafts" || rel === ".gitignore") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[rel] = readFileSync(p, "utf8");
    }
  };
  walk(spec);
  return out;
}

const it = (n: number, statement: string, more: Partial<DraftItem> = {}): DraftItem => ({
  id: `r${n}`,
  kind: more.target ? "change" : "new",
  title: statement,
  text: statement,
  area: "Content editing",
  areaKey: "content-editing",
  quote: statement,
  by: "p_alperen",
  name: "Alperen",
  agreedAt: "2026-10-17T10:00:00Z",
  entryId: `u${n}`,
  status: "agreed",
  ...more,
});

describe("a conversation draft through the real tool", () => {
  test("seeded spec: the draft loads, holds a new requirement and a change, and current is unchanged", async () => {
    const root = join(tmp, "seeded");
    mkdirSync(join(root, ".sova", "spec", "claims", "site"), { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), `${JSON.stringify({ formatVersion: 1, claims: { "§site/pages": { kind: "surface", authority: "accepted" }, "§site.pages/home": { kind: "behavior", authority: "accepted" } } }, null, 2)}\n`);
    writeFileSync(join(root, ".sova", "spec", "claims", "site", "pages.md"), "# §site/pages — Pages\n\nThe website's pages.\n\n## §site.pages/home — Home\n\nThe home page shows the next class dates.\n");
    const before = current(root);
    const h = cd.targetHash(root, "§site.pages/home")!;
    const out = await cd.catchUpDraft(root, SID, [it(1, "Galleries per class."), it(2, "Home shows tournaments.", { target: "§site.pages/home", basedOnHash: h })]);
    assert.deepEqual(current(root), before);
    const check = await writer.runDraftTool(root, ["check", out.draft]);
    assert.notEqual(check.exit, 2, JSON.stringify(check.json.findings ?? check.json));
    const changes = cd.draftChangesOf(root, out.draft);
    assert.deepEqual(changes.map((c) => c.kind).sort(), ["change", "new"]);
    // Caught up again: the same draft name, still loading.
    const again = await cd.catchUpDraft(root, SID, out.items);
    assert.equal(again.draft, out.draft);
    assert.deepEqual(current(root), before);
  });

  test("no spec at all: an empty draft, and no current spec appears", async () => {
    const root = join(tmp, "empty");
    mkdirSync(root, { recursive: true });
    const out = await cd.catchUpDraft(root, SID, [it(1, "Galleries per class.")]);
    assert.equal(existsSync(join(root, ".sova", "spec", "manifest.json")), false);
    assert.equal(readFileSync(join(root, ".sova", "spec", ".gitignore"), "utf8").includes("drafts/"), true);
    assert.deepEqual(cd.draftChangesOf(root, out.draft).map((c) => [c.kind, c.status]), [["new", "added"]]);
  });
});

describe("approve through the real tool", () => {
  test("a confirmed conversation leaves current unchanged; approving promotes its new requirement and leaves the change waiting", async () => {
    const tools = await import("./conversation-draft-tools");
    const routes = await import("./conversation-draft-routes");
    const root = join(tmp, "approve");
    const workspace = join(tmp, "approve-ws");
    mkdirSync(join(root, ".sova", "spec", "claims", "site"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), `${JSON.stringify({ formatVersion: 1, claims: { "§site/pages": { kind: "surface", authority: "accepted" }, "§site.pages/home": { kind: "behavior", authority: "accepted" } } }, null, 2)}\n`);
    writeFileSync(join(root, ".sova", "spec", "claims", "site", "pages.md"), "# §site/pages — Pages\n\nThe website's pages.\n\n## §site.pages/home — Home\n\nThe home page shows the next class dates.\n");
    tools.setDraftPlaceForTest(() => ({ workspace, root, name: "Archery site" }));
    try {
      const ref = { sessionId: SID, projectId: "prj_int", kind: "gathering" as const, title: "Your website", person: { id: "p_alperen", name: "Alperen" } };
      const base = { area: "Content editing", areaKey: "content-editing", by: "p_alperen", name: "Alperen", at: "2026-10-17T10:00:00Z" };
      await tools.agreeRequirement(ref, { ...base, decisionId: `${SID}:d1`, statement: "A gallery per class.", quote: "a gallery per class", entryId: "u1" });
      await tools.agreeRequirement(ref, { ...base, decisionId: `${SID}:d2`, statement: "Home shows tournaments.", quote: "tournaments on home", entryId: "u2" }, await tools.changeOf("prj_int", "§site.pages/home"));
      const before = current(root);
      await tools.catchUpConversationDraft(SID, "prj_int", ref);
      assert.deepEqual(current(root), before, "master unchanged by the conversation");
      const check = await writer.runDraftTool(root, ["check", cd.conversationDraftName(SID)]);
      assert.notEqual(check.exit, 2);
      const out = await routes.approveDraft("prj_int", SID);
      assert.deepEqual([out.promoted, out.waitingForBuild], [["r1"], ["r2"]]);
      const m = JSON.parse(readFileSync(join(root, ".sova", "spec", "manifest.json"), "utf8"));
      const promoted = Object.entries(m.claims).filter(([, r]: [string, any]) => r.decision === `${SID}:d1`);
      assert.equal(promoted.length, 1);
      assert.equal(Object.values(m.claims).filter((r: any) => r.decision === `${SID}:d2`).length, 0, "the change waits for its build");
      assert.equal(readFileSync(join(root, ".sova", "spec", "claims", "site", "pages.md"), "utf8").includes("next class dates."), true);
    } finally {
      tools.setDraftPlaceForTest(null);
    }
  });
});

describe("the draft is based on the main line, not the checked-out branch", () => {
  test("root on feat/x with an extra committed claim: the draft lacks it, and draft-specs compares with master", async () => {
    const { execFileSync } = await import("node:child_process");
    const tools = await import("./conversation-draft-tools");
    const routes = await import("./conversation-draft-routes");
    process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
    const root = join(tmp, "mainline");
    const workspace = join(tmp, "mainline-ws");
    mkdirSync(join(root, ".sova", "spec", "claims", "site"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const g = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" });
    const manifest = (claims: Record<string, unknown>) => writeFileSync(join(root, ".sova", "spec", "manifest.json"), `${JSON.stringify({ formatVersion: 1, claims }, null, 2)}\n`);
    const base = { "§site/pages": { kind: "surface", authority: "accepted" }, "§site.pages/home": { kind: "behavior", authority: "accepted" } };
    const pages = "# §site/pages — Pages\n\nThe website's pages.\n\n## §site.pages/home — Home\n\nThe home page shows the next class dates.\n";
    manifest(base);
    writeFileSync(join(root, ".sova", "spec", "claims", "site", "pages.md"), pages);
    g("init", "-q", "-b", "master");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    g("checkout", "-q", "-b", "feat/x");
    manifest({ ...base, "§site.pages/shop": { kind: "behavior", authority: "accepted" } });
    writeFileSync(join(root, ".sova", "spec", "claims", "site", "pages.md"), `${pages}\n## §site.pages/shop — Shop\n\nA shop for bows.\n`);
    g("add", "-A");
    g("commit", "-q", "-m", "shop on a branch");
    tools.setDraftPlaceForTest(() => ({ workspace, root, name: "Archery site" }));
    try {
      const sid = "7c1d2c3e-aaaa-4bbb-8ccc-0123456789ab";
      const ref = { sessionId: sid, projectId: "prj_main", kind: "gathering" as const, title: "Your website", person: { id: "p_alperen", name: "Alperen" } };
      const before = current(root);
      await tools.agreeRequirement(ref, { area: "Content editing", areaKey: "content-editing", by: "p_alperen", name: "Alperen", at: "2026-10-17T10:00:00Z", decisionId: `${sid}:d1`, statement: "A gallery per class.", quote: "a gallery per class", entryId: "u1" });
      await tools.catchUpConversationDraft(sid, "prj_main", ref);
      assert.deepEqual(current(root), before, "the root's spec is untouched");
      const name = cd.conversationDraftName(sid);
      const dm = JSON.parse(readFileSync(join(writer.draftSpecDir(root, name), "manifest.json"), "utf8"));
      assert.equal(dm.claims["§site.pages/shop"], undefined, "feat/x's claim is not in the conversation's draft");
      assert.ok(dm.claims["§site.pages/home"]);
      assert.equal(readFileSync(join(writer.draftSpecDir(root, name), "claims", "site", "pages.md"), "utf8"), pages);
      const check = await writer.runDraftTool(root, ["check", name]);
      assert.notEqual(check.exit, 2, JSON.stringify(check.json.findings ?? check.json));
      const [d] = await routes.listDraftSpecs("prj_main", sid);
      assert.deepEqual(d!.newItems.map((i) => i.text), ["A gallery per class."]);
      assert.deepEqual(d!.changes, []);
      const base0 = await tools.draftBaseOf("prj_main", root);
      assert.deepEqual(cd.draftChangesOf(root, name, base0).map((c) => [c.kind, c.status]), [["new", "added"]], "compared with master: no 'removed' shop");
      // A change to a claim only feat/x has is refused: master doesn't describe it.
      await assert.rejects(tools.changeOf("prj_main", "§site.pages/shop"), /wasn't found/);
      // Approving writes the root's spec, which is feat/x's here: refused, nothing written.
      const atFeat = current(root);
      const recFile = join(workspace, "projects", "prj_main", "conversation-drafts", `${sid}.json`);
      const recBefore = readFileSync(recFile, "utf8");
      await assert.rejects(routes.approveDraft("prj_main", sid), (err: any) => err.status === 409 && err.message === "The project folder is on feat/x; approving writes into master's spec. Switch it to master first.");
      assert.deepEqual(current(root), atFeat, "the spec is unchanged");
      assert.equal(readFileSync(recFile, "utf8"), recBefore, "the record is unchanged");
      // Only the drafts' own local-only .gitignore (written at the first catch-up), nothing the approve wrote.
      assert.equal(g("status", "--porcelain").toString(), "?? .sova/spec/.gitignore\n");
      // On master it promotes, into master's spec.
      g("checkout", "-q", "master");
      const out = await routes.approveDraft("prj_main", sid);
      assert.deepEqual(out.promoted, ["r1"]);
      const m = JSON.parse(readFileSync(join(root, ".sova", "spec", "manifest.json"), "utf8"));
      assert.equal(m.claims["§site.pages/shop"], undefined);
      assert.equal(Object.values(m.claims).filter((r: any) => r.decision === `${sid}:d1`).length, 1);
    } finally {
      tools.setDraftPlaceForTest(null);
    }
  });
});
