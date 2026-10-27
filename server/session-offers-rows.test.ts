// Cards with rows (§chat.offers/card, Rows) and the Merge Captain's landing card (§chat.offers/landing-rows), against
// a real throwaway repository (branches, worktrees, clean master merges) and the real landing queue, offers store
// and landing.json in a throwaway agent dir. Summaries, readiness and the routes a send calls are stubbed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-offer-rows-")));
const agent = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agent;
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" });
after(() => rmSync(root, { recursive: true, force: true }));

const offers = await import("./session-offers");
const queue = await import("./landing-queue");
const landing = await import("../pi-config/extensions/worktrees/landing.ts");
const { registerSessionOfferRoutes } = await import("./session-offers-routes");
const { offerToolSpec } = await import("./session-offers-tool");
const shared = await import("../shared/session-offers");
// The driver's own writer of the user's word in the captain's chat (round.mjs go).
const round = (await import("../.sova/playbooks/merge-round/scripts/round.mjs" as string)) as { recordCaptainGoAhead: (file: string, r: { branch: string; commit: string; at: string; captain?: string; withoutSpecs?: boolean }) => void };

const repo = join(root, "repo");
const sessionsDir = join(agent, "sessions");
mkdirSync(sessionsDir, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string, subject = file) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-q", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
};
mkdirSync(join(repo, ".sova"), { recursive: true });
git(repo, "init", "-q", "-b", "master");
// Sova's own offers file, as this branch ships it.
writeFileSync(join(repo, ".sova", "offers.json"), readFileSync(new URL("../.sova/offers.json", import.meta.url), "utf8"));
git(repo, "add", ".sova/offers.json");
git(repo, "commit", "-q", "-m", "offers");
commit(repo, "README", "hello\n");

const pathOf = (id: string) => join(sessionsDir, `x_${id}.jsonl`);
const summaries = new Map<string, Partial<SessionSummary>>();
const session = (id: string, over: Partial<SessionSummary>) => {
  writeFileSync(pathOf(id), "");
  summaries.set(pathOf(id), { id, path: pathOf(id), title: `Session ${id}`, ...over });
};
const CAP = "cap";
session(CAP, { title: "Merge Captain", cwd: repo, profile: { id: "merge-captain" } as SessionSummary["profile"] });

let wts = 0;
/** A branch with a worktree and a commit of its own, owned by a new session; `drafts`: a spec draft left. */
function branch(name: string, drafts = false) {
  const tree = join(root, `wt-${++wts}`);
  git(repo, "worktree", "add", "-q", "-b", name, tree, "master");
  const head = commit(tree, `${name.replace(/\W/g, "-")}.txt`, `${name}\n`);
  if (drafts) mkdirSync(join(tree, ".sova", "spec", "drafts", "left-draft"), { recursive: true });
  const owner = `own-${wts}`;
  session(owner, { title: `Fix ${name}`, cwd: tree });
  return { name, tree, owner, head: () => git(repo, "rev-parse", `refs/heads/${name}`), first: head, drafts };
}

const requests: { url: string; body: { path?: string; text?: string } }[] = [];
beforeEach(() => {
  requests.length = 0;
  offers.setOfferDeps({
    async summary(path) {
      const s = summaries.get(path);
      return s ? ({ lastActiveAt: 1, ...s } as SessionSummary) : null;
    },
    async readiness(s) {
      const b = [...branches.values()].find((x) => x.tree === s.cwd);
      if (!b) return undefined;
      const landingState = b.drafts ? { state: "specs", specsWhy: "the spec tools refused", commit: b.head() } : { state: "ready", commit: b.head() };
      return { trees: [{ path: b.tree, branch: b.name, state: "ready", landing: landingState }], since: 0 } as unknown as SessionSummary["readiness"];
    },
    async sessions() {
      return [];
    },
    async request(url, init) {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
});
const branches = new Map<string, ReturnType<typeof branch>>();
const make = (name: string, drafts = false) => {
  const b = branch(name, drafts);
  branches.set(name, b);
  return b;
};

let qn = 0;
const queueFile = join(agent, "sova", "landing-queue.json");
const shownFile = join(agent, "sova", "landing-shown.json");
const entries: object[] = [];
/** The captain queues a branch (round.mjs ask), and Sova answers the queue. */
async function ask(b: ReturnType<typeof branch>) {
  entries.push({ id: `lq_${++qn}`, branch: b.name, path: b.tree, head: b.head(), owner: b.owner, captain: CAP, at: Date.now() });
  mkdirSync(join(agent, "sova"), { recursive: true });
  writeFileSync(queueFile, JSON.stringify({ v: 1, entries }));
  await queue.processLandingQueue({
    pathOf: async (id) => (summaries.has(pathOf(id)) ? pathOf(id) : undefined),
    summary: async (path) => (summaries.get(path) as SessionSummary) ?? null,
    queueFile: () => queueFile,
    shownFile: () => shownFile,
  });
  return queue.readShown(shownFile)[`lq_${qn}`]!;
}
const cards = async (id: string) => (await offers.sessionOffers(id, summaries.get(pathOf(id))!.cwd)).cards;
const captainCard = async () => (await cards(CAP)).filter((c) => c.rows).at(-1)!;
const ownerCard = async (b: ReturnType<typeof branch>) => (await cards(b.owner)).at(-1);
const rowOf = async (b: ReturnType<typeof branch>) => (await captainCard()).rows!.find((r) => r.branch === b.name)!;
const landingData = () => landing.readLanding(join(agent, "sova", "landing.json"));
/** Close whatever captain card is open, so the next test starts on a fresh one. */
async function closeCaptain() {
  const c = (await cards(CAP)).find((x) => x.state === "open" && x.rows);
  if (!c) return;
  for (const r of c.rows!) if (r.state === "open") await offers.chooseOffer(pathOf(CAP), CAP, c.id, r.buttons.findIndex((x) => x.label === "Not Yet"), r.id);
}

describe("the captain's landing card (§chat.offers/landing-rows)", () => {
  beforeEach(closeCaptain);

  test("a queued branch is a row; Land It there posts the go-ahead in the captain's chat, records it, and settles the owner's card 'in Merge Captain'", async () => {
    const b = make("feat/a");
    const shown = await ask(b);
    assert.ok("card" in shown && shown.row && "card" in shown.row, JSON.stringify(shown));
    const card = await captainCard();
    assert.equal(card.title, "Branches ready to land");
    const row = await rowOf(b);
    assert.deepEqual([row.branch, row.commit, row.owner, row.state], [b.name, b.first.slice(0, 7), { id: b.owner, title: "Fix feat/a" }, "open"]);
    assert.deepEqual(row.buttons.map((x) => x.label), ["Land It", "Not Yet"], "the owner card's buttons, no Not Now");
    assert.equal(offers.openOfferOf(CAP)?.title, "1 branch ready to land", "Needs you: listed once by its open rows");
    await offers.chooseOffer(pathOf(CAP), CAP, card.id, 0, row.id);
    assert.deepEqual(requests.map((r) => [r.body.path, r.body.text]), [[pathOf(CAP), `Go ahead: land feat/a at ${b.first.slice(0, 12)}.`]], "posted in the captain's chat as the user's message");
    const go = landing.goAheadFor(b.name, b.first, join(agent, "sova", "landing.json"));
    assert.deepEqual([go?.by, go?.in, go?.session], ["land-it", CAP, b.owner]);
    const own = await ownerCard(b);
    assert.equal(own?.state, "chosen");
    assert.deepEqual([own?.choice?.label, own?.choice?.where], ["Land It", "Merge Captain"]);
    assert.equal(offers.openOfferOf(b.owner), undefined, "the owner's Needs you item goes");
    assert.equal((await captainCard()).state, "chosen", "every row answered: the card closes");
    assert.equal(offers.openOfferOf(CAP), undefined);
  });

  test("the owner's Land It settles the captain's row, which says where", async () => {
    const b = make("feat/b");
    await ask(b);
    const own = (await ownerCard(b))!;
    await offers.chooseOffer(pathOf(b.owner), b.owner, own.id, 0);
    const row = await rowOf(b);
    assert.deepEqual([row.state, row.choice?.label, row.choice?.where], ["chosen", "Land It", "Fix feat/b"]);
    assert.equal(requests.length, 1, "one message: the owner card's own send");
  });

  test("a go-ahead typed in the owner's chat settles both, and so does the captain's go (b1)", async () => {
    const b = make("feat/c");
    await ask(b);
    landing.recordGoAhead({ branch: b.name, commit: b.first, session: b.owner, at: new Date().toISOString(), by: "owner-chat" }, join(agent, "sova", "landing.json"));
    assert.equal(offers.openOfferOf(b.owner), undefined, "Needs you drops the owner's card at once");
    assert.deepEqual([(await ownerCard(b))?.choice?.label, (await ownerCard(b))?.choice?.where], ["Land It", "this chat"]);
    assert.deepEqual([(await rowOf(b)).state, (await rowOf(b)).choice?.where], ["chosen", "Fix feat/c"]);
    // b1: round.mjs go writes the captain's word to landing.json; GET /api/session-offers for the owner reads it answered.
    const d = make("feat/c2");
    await ask(d);
    round.recordCaptainGoAhead(join(agent, "sova", "landing.json"), { branch: d.name, commit: d.first, at: new Date().toISOString(), captain: CAP });
    const app = new Hono();
    registerSessionOfferRoutes(app);
    const res = await app.request(`/api/session-offers?path=${encodeURIComponent(pathOf(d.owner))}`);
    assert.equal(res.status, 200);
    const got = ((await res.json()) as { cards: { state: string; choice?: { label: string; where?: string } }[] }).cards.at(-1)!;
    assert.deepEqual([got.state, got.choice?.label, got.choice?.where], ["chosen", "Land It", "Merge Captain"]);
    assert.deepEqual([(await rowOf(d)).state, (await rowOf(d)).choice?.where], ["chosen", "this chat"]);
    assert.equal(requests.length, 0, "settling sends nothing");
  });

  test("Not Yet on a row records Not Yet and sends nothing; the owner's card reads Not Yet in Merge Captain", async () => {
    const b = make("feat/d");
    await ask(b);
    const row = await rowOf(b);
    await offers.chooseOffer(pathOf(CAP), CAP, (await captainCard()).id, row.buttons.findIndex((x) => x.label === "Not Yet"), row.id);
    assert.equal(requests.length, 0, "the owner's chat is not told");
    assert.ok(landingData().notYet.some((n) => n.branch === b.name && n.commit === b.first && n.in === CAP));
    const own = await ownerCard(b);
    assert.deepEqual([own?.state, own?.choice?.label, own?.choice?.where], ["chosen", "Not Yet", "Merge Captain"]);
  });

  test("a waiting row whose branch got a new commit reads Replaced, and a click on it records nothing", async () => {
    const b = make("feat/e");
    await ask(b);
    const card = await captainCard();
    const row = await rowOf(b);
    commit(b.tree, "more.txt", "more\n");
    await assert.rejects(offers.chooseOffer(pathOf(CAP), CAP, card.id, 0, row.id), /newer commit.*Nothing was sent/);
    assert.equal((await rowOf(b)).state, "superseded");
    assert.equal(requests.length, 0);
    assert.equal(landing.goAheadFor(b.name, b.first, join(agent, "sova", "landing.json")), undefined, "no go-ahead recorded");
    await assert.rejects(offers.chooseOffer(pathOf(CAP), CAP, card.id, 0, row.id), /no longer open/);
  });

  test("b2: an answered row reads Landing after the check's clean master merge, never Replaced; Landed once in master", async () => {
    const b = make("feat/f");
    await ask(b);
    const card = await captainCard();
    await offers.chooseOffer(pathOf(CAP), CAP, card.id, 0, (await rowOf(b)).id);
    commit(repo, "master-moves.txt", "master moves\n");
    git(b.tree, "merge", "--no-edit", "-q", "master");
    assert.notEqual(b.head(), b.first, "the branch moved by a clean merge of master");
    const after = (await cards(CAP)).find((c) => c.id === card.id)!.rows!.find((r) => r.branch === b.name)!;
    assert.deepEqual([after.state, after.progress], ["chosen", "landing"]);
    git(repo, "merge", "--no-edit", "-q", b.name);
    const done = (await cards(CAP)).find((c) => c.id === card.id)!.rows!.find((r) => r.branch === b.name)!;
    assert.deepEqual([done.state, done.progress], ["chosen", "landed"]);
  });

  test("Land All asks naming each branch@commit, skips a row that needs Merge Without Specs…, posts one message and records one go-ahead per row", async () => {
    const [g, h, s] = [make("feat/g"), make("feat/h"), make("feat/s", true)];
    for (const b of [g, h, s]) await ask(b);
    const card = await captainCard();
    assert.deepEqual(card.rows!.map((r) => r.branch), ["feat/g", "feat/h", "feat/s"]);
    const specs = card.rows!.find((r) => r.branch === "feat/s")!;
    assert.deepEqual(specs.buttons.map((x) => x.label), ["Merge Without Specs…", "Not Yet"]);
    assert.match(specs.buttons[0]!.confirm!, /left-draft/, "its confirm names the drafts");
    assert.equal(specs.drafts, "left-draft");
    assert.ok(card.all, "the file declares Land All");
    assert.match(card.all!.confirm, new RegExp(`feat/g@${g.first.slice(0, 7)}, feat/h@${h.first.slice(0, 7)}`));
    assert.doesNotMatch(card.all!.confirm, /feat\/s/);
    await assert.rejects(offers.chooseAll(pathOf(CAP), CAP, card.id, [card.all!.rows[0]!]), /rows changed/, "only the rows its confirm named");
    await offers.chooseAll(pathOf(CAP), CAP, card.id, card.all!.rows);
    assert.equal(requests.length, 1, "one message to the captain");
    assert.equal(requests[0]!.body.text, `Go ahead: land feat/g at ${g.first.slice(0, 12)}.\nGo ahead: land feat/h at ${h.first.slice(0, 12)}.`);
    for (const b of [g, h]) assert.equal(landing.goAheadFor(b.name, b.first, join(agent, "sova", "landing.json"))?.in, CAP);
    const now = await captainCard();
    assert.equal(now.rows!.find((r) => r.branch === "feat/s")!.state, "open", "skipped, still open");
    assert.equal(now.state, "open");
    assert.equal(now.all, undefined, "no row left that Land All answers");
    for (const b of [g, h]) assert.equal((await ownerCard(b))?.choice?.where, "Merge Captain");
    await assert.rejects(offers.chooseOffer(pathOf(CAP), CAP, card.id, 0, now.rows![0]!.id), /no longer open/, "a double click is refused");
  });

  test("q1: a branch whose owner card was refused for its chat alone still gets a row; a branch-level refusal gets none", async () => {
    const b = make("feat/i");
    // Another card open in the owner's chat: its Landing card is refused, its row is not.
    offers.setNotNow(b.owner, pathOf(b.owner), "landing", true);
    const shown = await ask(b);
    assert.ok("refused" in shown && /Not Now/.test(shown.refused), JSON.stringify(shown));
    assert.ok(shown.row && "card" in shown.row);
    assert.equal((await rowOf(b)).state, "open");
    // Moved since it was queued: about the branch, so no row.
    const m = make("feat/j");
    entries.push({ id: `lq_${++qn}`, branch: m.name, path: m.tree, head: "f".repeat(40), owner: m.owner, captain: CAP, at: Date.now() });
    writeFileSync(queueFile, JSON.stringify({ v: 1, entries }));
    await queue.processLandingQueue({ pathOf: async (id) => pathOf(id), summary: async (p) => (summaries.get(p) as SessionSummary) ?? null, queueFile: () => queueFile, shownFile: () => shownFile });
    const r = queue.readShown(shownFile)[`lq_${qn}`]!;
    assert.ok("refused" in r && !r.row, JSON.stringify(r));
  });

  test("at most 10 rows; the rest wait with one line, and open the next card once this one is answered", async () => {
    const list = Array.from({ length: 11 }, (_, i) => make(`feat/many-${i}`));
    for (const b of list) await ask(b);
    const card = await captainCard();
    assert.equal(card.rows!.length, 10);
    assert.equal(card.more, 1);
    assert.equal(offers.openOfferOf(CAP)?.title, "10 branches ready to land");
    await closeCaptain();
    const next = await captainCard();
    assert.notEqual(next.id, card.id);
    assert.deepEqual(next.rows!.map((r) => [r.id, r.branch]), [["r_1", "feat/many-10"]]);
    assert.equal(next.state, "open");
  });

  /** Another (non-landing) card open in the captain's chat while `run` goes, the offers file restored after. */
  let replies = 0;
  async function withOtherCard(run: (otherId: string) => Promise<void>) {
    const file = join(repo, ".sova", "offers.json");
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text) as { offers: Record<string, unknown> };
    parsed.offers.ping = { when: "w", title: "Ping?", shownBy: "agent", repeat: "once-per-reply", buttons: [{ label: "Ping", about: "Pings.", send: "ping" }] };
    try {
      writeFileSync(file, JSON.stringify(parsed));
      const other = await offers.showOffer({ path: pathOf(CAP), sessionId: CAP, offer: "ping", by: "agent", replyId: `ping-${++replies}` });
      await run(other.id);
    } finally {
      writeFileSync(file, text);
    }
  }
  const openLandingVia = async () => {
    const app = new Hono();
    registerSessionOfferRoutes(app);
    const res = await app.request(`/api/session-offers?path=${encodeURIComponent(pathOf(CAP))}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { cards: { state: string; title: string; rows?: { branch?: string; state: string }[] }[] }).cards.find((c) => c.state === "open" && c.rows);
  };

  test("F1: a row parked behind another open card opens a landing card once that card is answered", async () => {
    await withOtherCard(async (otherId) => {
      const b = make("feat/behind-1");
      const shown = await ask(b);
      assert.deepEqual(shown.row, { waiting: true }, "the captain's one open card is answered first");
      await offers.chooseOffer(pathOf(CAP), CAP, otherId, 0);
      const open = await openLandingVia();
      assert.ok(open, "a landing card opens from the waiting row");
      assert.equal(open.title, "Branches ready to land");
      assert.deepEqual(open.rows!.map((r) => [r.branch, r.state]), [[b.name, "open"]]);
      assert.equal(offers.openOfferOf(CAP)?.title, "1 branch ready to land");
    });
  });

  test("F1: Not Now on the other card brings up the waiting row too", async () => {
    await withOtherCard(async () => {
      const b = make("feat/behind-2");
      assert.deepEqual((await ask(b)).row, { waiting: true });
      offers.setNotNow(CAP, pathOf(CAP), "ping", true);
      const open = await openLandingVia();
      assert.deepEqual(open?.rows?.map((r) => [r.branch, r.state]), [[b.name, "open"]]);
      offers.setNotNow(CAP, pathOf(CAP), "ping", false);
    });
  });

  test("F2: at most 10 open rows: answered rows leave room on the open card", async () => {
    const list = Array.from({ length: 10 }, (_, i) => make(`feat/room-${i}`));
    for (const b of list) await ask(b);
    const card = await captainCard();
    assert.equal(card.rows!.length, 10);
    for (const r of card.rows!.slice(0, 9)) await offers.chooseOffer(pathOf(CAP), CAP, card.id, r.buttons.findIndex((x) => x.label === "Not Yet"), r.id);
    const eleventh = make("feat/room-10");
    const shown = await ask(eleventh);
    assert.deepEqual(shown.row, { card: card.id, row: "r_11" }, "9 answered: room for the 11th on the same card");
    const now = await captainCard();
    assert.equal(now.id, card.id);
    assert.equal(now.rows!.filter((r) => r.state === "open").length, 2);
    assert.equal(now.more, undefined, "nothing waits");
  });

  test("the landing offer removed: the captain's card and the owners' cards read No longer offered", async () => {
    const b = make("feat/k");
    await ask(b);
    const file = join(repo, ".sova", "offers.json");
    const text = readFileSync(file, "utf8");
    try {
      writeFileSync(file, JSON.stringify({ version: 1, offers: {} }));
      assert.equal((await captainCard()).state, "withdrawn");
      assert.equal((await ownerCard(b))?.state, "withdrawn");
    } finally {
      writeFileSync(file, text);
    }
  });

  test("no chat supplies rows for an offer with landing buttons", async () => {
    const b = make("feat/l");
    await assert.rejects(offers.showOffer({ path: pathOf(b.owner), offer: "landing", by: "another-chat", from: pathOf(CAP), rows: [{ label: "x", values: {} }] }), /builds "landing"'s rows itself/);
  });
});

describe("generic rows (§chat.offers/card, Rows)", () => {
  const generic = join(root, "generic");
  mkdirSync(join(generic, ".sova"), { recursive: true });
  git(generic, "init", "-q", "-b", "master");
  commit(generic, "README", "g\n");
  const withRows = {
    when: "When there are files to review.",
    title: "Review these files?",
    repeat: "once-per-reply",
    rows: { max: 3, all: { label: "Review All", about: "Reviews every file.", confirm: "Review {rows}?" } },
    buttons: [
      { label: "Review", about: "Reviews the file.", send: "Review {row.file} ({row.why}).", confirm: "Review {row.file}?" },
      { label: "Skip", about: "Skips it.", send: "Skip {row.file}." },
    ],
  };
  writeFileSync(join(generic, ".sova", "offers.json"), JSON.stringify({ version: 1, offers: { review: withRows, plain: { when: "w", title: "t", buttons: [{ label: "Go", about: "Goes.", send: "go" }] } } }));
  let n = 0;
  const fresh = () => {
    const id = `gen-${++n}`;
    session(id, { title: `Generic ${id}`, cwd: generic });
    return id;
  };
  const rows = [
    { label: "src/a.ts", values: { file: "src/a.ts", why: "new" } },
    { label: "src/b.ts", values: { file: "src/b.ts", why: "changed" } },
  ];

  test("each row repeats the file's buttons, its own values filled in; a click answers that row alone", async () => {
    const id = fresh();
    const card = await offers.showOffer({ path: pathOf(id), sessionId: id, offer: "review", by: "agent", rows, replyId: "u1" });
    assert.deepEqual(card.rows!.map((r) => [r.id, r.label, r.buttons.map((b) => b.label)]), [["r_1", "src/a.ts", ["Review", "Skip"]], ["r_2", "src/b.ts", ["Review", "Skip"]]]);
    assert.equal(card.rows![1]!.buttons[0]!.confirm, "Review src/b.ts?");
    assert.equal(card.all?.confirm, "Review src/a.ts, src/b.ts?");
    const after1 = await offers.chooseOffer(pathOf(id), id, card.id, 0, "r_2");
    assert.equal(requests.at(-1)!.body.text, "Review src/b.ts (changed).");
    assert.deepEqual(after1.rows!.map((r) => r.state), ["open", "chosen"]);
    assert.equal(after1.state, "open", "the card stays open while a row is");
    await assert.rejects(offers.chooseOffer(pathOf(id), id, card.id, 1, "r_2"), /no longer open/);
    await assert.rejects(offers.chooseOffer(pathOf(id), id, card.id, 0), /row names the row/);
    const done = await offers.chooseAll(pathOf(id), id, card.id, ["r_1"]);
    assert.equal(requests.at(-1)!.body.text, "Review src/a.ts (new).");
    assert.equal(done.state, "chosen", "every row answered: closed");
    assert.equal(requests.length, 2);
  });

  test("strict: rows for an offer without them, none for one with them, unknown or missing keys, too many, too long", async () => {
    const id = fresh();
    const bad = (offer: string, r: unknown, re: RegExp) => assert.rejects(offers.showOffer({ path: pathOf(id), sessionId: id, offer, by: "agent", rows: r, replyId: `u${Math.random()}` }), (e: Error) => (assert.match(e.message, re), assert.match(e.message, /Nothing was shown/), true));
    await bad("plain", rows, /takes no rows/);
    await bad("review", undefined, /give 1 or more/);
    await bad("review", [{ label: "x", values: { file: "a", why: "b", extra: "c" } }], /\{row\.extra\} is in none/);
    await bad("review", [{ label: "x", values: { file: "a" } }], /needs a value for \{row\.why\}/);
    await bad("review", Array.from({ length: 4 }, () => rows[0]), /4 rows \(at most 3\)/);
    await bad("review", [{ label: "x".repeat(81), values: rows[0]!.values }], /at most 80/);
    await bad("review", [{ label: "x", values: { file: "a".repeat(121), why: "b" } }], /1 to 120/);
    await bad("review", [{ label: "x", values: rows[0]!.values, more: 1 }], /unknown key "more"/);
  });

  test("the tool's parameters take rows only when its snapshot names an offer that declares them", () => {
    const parsed = shared.parseOffersFile(readFileSync(join(generic, ".sova", "offers.json"), "utf8"));
    const both = shared.snapshotOf(parsed)!;
    const props = (s: typeof both) => Object.keys((offerToolSpec("s", "/p", s).parameters as { properties: Record<string, unknown> }).properties);
    assert.deepEqual(props(both), ["offer", "note", "rows"]);
    assert.deepEqual(both.offers.find((o) => o.name === "review")?.rows, { max: 3, keys: ["file", "why"] });
    assert.match(offerToolSpec("s", "/p", both).description, /Takes rows \(1 to 3/);
    const plainOnly = { offers: both.offers.filter((o) => o.name === "plain") };
    assert.deepEqual(props(plainOnly), ["offer", "note"], "exactly the parameters it had before rows existed");
    assert.deepEqual(shared.normalizeSnapshot(JSON.parse(JSON.stringify(both))), both, "the rows are recorded with the snapshot");
  });
});
