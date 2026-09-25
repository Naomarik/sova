// Run: npx tsx --test server/overseer-ideas.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-ideas-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const ideas = await import("./overseer-ideas");

after(() => rmSync(agentDir, { recursive: true, force: true }));

let n = 0;
/** A fresh ideas dir per test. */
const fresh = () => join(agentDir, `ideas-${n++}`);

describe("idea ids", () => {
  test("main entries and sub-entries parse; the § is optional on input and canonical on output", () => {
    assert.deepEqual(ideas.parseIdeaId("mesh/retry-backoff"), { id: "§mesh/retry-backoff", ns: "mesh", name: "retry-backoff" });
    assert.deepEqual(ideas.parseIdeaId("§mesh.retry-backoff/jitter"), { id: "§mesh.retry-backoff/jitter", ns: "mesh", parentName: "retry-backoff", name: "jitter" });
    assert.equal(ideas.parentOf("§mesh.retry-backoff/jitter"), "§mesh/retry-backoff");
    assert.equal(ideas.parentOf("§mesh/retry-backoff"), undefined);
  });

  test("anything else is refused, with the grammar in the sentence", () => {
    for (const bad of ["Mesh/x", "mesh", "mesh/", "/x", "mesh/x/y", "mesh.a.b/c", "mesh/under_score", "-mesh/x", 7, ""]) {
      assert.equal(ideas.parseIdeaId(bad), null, String(bad));
    }
    assert.throws(() => ideas.canonicalIdeaId("Mesh/X"), /§<project>\/<name>/);
  });

  test("prose files: a main entry at ideas/<ns>/<name>.md, a sub-entry under its main entry's folder", () => {
    assert.equal(ideas.proseFile("§mesh/retry", "/I"), "/I/mesh/retry.md");
    assert.equal(ideas.proseFile("§mesh.retry/jitter", "/I"), "/I/mesh/retry/jitter.md");
  });
});

describe("the store", () => {
  test("add writes the manifest record and the prose; get and detail read them back", () => {
    const dir = fresh();
    const r = ideas.addIdea({ id: "mesh/retry-backoff", title: "Retry failed peers with backoff", text: "Someday: exponential backoff for peers.", tags: ["Reliability", "#mesh"] }, dir);
    assert.equal(r.id, "§mesh/retry-backoff");
    assert.equal(r.status, "open");
    assert.deepEqual(r.tags, ["reliability", "mesh"]);
    assert.equal(readFileSync(join(dir, "mesh", "retry-backoff.md"), "utf8"), "Someday: exponential backoff for peers.\n");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(m.formatVersion, 1);
    assert.equal(m.ideas["§mesh/retry-backoff"].title, "Retry failed peers with backoff");
    assert.equal(ideas.getIdea("mesh/retry-backoff", dir)?.title, "Retry failed peers with backoff");
    assert.equal(ideas.ideaDetail("§mesh/retry-backoff", dir)?.text, "Someday: exponential backoff for peers.\n");
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "no tmp file left behind");
  });

  test("an id is filed once; a sub-entry needs its main entry; links must name existing ideas and never itself", () => {
    const dir = fresh();
    ideas.addIdea({ id: "mesh/a", title: "A" }, dir);
    assert.throws(() => ideas.addIdea({ id: "mesh/a", title: "again" }, dir), /already exists/);
    assert.throws(() => ideas.addIdea({ id: "mesh.b/c", title: "orphan" }, dir), /does not exist/);
    assert.throws(() => ideas.addIdea({ id: "mesh/d", title: "D", links: ["§mesh/nope"] }, dir), /No idea §mesh\/nope/);
    assert.throws(() => ideas.updateIdea("mesh/a", { links: ["mesh/a"] }, dir), /itself/);
    const sub = ideas.addIdea({ id: "mesh.a/c", title: "Sub", links: ["mesh/a"] }, dir);
    assert.equal(sub.parent, "§mesh/a");
    assert.throws(() => ideas.addIdea({ id: "mesh/e", title: "x".repeat(121) }, dir), /120/);
    assert.throws(() => ideas.addIdea({ id: "mesh/e", title: "E", tags: ["Not Valid!"] }, dir), /Tag/);
  });

  test("append adds a dated paragraph; text replaces; neither touches another idea", () => {
    const dir = fresh();
    ideas.addIdea({ id: "sova/ideas", title: "Ideas", text: "First thought." }, dir);
    ideas.addIdea({ id: "sova/other", title: "Other", text: "Untouched." }, dir);
    const d = ideas.updateIdea("sova/ideas", { append: "PLAN:\n- a store\n- a panel" }, dir, new Date("2026-09-25T10:00:00Z"));
    assert.equal(d.text, "First thought.\n\n_2026-09-25_ — PLAN:\n- a store\n- a panel\n");
    assert.equal(ideas.updateIdea("sova/ideas", { text: "Rewritten.\n" }, dir).text, "Rewritten.\n");
    assert.equal(ideas.readProse("§sova/other", dir), "Untouched.\n");
    assert.throws(() => ideas.updateIdea("sova/ideas", { append: "  " }, dir), /blank/);
  });

  test("status: a linked explorer means exploring, a linked session started; done and dropped are the user's, and dropped is final", () => {
    const dir = fresh();
    ideas.addIdea({ id: "mesh/a", title: "A" }, dir);
    let d = ideas.updateIdea("mesh/a", { explorer: { id: "ag_03", overseerId: "ov1" } }, dir);
    assert.equal(d.idea.status, "exploring");
    assert.equal(d.idea.explorerId, "ag_03");
    assert.equal(d.idea.explorerOverseerId, "ov1");
    d = ideas.updateIdea("mesh/a", { sessionId: "s-1" }, dir);
    assert.equal(d.idea.status, "started");
    d = ideas.updateIdea("mesh/a", { explorer: { id: "ag_04", overseerId: "ov1" } }, dir);
    assert.equal(d.idea.status, "started", "a new explorer never moves a started idea back");
    d = ideas.updateIdea("mesh/a", { status: "done" }, dir);
    d = ideas.updateIdea("mesh/a", { sessionId: "s-2" }, dir);
    assert.equal(d.idea.status, "done", "linking never reopens a closed idea");
    ideas.updateIdea("mesh/a", { status: "dropped" }, dir);
    assert.throws(() => ideas.updateIdea("mesh/a", { status: "open" }, dir), /dropped is final/);
    assert.equal(ideas.getIdea("mesh/a", dir)?.status, "dropped");
  });

  test("a stale base is a conflict carrying the current idea; a fresh one passes; updatedAt always moves", () => {
    const dir = fresh();
    const r = ideas.addIdea({ id: "mesh/a", title: "A" }, dir);
    const first = ideas.updateIdea("mesh/a", { base: r.updatedAt, title: "A1" }, dir);
    assert.ok(first.idea.updatedAt > r.updatedAt);
    try {
      ideas.updateIdea("mesh/a", { base: r.updatedAt, title: "A2" }, dir);
      assert.fail("expected a conflict");
    } catch (err) {
      assert.ok(err instanceof ideas.IdeaConflictError);
      assert.equal(err.current.idea.title, "A1");
    }
    assert.equal(ideas.updateIdea("mesh/a", { base: first.idea.updatedAt, title: "A2" }, dir).idea.title, "A2");
  });

  test("tolerant read: a corrupt manifest is empty; bad records, orphan sub-entries and dangling links are dropped", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{not json");
    assert.deepEqual(ideas.readManifest(dir), { formatVersion: 1, ideas: {} });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        ideas: {
          "§mesh/good": { title: "Good", status: "weird", tags: ["ok", "Bad Tag"], links: ["§mesh/gone", "§mesh/good", "§sova/x"], createdAt: "t" },
          "§sova/x": { title: "X", status: "open", tags: [], links: [] },
          "Not An Id": { title: "bad id" },
          "§mesh/untitled": { status: "open" },
          "§mesh.missing/child": { title: "orphan" },
        },
      }),
    );
    const m = ideas.readManifest(dir);
    assert.deepEqual(Object.keys(m.ideas).sort(), ["§mesh/good", "§sova/x"]);
    assert.equal(m.ideas["§mesh/good"]!.status, "open");
    assert.deepEqual(m.ideas["§mesh/good"]!.tags, ["ok"]);
    assert.deepEqual(m.ideas["§mesh/good"]!.links, ["§sova/x"]);
    assert.equal(ideas.readProse("§mesh/good", dir), "", "a missing .md reads as no text");
  });

  test("the backlog is capped", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const all: Record<string, unknown> = {};
    for (let i = 0; i < ideas.IDEAS_MAX; i++) all[`§bulk/i${i}`] = { title: `I${i}`, status: "open", tags: [], links: [] };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ formatVersion: 1, ideas: all }));
    assert.throws(() => ideas.addIdea({ id: "bulk/one-more", title: "x" }, dir), /at most 500/);
  });
});

describe("the graph", () => {
  const build = () => {
    const dir = fresh();
    ideas.addIdea({ id: "mesh/retry", title: "Retry peers" }, dir);
    ideas.addIdea({ id: "mesh.retry/jitter", title: "Jitter" }, dir);
    ideas.addIdea({ id: "mesh/health", title: "Peer health", links: ["mesh/retry"] }, dir);
    ideas.addIdea({ id: "sova/dash", title: "Mesh dashboard", links: ["mesh/health"] }, dir);
    ideas.addIdea({ id: "sova/alone", title: "Alone" }, dir);
    // A cycle: retry → dash → health → retry.
    ideas.updateIdea("mesh/retry", { addLinks: ["sova/dash"] }, dir);
    return dir;
  };

  test("scope: sub-entries and everything reachable through links, nearest first, each once, never itself, cycles included", () => {
    const dir = build();
    const m = ideas.readManifest(dir);
    assert.deepEqual(ideas.scopeOf("§mesh/retry", m), ["§mesh.retry/jitter", "§sova/dash", "§mesh/health"]);
    assert.deepEqual(ideas.scopeOf("§sova/dash", m), ["§mesh/health", "§mesh/retry", "§mesh.retry/jitter"]);
    assert.deepEqual(ideas.scopeOf("§sova/alone", m), []);
  });

  test("impact: direct linkers and, transitively, theirs", () => {
    const dir = build();
    const m = ideas.readManifest(dir);
    assert.deepEqual(ideas.linkedBy("§mesh/retry", m), ["§mesh/health"]);
    assert.deepEqual(ideas.impactOf("§mesh/retry", m), ["§mesh/health", "§sova/dash"]);
    assert.deepEqual(ideas.ideaDetail("§mesh/retry", dir)?.linkedBy, ["§mesh/health"]);
  });

  test("the ToC groups by namespace, main entries each followed by their sub-entries, with every status counted", () => {
    const dir = build();
    ideas.updateIdea("sova/alone", { status: "dropped" }, dir);
    const info = ideas.ideasInfo(dir);
    assert.equal(info.toc.total, 5);
    assert.deepEqual(info.toc.namespaces.map((x) => x.ns), ["mesh", "sova"]);
    assert.deepEqual(info.toc.namespaces[0]!.entries.map((e) => e.id), ["§mesh/health", "§mesh/retry", "§mesh.retry/jitter"]);
    assert.deepEqual(info.toc.namespaces[1]!.counts, { open: 1, exploring: 0, started: 0, done: 0, dropped: 1 });
    assert.deepEqual(info.edges.find((e) => e.from === "§sova/dash"), { from: "§sova/dash", to: "§mesh/health" });
  });

  test("search ranks by shared words, title and tags first; the similar-idea scan", () => {
    const dir = fresh();
    ideas.addIdea({ id: "mesh/retry-backoff", title: "Retry failed peers with backoff", tags: ["reliability"] }, dir);
    ideas.addIdea({ id: "mesh/peer-list", title: "Show the peer list", text: "Maybe retry counts too." }, dir);
    ideas.addIdea({ id: "sova/themes", title: "More themes" }, dir);
    const hits = ideas.searchIdeas("it'd be nice if peers retried with a backoff", {}, dir);
    assert.deepEqual(hits.map((h) => h.record.id), ["§mesh/retry-backoff", "§mesh/peer-list"]);
    assert.deepEqual(ideas.searchIdeas("backoff", { ns: "sova" }, dir), []);
    assert.deepEqual(ideas.searchIdeas("the and of", {}, dir), [], "stop words alone match nothing");
  });
});

describe("the prompt's ToC", () => {
  test("one short line per namespace: counts and entry names, never titles or prose; explorers marked for this conversation only", () => {
    const dir = fresh();
    ideas.addIdea({ id: "mesh/retry", title: "SECRET-TITLE", text: "SECRET-PROSE" }, dir);
    ideas.addIdea({ id: "mesh.retry/jitter", title: "J" }, dir);
    ideas.addIdea({ id: "sova/done-one", title: "D" }, dir);
    ideas.updateIdea("sova/done-one", { status: "done" }, dir);
    ideas.updateIdea("mesh/retry", { explorer: { id: "ag_07", overseerId: "ov-now" } }, dir);
    const m = ideas.readManifest(dir);
    const toc = ideas.promptToc(m, "ov-now");
    assert.equal(toc, "- §mesh (1 open, 1 exploring): retry (exploring) [explorer ag_07], retry/jitter\n- §sova (1 done)");
    assert.doesNotMatch(toc, /SECRET/);
    assert.doesNotMatch(ideas.promptToc(m, "ov-old"), /explorer ag_07/, "another conversation's explorer is not this one's");
    assert.equal(ideas.promptToc(m, "ov-now"), toc, "the same store renders the same bytes");
    assert.equal(ideas.promptToc(ideas.readManifest(fresh()), "x"), "(no ideas yet)");
    assert.ok(!existsSync(join(dir, "manifest.json.tmp")));
  });
});
