// Run: pnpm exec tsx --test server/reconcile.integration.test.ts. The decisions layer's spec writing
// through the REAL spec draft tool (pi-config/extensions/spec/core/sova-spec-draft.mjs, child
// processes), in plain folders under the OS temp dir. reconcile.test.ts runs the reconciler on an
// in-process stand-in for the tool (server/spec-tool-fake.ts); the first case here holds that
// stand-in to the real tool's output for the same draft and promotion.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { rmSync } from "node:fs";
import type { DecisionRow } from "../shared/decisions";
import { fakeDraftTool } from "./spec-tool-fake";
import * as writer from "./spec-draft-writer";
import { scratchRoot } from "./test-scratch";

const tmp = scratchRoot("sova-reconcile-int-");
after(() => {
  writer.setDraftToolForTest(null);
  rmSync(tmp, { recursive: true, force: true });
});

const row = (over: Partial<DecisionRow>): DecisionRow =>
  ({ id: "s:m", areaKey: "hosting", area: "Hosting", statement: "Runs on srv-01.", quote: "srv-01", name: "Tony", at: "2026-09-26T00:00:00Z", by: "p_t", sessionId: "s", entryId: "e", recordId: "§requirements.hosting/runs-on-srv", ...over }) as DecisionRow;

/** Every file under `dir`, relative, with its text: what a spec directory holds. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** A draft.json without what differs by run or by tool internals (times, hashes, the plan). */
function draftFacts(file: string) {
  const dj = JSON.parse(readFileSync(file, "utf8"));
  return {
    format: dj.format,
    name: dj.name,
    purpose: dj.purpose,
    base: { specExisted: dj.base.specExisted, claimsRoot: dj.base.claimsRoot },
    evidence: dj.evidence.map((e: any) => ({ by: e.by, mode: e.mode, verification: e.verification, ids: e.ids.map((x: any) => ({ id: x.id, kind: x.kind, deleted: x.deleted })) })),
    promotions: dj.promotions.map((p: any) => ({ ids: p.ids, files: [...p.files].sort() })),
  };
}

/** One project's spec writing: a draft of two decisions, then one promoted, then a re-draft. */
async function scenario(root: string) {
  mkdirSync(join(root, ".sova", "spec", "claims", "app"), { recursive: true });
  writeFileSync(join(root, ".sova", "spec", "manifest.json"), JSON.stringify({ formatVersion: 1, claims: { "§app/thing": { kind: "note", authority: "accepted" } } }));
  writeFileSync(join(root, ".sova", "spec", "claims", "app", "thing.md"), "# §app/thing — Thing\n\nPre-existing.\n");
  const a = row({});
  const b = row({ id: "s:n", statement: "Backups run nightly.", quote: "nightly", recordId: "§requirements.hosting/backups-nightly" });
  const drafted = await writer.writeProjectDraft(root, { rows: [a, b], supersededBy: new Map() });
  const promoted = await writer.promoteEdit(root, { rows: [a], supersededBy: new Map() }, (id) => `checked ${id}`, new Date("2026-10-01T00:00:00Z"));
  const again = await writer.writeProjectDraft(root, { rows: [b], supersededBy: new Map() });
  return {
    results: { drafted, promoted: { promoted: promoted.promoted, draft: promoted.draft }, again },
    current: tree(join(root, ".sova", "spec")),
    batch: draftFacts(join(root, ".sova", "spec", "drafts", promoted.draft!, "draft.json")),
    project: draftFacts(join(root, ".sova", "spec", "drafts", writer.PROJECT_DRAFT, "draft.json")),
  };
}

describe("the spec draft tool, real", () => {
  test("the in-process stand-in writes what the real tool writes, for a draft, a promotion and a re-draft", async () => {
    writer.setDraftToolForTest(null);
    const real = await scenario(join(tmp, "real"));
    writer.setDraftToolForTest(fakeDraftTool());
    try {
      const fake = await scenario(join(tmp, "fake"));
      assert.deepEqual(fake.results, real.results);
      // The drafts' own bookkeeping (draft.json: times, hashes) is compared by its facts below.
      const files = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith("draft.json")));
      assert.deepEqual(files(fake.current), files(real.current), "the same files, byte for byte: current spec and drafts");
      assert.deepEqual(fake.batch, real.batch);
      assert.deepEqual(fake.project, real.project);
    } finally {
      writer.setDraftToolForTest(null);
    }
  });

  test("an existing spec: a promotion appends an area file without touching other claims", async () => {
    writer.setDraftToolForTest(null);
    const root = join(tmp, "existing");
    mkdirSync(join(root, ".sova", "spec", "claims", "app"), { recursive: true });
    writeFileSync(join(root, ".sova", "spec", "manifest.json"), JSON.stringify({ formatVersion: 1, claims: { "§app/thing": { kind: "note", authority: "accepted" } } }));
    writeFileSync(join(root, ".sova", "spec", "claims", "app", "thing.md"), "# §app/thing — Thing\n\nPre-existing.\n");
    const out = await writer.promoteEdit(root, { rows: [row({})], supersededBy: new Map() }, () => "test");
    assert.deepEqual(out.promoted.sort(), ["§requirements.hosting/runs-on-srv", "§requirements/hosting"]);
    const m = JSON.parse(readFileSync(join(root, ".sova", "spec", "manifest.json"), "utf8"));
    assert.deepEqual(m.claims["§app/thing"], { kind: "note", authority: "accepted" });
    assert.equal(readFileSync(join(root, ".sova", "spec", "claims", "app", "thing.md"), "utf8"), "# §app/thing — Thing\n\nPre-existing.\n");
    const core = await writer.runDraftTool(root, ["status", writer.PROJECT_DRAFT]);
    assert.equal(core.exit, 2, "the real tool: no project draft was made");
  });
});
