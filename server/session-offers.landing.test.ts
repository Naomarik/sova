// The Landing card's docs (al_4, §chat.offers/sova-landing): one line of counts with the promises' names one click
// away; Land It records the drafts as the card SHOWED them (BRIEF a14), so a draft changed between show and click
// still holds the branch; after such a change the card shows again at the same commit, saying which drafts changed.
// Readiness, git and the captain's session are stubbed through setOfferDeps; the files and the store are real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-offers-landing-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));

const offers = await import("./session-offers");
const { goAheadFor } = await import("../pi-config/extensions/worktrees/landing.ts");

const project = join(root, "project");
mkdirSync(join(project, ".sova"), { recursive: true });
writeFileSync(join(project, ".sova", "offers.json"), readFileSync(new URL("../.sova/offers.json", import.meta.url), "utf8"));
const landingFile = () => join(root, "agent", "sova", "landing.json");

let head = "a".repeat(40);
let landingTree: Record<string, unknown> | null = null;
const requests: { url: string; body: unknown }[] = [];
let n = 0;
const sid = () => `01a0ffff-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const pathOf = (id: string) => join(root, "sessions", `x_${id}.jsonl`);

beforeEach(() => {
  landingTree = null;
  requests.length = 0;
  offers.setOfferDeps({
    async summary(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1] ?? "nope";
      return { id, path, cwd: project, title: `Session ${id}`, lastActiveAt: 1 } as unknown as SessionSummary;
    },
    async readiness() {
      return landingTree ? ({ trees: [landingTree], since: 0 } as unknown as SessionSummary["readiness"]) : undefined;
    },
    async sessions() {
      return [];
    },
    async head(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1];
      return id ? { id, cwd: project } : null;
    },
    async request(url, init) {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
    async projects() {
      return [{ id: "p_1", root: project }];
    },
    async git(args) {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n` };
      if (args.includes("refs/heads/feat/x^{commit}")) return { code: 0, stdout: `${head}\n` };
      if (args.includes("--abbrev-ref")) return { code: 0, stdout: "feat/x\n" };
      if (args.includes("refs/heads/master")) return { code: 0, stdout: "x\n" };
      if (args[0] === "status") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    },
  });
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const put = (rel: string, text: string) => { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); };
/** Two drafts not yet official: a draft.json whose base differs from its spec/ (the file-only reader's "pending"). */
function twoDrafts() {
  rmSync(join(project, ".sova", "spec"), { recursive: true, force: true });
  put(".sova/spec/claims/a.md", "old");
  for (const name of ["alpha", "beta"]) {
    put(`.sova/spec/drafts/${name}/draft.json`, JSON.stringify({ format: "sova-spec-draft/1", name, base: { files: { "claims/a.md": sha("old") } } }));
    put(`.sova/spec/drafts/${name}/spec/claims/a.md`, `new from ${name}`);
  }
}
/** The drafts hash from its definition, independently of the server's code. */
function hashOf(): { hash: string; names: string[]; each: Record<string, string> } {
  const by: Record<string, string[]> = {};
  const dir = join(project, ".sova/spec/drafts");
  for (const name of readdirSync(dir).filter((x) => !x.startsWith(".")).sort()) {
    const lines: string[] = (by[name] = []);
    const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = rel ? `${rel}/${e.name}` : e.name; e.isDirectory() ? walk(join(d, e.name), p) : lines.push(`${name}/${p} ${sha(readFileSync(join(d, e.name)))}`); } };
    walk(join(dir, name, "spec"), "");
  }
  const h = (l: string[]) => sha([...l].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n"));
  return { hash: h(Object.values(by).flat()), names: Object.keys(by), each: Object.fromEntries(Object.entries(by).map(([k, l]) => [k, h(l)])) };
}
const ready = (docs: Record<string, unknown>) => ({ path: project, branch: "feat/x", state: "ready", landing: { state: "ready", commit: head, drafts: ["alpha", "beta"], docs } });
const show = (owner: string, captain: string) => offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
const labels = (card: { buttons: { label: string }[] }) => card.buttons.map((b) => b.label);

test("Ready to land with docs: the card's one line of counts, the § names behind it, Land It on the card", async () => {
  twoDrafts();
  head = "1".repeat(40);
  landingTree = ready({ drafts: 2, added: 2, changed: 1, names: ["§x/a", "§x/b", "§x/c"] });
  const card = await show(sid(), sid());
  assert.equal(card.docs?.line, "Lands with its docs: 2 new promises, 1 changed");
  assert.deepEqual(card.docs?.names, ["§x/a", "§x/b", "§x/c"]);
  assert.ok(!card.docs!.line.includes("§"), "names stay one click away, never in the line");
  assert.equal(labels(card)[0], "Land It", "Land It no longer needs every draft promoted");
});

test("the counts read right in the singular and with only one kind", async () => {
  twoDrafts();
  for (const [i, [added, changed, line]] of ([[1, 0, "Lands with its docs: 1 new promise"], [0, 1, "Lands with its docs: 1 changed"], [3, 2, "Lands with its docs: 3 new promises, 2 changed"]] as const).entries()) {
    head = String(i + 2).repeat(40);
    landingTree = ready({ drafts: 1, added, changed, names: ["§x/a"] });
    assert.equal((await show(sid(), sid())).docs?.line, line);
  }
});

test("docs that don't fit: no Land It; Merge Without Specs… only once the chat said why", async () => {
  twoDrafts();
  head = "6".repeat(40);
  const specs = (more: Record<string, unknown> = {}) => ({ path: project, branch: "feat/x", state: "ready", landing: { state: "specs", commit: head, drafts: ["alpha", "beta"], docs: { drafts: 2, added: 1, changed: 0, names: ["§x/a"], problems: ["§x/a (draft alpha): §x/a has no verification note from its chat"] }, ...more } });
  landingTree = specs();
  await assert.rejects(show(sid(), sid()), /ready to land/);
  landingTree = specs({ specsWhy: "the clash needs the user" });
  const card = await show(sid(), sid());
  assert.ok(!labels(card).includes("Land It"), `no Land It when the docs don't fit: ${labels(card)}`);
  assert.ok(labels(card).includes("Merge Without Specs…"));
});

test("a14: Land It records the drafts as the card showed them, even if a draft changed before the click", async () => {
  twoDrafts();
  head = "7".repeat(40);
  landingTree = ready({ drafts: 2, added: 1, changed: 0, names: ["§x/a"] });
  const owner = sid();
  const shown = hashOf();
  const card = await show(owner, sid());
  put(".sova/spec/drafts/beta/spec/claims/a.md", "beta changed after the card was shown");
  assert.notEqual(hashOf().hash, shown.hash, "the fixture really changed a draft");
  await offers.chooseOffer(pathOf(owner), owner, card.id, labels(card).indexOf("Land It"));
  const go = goAheadFor("feat/x", head, landingFile());
  assert.equal(go?.by, "land-it");
  assert.deepEqual(go?.drafts, shown, "the drafts the user saw, by the definition: hash, names, each");
});

test("a14: after a Land It whose drafts changed since, the card shows again at the same commit saying which, once per set of drafts", async () => {
  twoDrafts();
  head = "8".repeat(40);
  landingTree = ready({ drafts: 2, added: 1, changed: 0, names: ["§x/a"] });
  const owner = sid();
  const captain = sid();
  const first = await show(owner, captain);
  await offers.chooseOffer(pathOf(owner), owner, first.id, labels(first).indexOf("Land It"));
  await assert.rejects(show(owner, captain), /already shown/, "the same drafts: shown once at this commit");

  put(".sova/spec/drafts/beta/spec/claims/a.md", "beta rewritten after Land It");
  landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "specs", commit: head, drafts: ["alpha", "beta"], docs: { drafts: 2, added: 1, changed: 0, names: ["§x/a"], changedSinceGoAhead: ["beta"] } } };
  const again = await show(owner, captain);
  assert.equal(again.title, first.title, "the same commit's card");
  assert.ok(again.docs?.line.startsWith("Its docs changed since your Land It: beta."), again.docs?.line);
  assert.ok(!again.docs!.line.includes("alpha"), "only the changed draft");
  assert.ok(labels(again).includes("Land It"), "the user can answer again");
  await assert.rejects(show(owner, captain), /already shown/, "once per set of drafts");
  await offers.chooseOffer(pathOf(owner), owner, again.id, labels(again).indexOf("Land It"));
  assert.deepEqual(goAheadFor("feat/x", head, landingFile())?.drafts, hashOf(), "the new press covers the drafts as they are now");
});
