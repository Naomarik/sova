// Session offers on the server (§chat/offers): the snapshot a session's tool is built from, every rule a show
// checks against the file as it is now, clicks (send, run, Not Now), run-button approval, the agent's note and
// the asks-you fold. What the rest of the server answers (summaries, readiness, git, the routes a button
// calls) is stubbed through setOfferDeps; the store and the files are real, in a throwaway agent dir.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-offers-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));

const offers = await import("./session-offers");
const trust = await import("./session-offers-trust");
const { sessionOfferTools } = await import("./session-offers-tool");

const project = join(root, "project");
mkdirSync(join(project, ".sova"), { recursive: true });
const send = (label: string, text = label.toLowerCase(), extra: Record<string, unknown> = {}) => ({ label, about: `${label} it.`, send: text, ...extra });
const def = (over: Record<string, unknown> = {}) => ({ when: "When it is time.", title: "Merge {branch} into {base}?", buttons: [send("Merge", "merge it"), send("Not Yet")], ...over });
const writeOffers = (o: Record<string, unknown>) => writeFileSync(join(project, ".sova", "offers.json"), JSON.stringify({ version: 1, offers: o }));

let head = "a".repeat(40);
let summaryOver: Partial<SessionSummary> = {};
let readinessState: string | null = null;
let landingTree: Record<string, unknown> | null = null;
const requests: { url: string; body: unknown }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
let n = 0;
const sid = () => `01a00000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const pathOf = (id: string) => join(root, "sessions", `x_${id}.jsonl`);
const summaries = new Map<string, Partial<SessionSummary>>();

beforeEach(() => {
  head = "a".repeat(40);
  summaryOver = {};
  readinessState = null;
  landingTree = null;
  requests.length = 0;
  answer = { status: 200, body: { ok: true } };
  offers.setOfferDeps({
    async summary(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1] ?? "nope";
      return { id, path, cwd: project, title: `Session ${id}`, lastActiveAt: 1, ...summaries.get(path), ...summaryOver } as SessionSummary;
    },
    async readiness() {
      if (landingTree) return { trees: [landingTree], since: 0 } as unknown as SessionSummary["readiness"];
      return readinessState ? ({ trees: [{ path: project, branch: "feat/x", state: readinessState }], since: 0 } as unknown as SessionSummary["readiness"]) : undefined;
    },
    async sessions() {
      return [];
    },
    async head(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1];
      const o = summaries.get(path) as (Partial<SessionSummary> & { started?: boolean }) | undefined;
      return id ? { id, cwd: project, ...(o?.parent ? { parent: o.parent } : {}), ...(o?.started ? { started: true } : {}) } : null;
    },
    async request(url, init) {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    },
    async projects() {
      return [{ id: "p_1", root: project }];
    },
    async git(args) {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n` };
      // The branch's own head (a once-per-commit card's check, §chat.offers/card).
      if (args.includes("refs/heads/feat/x^{commit}")) return { code: 0, stdout: `${head}\n` };
      if (args.includes("--abbrev-ref")) return { code: 0, stdout: "feat/x\n" };
      if (args.includes("refs/heads/master")) return { code: 0, stdout: "x\n" };
      if (args[0] === "status") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    },
  });
});

const show = (id: string, offer: string, extra: Partial<Parameters<typeof offers.showOffer>[0]> = {}) => offers.showOffer({ path: pathOf(id), sessionId: id, offer, by: "agent", ...extra });
const refused = async (p: Promise<unknown>, re: RegExp) => {
  await assert.rejects(p, (err: Error) => {
    assert.ok(err instanceof offers.OfferRefusal, String(err));
    assert.match(err.message, re);
    assert.match(err.message, /Nothing was shown|Nothing was sent|Nothing ran|No such|no longer open/);
    return true;
  });
};

describe("the snapshot (b1's half in this process)", () => {
  test("taken at the first build and read ever after: a later edit of the file changes nothing", async () => {
    writeOffers({ alpha: def() });
    const id = sid();
    const s1 = await offers.offerSnapshotFor(id, pathOf(id), project);
    assert.deepEqual(s1?.offers.map((o) => o.name), ["alpha"]);
    writeOffers({ alpha: def(), charlie: def() });
    assert.deepEqual((await offers.offerSnapshotFor(id, pathOf(id), project))?.offers.map((o) => o.name), ["alpha"]);
    offers.resetOffersForTest();
    assert.deepEqual((await offers.offerSnapshotFor(id, pathOf(id), project))?.offers.map((o) => o.name), ["alpha"], "read back from the record");
    const tools = await sessionOfferTools(id, pathOf(id));
    assert.deepEqual(tools.map((t) => t.name), ["offer"]);
    assert.deepEqual(((tools[0]!.parameters as { properties: { offer: { enum: string[] } } }).properties.offer.enum), ["alpha"]);
    // A new session reads the file as it is now.
    const fresh = sid();
    assert.deepEqual((await offers.offerSnapshotFor(fresh, pathOf(fresh), project))?.offers.map((o) => o.name), ["alpha", "charlie"]);
  });

  test("none is recorded too: a file added later never gives an older session the tool", async () => {
    rmSync(join(project, ".sova", "offers.json"), { force: true });
    const id = sid();
    assert.equal(await offers.offerSnapshotFor(id, pathOf(id), project), null);
    writeOffers({ alpha: def() });
    assert.equal(await offers.offerSnapshotFor(id, pathOf(id), project), null);
    assert.deepEqual(await sessionOfferTools(id, pathOf(id)), []);
  });

  test("a show or Not Now before the first build doesn't stand for a snapshot", async () => {
    writeOffers({ alpha: def(), captain: def({ shownBy: "another-chat" }) });
    const id = sid();
    await offers.showOffer({ path: pathOf(id), offer: "captain", by: "another-chat" });
    offers.setNotNow(id, pathOf(id), "alpha", true);
    assert.equal(offers.recordedSnapshot(id), undefined);
    assert.deepEqual((await offers.offerSnapshotFor(id, pathOf(id), project))?.offers.map((o) => o.name), ["alpha"]);
    assert.equal((await offers.sessionOffers(id, project)).cards.length, 1, "the cards it had stay");
  });

  test("a session that talked before it had a record gets none, never the file as it is now", async () => {
    writeOffers({ alpha: def() });
    const id = sid();
    summaries.set(pathOf(id), { started: true } as Partial<SessionSummary>);
    assert.equal(await offers.offerSnapshotFor(id, pathOf(id), project), null);
    assert.equal(offers.recordedSnapshot(id), null, "none is recorded");
  });

  test("a fork starts with its parent's snapshot", async () => {
    writeOffers({ alpha: def() });
    const parent = sid();
    await offers.offerSnapshotFor(parent, pathOf(parent), project);
    writeOffers({ alpha: def(), charlie: def() });
    const child = sid();
    summaries.set(pathOf(child), { parent: pathOf(parent) } as Partial<SessionSummary>);
    assert.deepEqual((await offers.offerSnapshotFor(child, pathOf(child)))?.offers.map((o) => o.name), ["alpha"]);
  });
});

describe("showing an offer", () => {
  test("shows a card with the file's title and buttons, filled from Sova's facts", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    const card = await show(id, "merge", { note: "All checks passed." });
    assert.equal(card.id, "of_1");
    assert.equal(card.title, "Merge feat/x into master?");
    assert.equal(card.note, "All checks passed.");
    assert.deepEqual(card.buttons.map((b) => [b.label, b.kind]), [["Merge", "send"], ["Not Yet", "send"]]);
    assert.equal(card.state, "open");
    assert.equal(JSON.stringify(card).includes("merge it"), false, "the send text stays on the server");
  });

  test("the repeat guard: once per commit by default; a new commit shows it again once the first is answered", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    await show(id, "merge");
    await refused(show(id, "merge"), /already shown for this commit/);
    await offers.chooseOffer(pathOf(id), id, "of_1", 1);
    head = "b".repeat(40);
    const second = await show(id, "merge");
    assert.equal(second.id, "of_2");
    const cards = (await offers.sessionOffers(id, project)).cards;
    assert.deepEqual(cards.map((c) => [c.id, c.state]), [["of_1", "chosen"], ["of_2", "open"]]);
  });

  test("a once-per-commit card can't be pressed once its branch moved on: refused, nothing sent or recorded; a show at the new head replaces it", async () => {
    writeFileSync(join(project, ".sova", "offers.json"), readFileSync(new URL("../.sova/offers.json", import.meta.url), "utf8"));
    rmSync(join(project, ".sova", "spec"), { recursive: true, force: true });
    const landing = join(root, "agent", "sova", "landing.json");
    const { goAheadFor, readLanding } = await import("../pi-config/extensions/worktrees/landing.ts");
    const captain = sid();
    const owner = sid();
    const A = "1".repeat(40);
    const B = "2".repeat(40);
    head = A;
    landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "ready", commit: head } };
    const showLanding = () => offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
    const atA = await showLanding();
    assert.equal(atA.title, `Land feat/x at ${A.slice(0, 7)}?`);
    // The branch moves on to B: Land It at A is refused, and nothing reaches the captain or landing.json.
    head = B;
    await refused(offers.chooseOffer(pathOf(owner), owner, atA.id, 0), /newer commit/);
    await refused(offers.chooseOffer(pathOf(owner), owner, atA.id, 1), /no longer open/);
    assert.equal(requests.length, 0, "nothing sent");
    assert.equal(await goAheadFor("feat/x", A, landing), undefined, "no go-ahead at A");
    assert.equal(await goAheadFor("feat/x", B, landing), undefined, "nor at B");
    assert.equal(readLanding(landing).notYet.some((n) => n.commit === A || n.commit === B), false, "no Not Yet");
    assert.equal((await offers.sessionOffers(owner, project)).cards.find((c) => c.id === atA.id)?.state, "superseded");
    // Shown at B while A's card were still open: A's is replaced and B's shows at once.
    head = A;
    const other = sid();
    const first = await offers.showOffer({ path: pathOf(other), sessionId: other, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
    head = B;
    landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "ready", commit: head } };
    const atB = await offers.showOffer({ path: pathOf(other), sessionId: other, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
    assert.equal(atB.title, `Land feat/x at ${B.slice(0, 7)}?`);
    const cards = (await offers.sessionOffers(other, project)).cards;
    assert.deepEqual(cards.map((c) => [c.id, c.state, c.supersededBy ?? null]), [[first.id, "superseded", atB.id], [atB.id, "open", null]]);
    await offers.chooseOffer(pathOf(other), other, atB.id, 0);
    assert.match((requests.at(-1)!.body as { text: string }).text, new RegExp(`^Go ahead: land feat/x at ${B.slice(0, 12)}\\.$`));
    assert.equal((await goAheadFor("feat/x", B, landing))?.session, other);
  });

  test("a click whose branch head can't be read is refused and leaves the card open", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    const card = await show(id, "merge");
    offers.setOfferDeps({ git: async (args) => (args[0] === "rev-parse" && args.includes("refs/heads/feat/x^{commit}") ? { code: 1, stdout: "" } : { code: 0, stdout: "" }) });
    await refused(offers.chooseOffer(pathOf(id), id, card.id, 0), /can't read feat\/x/);
    assert.equal(requests.length, 0);
  });

  test("while another offer is open, a new one shows nothing and the refusal names the open one", async () => {
    writeOffers({ a: def({ title: "Offer A?" }), b: def({ title: "Offer B?" }) });
    const id = sid();
    const a = await show(id, "a");
    await refused(show(id, "b"), /"a".*open|open.*"a"/);
    const cards = (await offers.sessionOffers(id, project)).cards;
    assert.deepEqual(cards.map((c) => [c.id, c.name, c.state]), [[a.id, "a", "open"]], "A stays open; B was never recorded");
  });

  test("once per session and once per reply", async () => {
    writeOffers({ s: def({ repeat: "once-per-session" }), r: def({ repeat: "once-per-reply" }) });
    const id = sid();
    await show(id, "s");
    head = "c".repeat(40);
    await refused(show(id, "s"), /in this session/);
    await offers.chooseOffer(pathOf(id), id, "of_1", 1);
    const r1 = await show(id, "r", { replyId: "u1" });
    await refused(show(id, "r", { replyId: "u1" }), /for this reply/);
    await offers.chooseOffer(pathOf(id), id, r1.id, 1);
    await show(id, "r", { replyId: "u2" });
  });

  test("refused, showing nothing: gone, disabled, broken, another chat's, an open alignment, a failed condition", async () => {
    writeOffers({ merge: def(), off: def({ disabled: true }), bad: def({ nope: 1 }), captain: def({ shownBy: "another-chat" }), ready: def({ onlyIf: ["branch-ready"] }) });
    const id = sid();
    await refused(show(id, "gone"), /not an offer in this project's/);
    await refused(show(id, "off"), /not an offer in this project's/);
    await refused(show(id, "bad"), /not an offer in this project's/);
    await refused(show(id, "captain"), /Only another chat shows/);
    summaryOver = { align: { openDocs: 1, openQuestions: 2 } } as Partial<SessionSummary>;
    await refused(show(id, "merge"), /open alignment question/);
    summaryOver = {};
    readinessState = "in-progress";
    await refused(show(id, "ready"), /ready to merge/);
    readinessState = "ready";
    assert.equal((await show(id, "ready")).state, "open");
    assert.equal((await offers.sessionOffers(id, project)).cards.length, 1, "only the one that showed was recorded");
  });

  test("Not Now: the open card reads Not now and the offer is refused for the rest of the session; unsnooze lets it back", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    await show(id, "merge");
    offers.setNotNow(id, pathOf(id), "merge", true);
    assert.equal((await offers.sessionOffers(id, project)).cards[0]!.state, "not-now");
    head = "d".repeat(40);
    await refused(show(id, "merge"), /chose Not Now/);
    offers.setNotNow(id, pathOf(id), "merge", false);
    assert.equal((await show(id, "merge")).state, "open");
  });

  test("another chat shows one; a button sending to it needs from", async () => {
    writeOffers({ landing: def({ shownBy: "another-chat", buttons: [send("Land It", "go", { to: "shower" }), send("Not Yet")] }) });
    const id = sid();
    const captain = sid();
    await refused(offers.showOffer({ path: pathOf(id), offer: "landing", by: "another-chat" }), /name that chat with from/);
    const card = await offers.showOffer({ path: pathOf(id), offer: "landing", by: "another-chat", from: pathOf(captain) });
    assert.deepEqual(card.from, { id: captain, title: `Session ${captain}` });
    await offers.chooseOffer(pathOf(id), id, card.id, 0);
    assert.deepEqual(requests.at(-1), { url: "/api/sessions/prompt", body: { path: pathOf(captain), text: "go", delivery: "followUp" } }, "Land It goes to the captain");
  });
});

describe("clicks", () => {
  test("a send button sends its text as the user's message, records the choice once, counts a use", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    const card = await show(id, "merge");
    const chosen = await offers.chooseOffer(pathOf(id), id, card.id, 0);
    assert.deepEqual(requests, [{ url: "/api/sessions/prompt", body: { path: pathOf(id), text: "merge it", delivery: "followUp" } }]);
    assert.equal(chosen.state, "chosen");
    assert.equal(chosen.choice?.label, "Merge");
    await assert.rejects(offers.chooseOffer(pathOf(id), id, card.id, 1), /no longer open/);
    const list = offers.projectOffers(project).offers.find((o) => o.name === "merge")!;
    assert.ok(list.shown >= 1 && list.used >= 1);
  });

  test("two clicks at once on one card send its message once", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    const card = await show(id, "merge");
    const results = await Promise.allSettled([offers.chooseOffer(pathOf(id), id, card.id, 0), offers.chooseOffer(pathOf(id), id, card.id, 0)]);
    assert.equal(requests.length, 1, `sent once: ${JSON.stringify(requests)}`);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((await offers.sessionOffers(id, project)).cards[0]!.state, "chosen");
  });

  test("a send the route refuses leaves the card open, with the route's words", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    const card = await show(id, "merge");
    answer = { status: 409, body: { error: "This session is open in a TUI." } };
    await assert.rejects(offers.chooseOffer(pathOf(id), id, card.id, 0), /open in a TUI/);
    assert.equal((await offers.sessionOffers(id, project)).cards[0]!.state, "open");
  });

  test("an offer removed from the file stops at once: its open card is withdrawn and a click sends nothing", async () => {
    writeOffers({ merge: def(), other: def() });
    const id = sid();
    const card = await show(id, "merge");
    writeOffers({ other: def() });
    await assert.rejects(offers.chooseOffer(pathOf(id), id, card.id, 0), /no longer in the project's/);
    assert.equal(requests.length, 0);
    assert.equal((await offers.sessionOffers(id, project)).cards[0]!.state, "withdrawn");
  });

  test("a run button needs the file's run buttons approved, runs its catalogue action with Sova's facts, and notes the outcome", async () => {
    writeOffers({ merge: def({ buttons: [{ label: "Merge", about: "Merges now.", run: "project.worktree.merge" }, send("Not Yet")] }) });
    const id = sid();
    await refused(show(id, "merge"), /run buttons the user hasn't approved/);
    const file = offers.readOffersFile(project);
    assert.throws(() => trust.approveRuns(project, file, "stale"), /changed since they were shown/);
    trust.approveRuns(project, file, trust.runFingerprint(file));
    const card = await show(id, "merge");
    assert.equal(offers.offerNoteFor(id), null);
    const chosen = await offers.chooseOffer(pathOf(id), id, card.id, 0);
    assert.deepEqual(requests, [{ url: "/api/projects/p_1/overseer/worktrees/merge", body: { sessionId: id } }]);
    assert.deepEqual(chosen.outcome, { state: "done", text: "Merge Worktree done." });
    assert.match(offers.offerNoteFor(id)!, /of_1 \(merge\): the user pressed "Merge"\. It ran: Merge Worktree done\./);
    // A changed run button asks again; a changed about line does not.
    writeOffers({ merge: def({ buttons: [{ label: "Merge", about: "Merges it now, really.", run: "project.worktree.merge" }, send("Not Yet")] }) });
    assert.equal(trust.runsApproved(project, offers.readOffersFile(project)), true);
    writeOffers({ merge: def({ buttons: [{ label: "Merge Now", about: "Merges now.", run: "project.worktree.merge" }, send("Not Yet")] }) });
    assert.equal(trust.runsApproved(project, offers.readOffersFile(project)), false);
  });

  test("a failed run says so on the card and in the note", async () => {
    writeOffers({ merge: def({ buttons: [{ label: "Merge", about: "Merges now.", run: "project.worktree.merge" }] }) });
    const file = offers.readOffersFile(project);
    trust.approveRuns(project, file, trust.runFingerprint(file));
    const id = sid();
    const card = await show(id, "merge");
    answer = { status: 409, body: { error: "CONFLICT in a.ts" } };
    const chosen = await offers.chooseOffer(pathOf(id), id, card.id, 0);
    assert.deepEqual(chosen.outcome, { state: "failed", text: "CONFLICT in a.ts" });
    assert.match(offers.offerNoteFor(id)!, /It failed: CONFLICT in a\.ts/);
  });
});

describe("asks you, quietly", () => {
  test("an idle session with an open card asks; running, answered or withdrawn, it doesn't", async () => {
    writeOffers({ merge: def() });
    const id = sid();
    assert.equal(offers.withOpenOffer(id, undefined, false), undefined);
    const card = await show(id, "merge");
    assert.deepEqual(offers.withOpenOffer(id, undefined, false)?.kinds, ["asks-you"]);
    assert.equal(offers.withOpenOffer(id, undefined, true), undefined, "mid-turn: not yet");
    assert.deepEqual(offers.openOfferOf(id) && { title: offers.openOfferOf(id)!.title }, { title: "Merge feat/x into master?" }, "the digest's Needs you item reads it, idle or working");
    await offers.chooseOffer(pathOf(id), id, card.id, 1);
    assert.equal(offers.withOpenOffer(id, undefined, false), undefined);
    head = "e".repeat(40);
    await show(id, "merge");
    writeOffers({});
    assert.equal(offers.withOpenOffer(id, undefined, false), undefined, "removed from the file: no longer offered");
  });
});

describe("the project page's list", () => {
  test("each offer with its state, buttons and counts; a broken one with its reason; runs and their approval", () => {
    writeOffers({ merge: def({ buttons: [{ label: "Merge", about: "Merges now.", run: "project.worktree.merge" }] }), bad: def({ nope: 1 }), off: def({ disabled: true }) });
    const a = offers.projectOffers(project);
    assert.equal(a.file, "ok");
    assert.deepEqual(a.offers.map((o) => [o.name, o.state]), [["merge", "ok"], ["bad", "broken"], ["off", "disabled"]]);
    assert.match(a.offers[1]!.error!, /unknown key "nope"/);
    assert.deepEqual(a.runs?.buttons, [{ offer: "merge", label: "Merge", run: "project.worktree.merge" }]);
    writeFileSync(join(project, ".sova", "offers.json"), "{");
    assert.equal(offers.projectOffers(project).file, "broken");
    rmSync(join(project, ".sova", "offers.json"));
    assert.equal(offers.projectOffers(project).file, "missing");
  });
});

describe("the Landing offer (§chat.offers/sova-landing, §chat.offers/buttons)", () => {
  const sovaFile = () => writeFileSync(join(project, ".sova", "offers.json"), readFileSync(new URL("../.sova/offers.json", import.meta.url), "utf8"));
  const landingFile = () => join(root, "agent", "sova", "landing.json");
  const drafts = (on: boolean) => {
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const d = join(project, ".sova", "spec", "drafts", "my-draft");
    rmSync(join(project, ".sova", "spec"), { recursive: true, force: true });
    if (!on) return;
    mkdirSync(join(d, "spec", "claims"), { recursive: true });
    mkdirSync(join(project, ".sova", "spec", "claims"), { recursive: true });
    writeFileSync(join(project, ".sova", "spec", "claims", "a.md"), "old");
    writeFileSync(join(d, "draft.json"), JSON.stringify({ format: "sova-spec-draft/1", name: "my-draft", base: { files: { "claims/a.md": sha("old") } } }));
    writeFileSync(join(d, "spec", "claims", "a.md"), "new");
  };

  test("shown for the worktree when Ready to land; Land It records the go-ahead for that exact commit and sends it to the captain", async () => {
    sovaFile();
    drafts(false);
    const captain = sid();
    const owner = sid();
    landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "ready", commit: head } };
    const card = await offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
    assert.equal(card.title, `Land feat/x at ${head.slice(0, 7)}?`);
    assert.deepEqual(card.buttons.map((b) => b.label), ["Land It", "Not Yet"], "Merge Without Specs… is off the card: no draft is left");
    await offers.chooseOffer(pathOf(owner), owner, card.id, 0);
    assert.equal((requests.at(-1)!.body as { path: string }).path, pathOf(captain));
    assert.match((requests.at(-1)!.body as { text: string }).text, /^Go ahead: land feat\/x at a{12}\.$/);
    const { goAheadFor } = await import("../pi-config/extensions/worktrees/landing.ts");
    assert.equal((await goAheadFor("feat/x", head, landingFile()))?.session, owner);
    assert.equal(await goAheadFor("feat/x", "b".repeat(40), landingFile()), undefined);
  });

  test("not Ready to land: nothing is shown; Not Yet records Not Yet; a refused send records nothing", async () => {
    sovaFile();
    drafts(false);
    const captain = sid();
    const owner = sid();
    landingTree = { path: project, branch: "feat/x", state: "waiting-approval" };
    await refused(offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project }), /ready to land/);
    head = "c".repeat(40);
    landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "ready", commit: head } };
    const card = await offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
    answer = { status: 409, body: { error: "busy" } };
    await assert.rejects(offers.chooseOffer(pathOf(owner), owner, card.id, 1), /busy/);
    const { readLanding } = await import("../pi-config/extensions/worktrees/landing.ts");
    assert.equal(readLanding(landingFile()).notYet.some((n) => n.commit === head), false);
    answer = { status: 200, body: { ok: true } };
    await offers.chooseOffer(pathOf(owner), owner, card.id, 1);
    assert.equal(readLanding(landingFile()).notYet.some((n) => n.commit === head && n.branch === "feat/x"), true);
  });

  test("specs left and the session says why: Merge Without Specs… asks first, naming the drafts, and records the go-ahead without specs", async () => {
    sovaFile();
    drafts(true);
    head = "d".repeat(40);
    const captain = sid();
    const owner = sid();
    landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "specs", commit: head, drafts: ["my-draft"] } };
    await refused(offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project }), /ready to land/);
    landingTree = { path: project, branch: "feat/x", state: "ready", landing: { state: "specs", commit: head, drafts: ["my-draft"], specsWhy: "no spec tools" } };
    const card = await offers.showOffer({ path: pathOf(owner), sessionId: owner, offer: "landing", by: "another-chat", from: pathOf(captain), tree: project });
    assert.deepEqual(card.buttons.map((b) => b.label), ["Merge Without Specs…", "Not Yet"]);
    assert.match(card.buttons[0]!.confirm ?? "", /^Land feat\/x without its specs\? These spec drafts stay behind, to promote later on a fresh branch from master: my-draft\.$/);
    await offers.chooseOffer(pathOf(owner), owner, card.id, 0);
    assert.match((requests.at(-1)!.body as { text: string }).text, /without its specs \(my-draft\)/);
    const { goAheadFor } = await import("../pi-config/extensions/worktrees/landing.ts");
    assert.equal((await goAheadFor("feat/x", head, landingFile()))?.withoutSpecs, true);
    drafts(false);
  });
});
