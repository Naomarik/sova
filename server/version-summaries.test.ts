// What a version changes (§app.project-assistant/versions, §app.owner-page/never's carve-out): written once per
// branch head by the title models (stood in), again when the branch moves, a failure retried after 30 minutes; the
// team's Rewrite, Use Automatic, Hide and Show; what the owner and the model get passes the outsider filter, and a
// hidden one never shows. A throwaway workspace; git facts and the model stood in.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-version-summaries-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "site"), { recursive: true });
const orgs = await import("./orgs");
const owner = await import("./owner");
const sums = await import("./version-summaries");
const { shownVersionSummary, versionRows } = await import("./owner-versions");
const { outsiderRedactor } = await import("./share/hub");
after(() => {
  sums.setSummaryWriter(null);
  sums.setBranchFactsForTest(null);
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach", voice: "Quietly negotiating the Falcon Holdings merger" });
const proj = await orgs.addProject(org.id, { name: "Archery website", root: join(root, "site") });

let head = "aaa111";
let asks: string[] = [];
let answer: string | null = "The bow page opens faster and shows prices in riyals.";
beforeEach(() => {
  asks = [];
  sums.setBranchFactsForTest(async () => ({ head, subjects: ["Speed up the bow page", "Show prices in SAR"], files: ["src/bow.tsx", "src/prices.ts"] }));
  sums.setSummaryWriter(async (prompt) => {
    asks.push(prompt);
    return answer;
  });
});
const fix = (id: string) => ({ current: false, rec: { id, checkout: join(root, "site") } as never, projectId: proj.id });

describe("writing them", () => {
  test("once per branch head, again when the branch moves; the Current version has none", async () => {
    await sums.refreshSummary(org.id, proj.id, fix("i_a"));
    await sums.refreshSummary(org.id, proj.id, fix("i_a"));
    assert.equal(asks.length, 1, "the same head is written once");
    assert.match(asks[0]!, /Speed up the bow page[\s\S]*src\/bow\.tsx/);
    assert.equal(sums.readSummaries(org.id, proj.id)["i_a"]?.auto?.head, "aaa111");
    head = "bbb222";
    answer = "Checkout takes one step instead of three.";
    await sums.refreshSummary(org.id, proj.id, fix("i_a"));
    assert.equal(sums.readSummaries(org.id, proj.id)["i_a"]?.auto?.text, "Checkout takes one step instead of three.");
    await sums.refreshSummary(org.id, proj.id, { ...fix("i_main"), current: true });
    assert.equal(sums.readSummaries(org.id, proj.id)["i_main"], undefined);
  });
  test("a failed write is tried again only after 30 minutes", async () => {
    answer = null;
    const t0 = Date.now();
    await sums.refreshSummary(org.id, proj.id, fix("i_b"), t0);
    await sums.refreshSummary(org.id, proj.id, fix("i_b"), t0 + 60_000);
    assert.equal(asks.length, 1);
    answer = "A clearer search box.";
    await sums.refreshSummary(org.id, proj.id, fix("i_b"), t0 + sums.RETRY_MS + 1);
    assert.equal(sums.readSummaries(org.id, proj.id)["i_b"]?.auto?.text, "A clearer search box.");
  });
  test("a model's answer that isn't a plain sentence is refused; the ask fences the branch's words as data", () => {
    assert.equal(sums.validSummary("ok"), null);
    assert.equal(sums.validSummary("<script>x</script> new things"), null);
    assert.equal(sums.validSummary("  A faster   page.\n"), "A faster page.");
    assert.match(sums.summaryPrompt({ head: "h", subjects: ["a ``` b"], files: [] }), /~~~~\na ``` b\n~~~~/);
  });
});

describe("the team's say, and what leaves", () => {
  test("Rewrite wins until Use Automatic; Hide hides either, Show brings it back; a bad body is refused for itself", () => {
    head = "ccc333";
    sums.setVersionSummary(org.id, proj.id, "i_c", { text: "  Our own   words.  " });
    assert.deepEqual(sums.shownSummary(sums.readSummaries(org.id, proj.id)["i_c"]), { text: "Our own words.", source: "team" });
    sums.setVersionSummary(org.id, proj.id, "i_c", { hidden: true });
    assert.equal(sums.shownSummary(sums.readSummaries(org.id, proj.id)["i_c"]), null);
    sums.setVersionSummary(org.id, proj.id, "i_c", { hidden: false, text: null });
    assert.equal(sums.shownSummary(sums.readSummaries(org.id, proj.id)["i_c"]), null, "no automatic one yet");
    assert.throws(() => sums.summaryPatchOf({ text: 3 }), /text is a string/);
    assert.throws(() => sums.summaryPatchOf({ hidden: "yes" }), /hidden is true or false/);
    assert.throws(() => sums.summaryPatchOf({ text: "   " }), /Write the summary first/);
    assert.throws(() => sums.summaryPatchOf({}), /Expected/);
    assert.throws(() => sums.setVersionSummary(org.id, proj.id, "../x", { hidden: true }), /Unknown version/);
  });
  test("what the owner and the model get passes the outsider filter; a hidden one never shows", async () => {
    answer = "It adds the page Kim wanted while quietly negotiating the Falcon Holdings merger.";
    head = "ddd444";
    await sums.refreshSummary(org.id, proj.id, fix("i_d"));
    const r = outsiderRedactor(org.id);
    const shown = shownVersionSummary(org.id, fix("i_d"), r)!;
    assert.ok(shown.length > 0 && !shown.includes("Falcon Holdings merger"), shown);
    const v = { ...fix("i_d"), handle: "v_x", projectName: proj.name, label: "Fix: x", state: "running" as const } as never;
    assert.ok(!JSON.stringify(versionRows([v], r, org.id)).includes("Falcon Holdings merger"));
    sums.setVersionSummary(org.id, proj.id, "i_d", { hidden: true });
    assert.equal(versionRows([v], r, org.id)[0]!.summary, undefined);
    assert.equal(shownVersionSummary(org.id, fix("i_d"), r), null);
  });
});
