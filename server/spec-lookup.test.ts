import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { scratchRoot } from "./test-scratch";
import type { HEntry } from "../shared/harness";
import { CANDIDATE_MARK, SPEC_CLOSE, SPEC_OPEN } from "./spec-lookup-projection";
import {
  CALLS_MAX,
  callsThisReply,
  clearHandlesForTest,
  FOREIGN_REF,
  NO_SPEC,
  OVERVIEW_MAX,
  projectOverview,
  resolveRef,
  setLookupPlaceForTest,
  setMainLineForTest,
  setSpecToolForTest,
  specEntries,
  specLookupTool,
  specLookupTools,
  TOO_MANY_LOOKUPS,
} from "./spec-lookup";

// §app.spec-lookup/tool, /outsider-view, /overview

const PASSAGES: Record<string, { title: string; text: string; authority: string }> = {
  "§requirements.pricing/free-class": {
    title: "The beginner class is free",
    text: "## §requirements.pricing/free-class — The beginner class is free\n\nThe beginner class is free.\n\n> Never charge beginners, Kim\n\n— Kim Lee, 2026-10-17\n",
    authority: "accepted",
  },
  "§site.web/gift-cards": { title: "Gift cards", text: "## §site.web/gift-cards — Gift cards\n\nPeople can buy gift cards on `site/gift.html`.\n", authority: "candidate" },
};

let calls: string[][] = [];
beforeEach(() => {
  calls = [];
  clearHandlesForTest();
  setLookupPlaceForTest((pid) => ({ root: `/roots/${pid}`, name: pid === "p2" ? "Shop" : "Archery", names: ["Kim Lee", "Omar"] }));
  setMainLineForTest(async (pid) => ({ root: `/roots/${pid}`, specRoot: pid === "empty" ? null : `/cache/${pid}`, specKey: pid === "empty" ? null : `t-${pid}`, code: { kind: "fs", root: `/roots/${pid}` } }));
  setSpecToolForTest(async (_root, args) => {
    calls.push(args);
    if (args[0] === "where")
      return { exit: 0, lines: Object.entries(PASSAGES).map(([id, p]) => ({ type: "topic", id, title: p.title, labels: { authority: p.authority } })) };
    if (args[0] === "map")
      return {
        exit: 0,
        counts: { claims: 2, areas: 2 },
        lines: [
          { type: "area", id: "§requirements/pricing", title: "Pricing", what: "What things cost, as Kim Lee set it in `pricing.ts`." },
          { type: "area", id: "§site/web", title: "The website", what: "The public pages." },
        ],
      };
    if (args[0] === "toc") return { exit: 0, seed: { title: "Pricing" }, lines: [{ id: "§requirements.pricing/free-class", title: "The beginner class is free", labels: { authority: "accepted" } }] };
    if (args[0] === "read") {
      const p = PASSAGES[args[1]!];
      return p ? { exit: 0, items: [{ id: args[1], title: p.title, text: p.text, labels: { authority: p.authority }, fragment: { complete: true } }] } : { exit: 1, items: [] };
    }
    return { exit: 2 };
  });
});
afterEach(() => {
  setLookupPlaceForTest(null);
  setMainLineForTest(null);
  setSpecToolForTest(null);
});

const run = async (tool: ReturnType<typeof specLookupTool>, params: Record<string, unknown>, branch: HEntry[] = []) =>
  ((await tool.execute("c", params, undefined, undefined, { branch: () => branch } as any)).content[0] as { text: string }).text;

describe("outsider view", () => {
  const tool = () => specLookupTool({ sessionId: "g1", projects: [{ id: "p1", name: "Archery" }], view: "outsider" });

  test("find gives handles, never § ids; a candidate is marked", async () => {
    const out = await run(tool(), { op: "find", words: "free class" });
    assert.ok(out.startsWith(SPEC_OPEN) && out.endsWith(SPEC_CLOSE));
    assert.ok(!out.includes("§"), out);
    assert.match(out, /- s1 — The beginner class is free/);
    assert.match(out, new RegExp(`- s2 — ${CANDIDATE_MARK} Gift cards`));
    assert.deepEqual(resolveRef("g1", "s1"), { projectId: "p1", id: "§requirements.pricing/free-class" });
  });

  test("read by handle: the quote and the name never appear", async () => {
    await run(tool(), { op: "find", words: "free class" });
    const out = await run(tool(), { op: "read", ref: "s1" });
    assert.ok(out.includes("The beginner class is free."));
    assert.ok(!out.includes("Never charge beginners"), out);
    assert.ok(!out.includes("Kim"), out);
    assert.ok(!out.includes("§"), out);
    const cand = await run(tool(), { op: "read", ref: "s2" });
    assert.ok(cand.includes(`${CANDIDATE_MARK} People can buy gift cards`), cand);
    assert.ok(!cand.includes("gift.html"));
  });

  test("a § id, an unknown handle or another conversation's handle is refused", async () => {
    await run(tool(), { op: "find", words: "free class" });
    await assert.rejects(run(tool(), { op: "read", ref: "§requirements.pricing/free-class" }), { message: FOREIGN_REF });
    await assert.rejects(run(tool(), { op: "read", ref: "s99" }), { message: FOREIGN_REF });
    const other = specLookupTool({ sessionId: "g2", projects: [{ id: "p1", name: "Archery" }], view: "outsider" });
    await assert.rejects(run(other, { op: "read", ref: "s1" }), { message: FOREIGN_REF });
  });

  test("the model never names a path or a spec copy", async () => {
    await assert.rejects(run(tool(), { op: "find", words: "x", spec: "/etc" }), /Unknown parameter spec/);
    await run(tool(), { op: "find", words: "--spec /etc --root /" });
    for (const a of calls.flat()) assert.ok(!a.startsWith("-"), `a model word became a flag: ${a}`);
  });

  test("outline: areas cleaned, names masked", async () => {
    const out = await run(tool(), { op: "outline" });
    assert.ok(out.includes("Pricing: What things cost, as someone set it"), out);
    assert.ok(!out.includes("pricing.ts") && !out.includes("Kim"));
  });

  test("at most CALLS_MAX look-ups a reply", async () => {
    const branch = [{ kind: "user", blocks: [] }, ...Array.from({ length: CALLS_MAX }, () => ({ kind: "tool-result", tool: "spec_lookup", blocks: [] }))] as unknown as HEntry[];
    assert.equal(callsThisReply(branch, "spec_lookup"), CALLS_MAX);
    await assert.rejects(run(tool(), { op: "outline" }, branch), { message: TOO_MANY_LOOKUPS });
    assert.equal(callsThisReply([...branch, { kind: "user", blocks: [] } as unknown as HEntry], "spec_lookup"), 0);
  });

  test("no spec yet: a sentence, never an error", async () => {
    const t = specLookupTool({ sessionId: "g3", projects: [{ id: "empty", name: "Empty" }], view: "outsider" });
    assert.ok((await run(t, { op: "outline" })).includes(NO_SPEC));
  });

  test("outsider tools are spec_lookup and code_read; with two projects each needs `project`", async () => {
    const ts = specLookupTools({ sessionId: "a1", projects: [{ id: "p1", name: "Archery" }, { id: "p2", name: "Shop" }], view: "outsider" });
    assert.deepEqual(ts.map((t) => t.name), ["spec_lookup", "code_read"]);
    for (const t of ts) assert.ok((t.parameters as any).required.includes("project"));
    await assert.rejects(run(ts[0]!, { op: "outline" }), /Say which project/);
    await assert.rejects(run(ts[0]!, { op: "outline", project: "Elsewhere" }), /not one of this conversation's projects/);
    await run(ts[0]!, { op: "find", words: "free", project: "Shop" });
    assert.equal(resolveRef("a1", "s1")?.projectId, "p2");
  });
});

describe("full view", () => {
  test("§ ids and the prose as written; only spec_lookup", async () => {
    const ts = specLookupTools({ sessionId: "po", projects: [{ id: "p1", name: "Archery" }], view: "full" });
    assert.deepEqual(ts.map((t) => t.name), ["spec_lookup"]);
    const out = await run(ts[0]!, { op: "read", ref: "§requirements.pricing/free-class" });
    assert.ok(out.includes("Never charge beginners") && out.includes("Kim Lee"));
    await assert.rejects(run(ts[0]!, { op: "read", ref: "--root=/" }), /§ id/);
  });
});

describe("overview", () => {
  test("short, fresh, cleaned for outsiders, read from the files (no child process)", async () => {
    const root = scratchRoot("spec-overview");
    const dir = join(root, ".sova", "spec");
    mkdirSync(join(dir, "claims", "requirements"), { recursive: true });
    mkdirSync(join(dir, "claims", "site"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ formatVersion: 1, grammar: { claimsRoot: "claims/" }, claims: { "§requirements/pricing": {}, "§requirements.pricing/free": {}, "§site/web": {} } }));
    writeFileSync(join(dir, "claims", "requirements", "pricing.md"), "# §requirements/pricing — Pricing\n> Part of it\n\nWhat things cost, as Kim Lee set it in `pricing.ts`. More here.\n");
    writeFileSync(join(dir, "claims", "site", "web.md"), "# §site/web — The website\n\nThe public pages.\n");
    setMainLineForTest(async (pid) => ({ root, specRoot: pid === "empty" ? null : root, specKey: null, code: { kind: "fs", root } }));
    const o = await projectOverview("p1", "outsider");
    assert.ok(o.length <= OVERVIEW_MAX);
    assert.ok(o.startsWith("About the project:") && !o.includes("Archery"), "the outsider overview never names the project beyond the title");
    assert.ok(o.includes("3 entries in 2 areas"), o);
    assert.ok(o.includes("- Pricing: What things cost, as someone set it"), o);
    assert.ok(!o.includes("§") && !o.includes("Kim") && !o.includes("pricing.ts"), o);
    const f = await projectOverview("p1", "full");
    assert.ok(f.startsWith("Project: Archery."));
    assert.ok(f.includes("§requirements/pricing — Pricing"));
    assert.equal(await specEntries("p1"), 3);
    assert.ok((await projectOverview("empty", "outsider")).includes(NO_SPEC));
    assert.equal(await specEntries("empty"), 0);
    assert.equal(calls.length, 0, "no spec tool run");
  });
});
