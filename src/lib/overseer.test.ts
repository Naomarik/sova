import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import { resultDetails } from "./message";
import { applyCardCall, type CardDetails } from "../../shared/overseer-card";
import {
  briefBody,
  cardFold,
  openCards,
  confirmAnswer,
  confirmDetails,
  confirmReply,
  confirmRows,
  CONFIRM_SESSIONS_SHOWN,
  createTurnOwner,
  detailsOf,
  isBriefText,
  isOverseerHash,
  isOverseerShortcut,
  navigateDetails,
  nextProactivity,
  PROACTIVITY_LABEL,
  overseerButtonLabel,
  overseerHistoryHref,
  overseerHistoryId,
  settingsTarget,
} from "./overseer";

const row = (id: string, kind: TranscriptItem["kind"], text?: string): TranscriptItem => ({ id, kind, text });
const confirm = { title: "Archive 12 sessions?", options: [{ label: "Archive All" }, { label: "Keep Them", reply: "No, keep them." }] };

test("a legacy confirm card is answered by the next user message, clicked or typed (read-only, from before card ids)", () => {
  const items = [row("u1", "user", "tidy up"), row("c1", "tool-call", "sova_confirm"), row("r1", "tool-result")];
  assert.deepEqual(confirmAnswer(items, 1, confirm), { answered: false, choice: null }, "nothing after it yet");

  const clicked = [...items, row("u2", "user", "No, keep them.")];
  assert.deepEqual(confirmAnswer(clicked, 1, confirm), { answered: true, choice: "Keep Them" }, "an option's reply names that option");

  const typed = [...items, row("u2", "user", "only the old ones")];
  assert.deepEqual(confirmAnswer(typed, 1, confirm), { answered: true, choice: null }, "any later message answers it, even one that isn't an option");
});

test("a user message BEFORE the card never answers it, and machine turns don't either", () => {
  const items = [row("u1", "user", "Archive All"), row("c1", "tool-call", "sova_confirm")];
  assert.equal(confirmAnswer(items, 1, confirm).answered, false);
  const brief = [...items, row("b1", "user", "[overseer-brief] cell-2 needs input"), row("w1", "wake", "[wake_nudge n1] check")];
  assert.equal(confirmAnswer(brief, 1, confirm).answered, false, "a proactive brief or a wake is not the user's answer");
});

test("confirm details: bare strings are options, empty options are dropped, no options is no card", () => {
  assert.deepEqual(confirmDetails({ title: "Go?", options: ["Yes", "", { label: "No", tone: "danger" }] })?.options, [
    { label: "Yes" },
    { label: "No", reply: undefined, tone: "danger" },
  ]);
  assert.equal(confirmDetails({ title: "Go?", options: [] }), null);
  assert.equal(confirmDetails({ options: ["Yes"] }), null, "a title is required");
  assert.equal(confirmReply({ label: "Yes", reply: "  " }), "Yes", "a blank reply falls back to the label");
});

test("details come from a live result or a card tool's row", () => {
  const details = { href: "#/usage", label: "Usage" };
  assert.deepEqual(detailsOf({ content: [], details }), details);
  assert.deepEqual(resultDetails({ id: "r", kind: "tool-result", tool: { output: "", details } }), details);
  assert.equal(detailsOf("text"), undefined);
});

test("navigate targets: routes and settings only, never an arbitrary URL", () => {
  assert.deepEqual(navigateDetails({ href: "#/s/%2Fa.jsonl", label: "fix auth" }), { href: "#/s/%2Fa.jsonl", label: "fix auth" });
  assert.equal(navigateDetails({ href: "https://evil.example" }), null);
  assert.equal(navigateDetails({ href: "javascript:alert(1)" }), null);
  assert.deepEqual(settingsTarget("settings:overseer"), { tab: "overseer", section: null });
  assert.deepEqual(settingsTarget("settings:modes/spec"), { tab: "modes", section: "spec" });
  assert.equal(settingsTarget("settings:nope"), null);
  assert.equal(settingsTarget("#/usage"), null);
});

test("only the tab that started the running turn owns it, for that turn only", () => {
  const mine = new Set(["c-1", "c-2"]);
  const owner = createTurnOwner((id) => mine.has(id));
  assert.equal(owner.mine(), false, "a turn nobody here sent (a brief, another tab) is not ours");
  owner.ack("c-9", false);
  assert.equal(owner.mine(), false, "another tab's ack is not ours");
  owner.ack("c-1", true);
  assert.equal(owner.mine(), false, "queued is not started");
  owner.gone("c-1", "removed");
  assert.equal(owner.mine(), false, "a removal starts nothing");
  owner.gone("c-1", "delivered");
  assert.equal(owner.mine(), true, "our queued message was delivered into the turn");
  owner.settled();
  assert.equal(owner.mine(), false, "the next turn starts unowned");
  owner.ack("c-2", false);
  assert.equal(owner.mine(), true, "sent while idle: the turn it starts is ours");
  owner.reset();
  assert.equal(owner.mine(), false);
});

test("briefs are recognised by their prefix", () => {
  assert.equal(isBriefText("[overseer-brief] 2 sessions need you"), true);
  assert.equal(isBriefText("what needs me"), false);
  assert.equal(briefBody("[overseer-brief] 2 sessions need you"), "2 sessions need you");
});

test("routes, shortcut, labels and the proactivity cycle", () => {
  assert.equal(isOverseerHash("#/overseer"), true);
  assert.equal(isOverseerHash("#/overseerx"), false);
  assert.equal(overseerHistoryId(overseerHistoryHref("019a-b")), "019a-b");
  assert.equal(overseerHistoryId("#/overseer"), null);
  const key = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code: "KeyO" };
  assert.equal(isOverseerShortcut(key), true);
  assert.equal(isOverseerShortcut({ ...key, ctrlKey: true }), false);
  assert.equal(overseerButtonLabel(1), "Overseer · 1 new message");
  assert.equal(overseerButtonLabel(3), "Overseer · 3 new messages");
  assert.equal(overseerButtonLabel(0), "Overseer", "no unread: the bare name, never a count of 0");
  assert.deepEqual([nextProactivity("off"), nextProactivity("badge"), nextProactivity("brief")], ["badge", "brief", "off"]);
  assert.deepEqual(PROACTIVITY_LABEL, { off: "Off", badge: "List Only", brief: "Brief Me" }, "the wire value stays badge; the label is List Only");
});

test("a brief's body renders as markdown: its blockers are a list of in-app links, not raw brackets (E2E F6)", async () => {
  const { renderMarkdown } = await import("./markdown");
  const { setSessionIndex } = await import("./session-links");
  setSessionIndex([{ id: "01a0d55d-aaaa", path: "/s/g.jsonl", title: "Reply with exactly: GAMMA" }]);
  // The server's brief text, verbatim in shape (server/overseer.ts tick()).
  const text = "[overseer-brief] A new blocker appeared while you were idle:\n- needs-input: [Reply with exactly: GAMMA](sova://s/01a0d55d-aaaa) — Waiting on: a select";
  const { html } = renderMarkdown(briefBody(text));
  assert.match(html, /<li>/);
  assert.match(html, /<a [^>]*href="#\/s\/%2Fs%2Fg\.jsonl"[^>]*>Reply with exactly: GAMMA<\/a>/);
  assert.ok(!html.includes("](sova://"), "no raw markdown link syntax is left");
  assert.ok(!/target="_blank"/.test(html), "an in-app link opens in this tab");
});

test("confirm details: items parse tolerantly; a card without them has no items at all", () => {
  const at = "2026-09-20T10:00:00.000Z";
  const d = confirmDetails({
    title: "Archive?",
    options: ["Yes"],
    items: [
      { kind: "session", id: "s1", title: "Parser", project: "sova", lastActiveAt: at, summary: "Fixed", workers: 2 },
      { kind: "session", id: "s2", lastActiveAt: "not a time", workers: -1, project: "  " },
      { kind: "idea", id: "§sova/x", title: "X" },
      { kind: "todo", id: "td_aaaaaaaa", text: "Do it" },
      { kind: "todo", id: "td_bbbbbbbb" },
      { kind: "group", id: "g1" },
      { kind: "session", title: "no id" },
      "s3",
      null,
    ],
  });
  assert.deepEqual(d?.items, [
    { kind: "session", id: "s1", title: "Parser", project: "sova", lastActiveAt: at, summary: "Fixed", workers: 2 },
    { kind: "session", id: "s2", title: "s2" },
    { kind: "idea", id: "§sova/x", title: "X" },
    { kind: "todo", id: "td_aaaaaaaa", text: "Do it" },
  ]);
  const old = confirmDetails({ title: "Go?", options: ["Yes"] });
  assert.ok(old && !("items" in old), "an old card parses as before");
  assert.ok(!("items" in confirmDetails({ title: "Go?", options: ["Yes"], items: "s1" })!), "items that aren't a list are ignored");
});

test("confirm details: clickOnly parses only as true; an ordinary card has none", () => {
  assert.equal(confirmDetails({ title: "Close?", options: ["Close"], clickOnly: true })?.clickOnly, true);
  assert.ok(!("clickOnly" in confirmDetails({ title: "Go?", options: ["Yes"] })!), "an ordinary card keeps its hint");
  assert.ok(!("clickOnly" in confirmDetails({ title: "Go?", options: ["Yes"], clickOnly: "yes" })!));
});

test("confirm details: an item's note parses on every kind, blank or non-string notes are dropped", () => {
  const d = confirmDetails({
    title: "Archive?",
    options: ["Yes"],
    items: [
      { kind: "session", id: "s1", title: "Parser", summary: "Parser fix", note: "Parser fix.  Merged,\n nothing running." },
      { kind: "idea", id: "§sova/x", title: "X", note: "  " },
      { kind: "todo", id: "td_aaaaaaaa", text: "Do it", note: 42 },
      { kind: "todo", id: "td_bbbbbbbb", text: "Other", note: "Covered by s1." },
    ],
  });
  assert.deepEqual(
    d?.items?.map((i) => i.note),
    ["Parser fix. Merged, nothing running.", undefined, undefined, "Covered by s1."],
  );
  assert.ok(!("note" in d!.items![1]!) && !("note" in d!.items![2]!));
});

test("confirm rows: ideas and todos come first and are never collapsed; only sessions follow the toggle", () => {
  const session = (n: number) => ({ kind: "session" as const, id: `s${n}`, title: `S${n}` });
  const idea = { kind: "idea" as const, id: "§sova/x", title: "X" };
  const todo = { kind: "todo" as const, id: "td_aaaaaaaa", text: "Tick me", note: "Ticking marks it done." };
  // The server's order (sessions, then ideas, then todos), 13 sessions: the todo is item 15.
  const items = [...Array.from({ length: 13 }, (_, i) => session(i)), idea, todo];
  const shut = confirmRows(items, false);
  assert.deepEqual(shut.rows.slice(0, 2).map((r) => r.id), ["§sova/x", "td_aaaaaaaa"], "ideas and todos lead");
  assert.equal(shut.rows.length, 2 + CONFIRM_SESSIONS_SHOWN, "the pinned rows don't use up the 8");
  assert.ok(shut.rows.slice(2).every((r) => r.kind === "session"));
  assert.deepEqual([shut.sessions, shut.collapsible, shut.hidden], [13, true, 5]);
  const open = confirmRows(items, true);
  assert.equal(open.rows.length, 15);
  assert.equal(open.hidden, 0);
  // Many todos and few sessions: nothing collapses, however many rows.
  const todos = Array.from({ length: 12 }, (_, i) => ({ kind: "todo" as const, id: `td_${i}`, text: `T${i}` }));
  const few = confirmRows([session(1), ...todos], false);
  assert.deepEqual([few.rows.length, few.collapsible, few.rows.at(-1)!.id], [13, false, "s1"]);
  // 9 sessions: hiding 1 saves nothing, so no toggle.
  assert.equal(confirmRows(Array.from({ length: 9 }, (_, i) => session(i)), false).collapsible, false);
});

test("a card's project and person rows keep their org and status; one without its org or name is dropped", () => {
  const d = confirmDetails({
    title: "Start?",
    options: ["Start"],
    items: [
      { kind: "project", id: "prj_1", orgId: "org_1", name: "Ledger", orgName: "Harbor Works", note: "Its site." },
      { kind: "person", id: "p_1", orgId: "org_1", name: "Tony", orgName: "Harbor Works", status: "proposed" },
      { kind: "person", id: "p_2", name: "No org" },
    ],
  });
  assert.deepEqual(d?.items, [
    { kind: "project", id: "prj_1", orgId: "org_1", name: "Ledger", orgName: "Harbor Works", note: "Its site." },
    { kind: "person", id: "p_1", orgId: "org_1", name: "Tony", orgName: "Harbor Works", status: "proposed" },
  ]);
});

// ---- sova_card (§app.overseer/confirm) ----

const NOW = "2026-09-30T10:00:00.000Z";
const call = (id: string): TranscriptItem => ({ id, kind: "tool-call", text: "sova_card", toolCallId: `t-${id}` });
const result = (id: string, details: unknown, isError = false): TranscriptItem => ({
  id: `r-${id}`,
  kind: "tool-result",
  toolCallId: `t-${id}`,
  meta: { type: "message", role: "toolResult", toolName: "sova_card", toolCallId: `t-${id}`, isError },
  tool: { output: "", details },
});
const created = applyCardCall([], { ops: [{ op: "create", title: "Archive?", options: [{ label: "Archive" }, { label: "Keep" }] }] }, { now: NOW, prepared: { items: [], hrefs: [] } }).details;
const answered = applyCardCall([created.card!], { card: "c_1", ops: [{ op: "answer", text: "c_1 a: Archive", option: "a" }] }, { now: NOW }).details;

test("a card stays open after an unrelated message: its state comes from the fold, never from later messages", () => {
  const items = [row("u1", "user", "tidy"), call("k1"), result("k1", created), row("u2", "user", "what else is running?")];
  const fold = cardFold(items);
  assert.equal(fold.cards.get("c_1")?.phase, "open");
  assert.deepEqual(openCards(fold).map((c) => c.id), ["c_1"]);
  assert.equal(fold.newest.get("c_1"), "k1");
});

test("the row that last touched a card renders it; an answer op moves it there and closes it", () => {
  const items = [call("k1"), result("k1", created), row("u2", "user", "c_1 a: Archive"), call("k2"), result("k2", answered)];
  const fold = cardFold(items);
  assert.equal(fold.newest.get("c_1"), "k2");
  assert.equal(fold.cards.get("c_1")?.phase, "answered");
  assert.equal(fold.rows.get("k1")?.card?.phase, "open", "the earlier row keeps its own snapshot, for its one line");
  assert.deepEqual(openCards(fold), []);
});

test("an error result, bad details and a legacy sova_confirm row are never state; live results fold last", () => {
  const legacy: TranscriptItem = { id: "L", kind: "tool-call", text: "sova_confirm", toolCallId: "t-L" };
  const items = [call("k1"), result("k1", created), call("k2"), result("k2", answered, true), call("k3"), result("k3", { v: 1, card: { id: "c_1" }, changes: [], line: "" }), legacy, result("L", { title: "Old", options: [{ label: "Yes" }] })];
  const fold = cardFold(items);
  assert.equal(fold.cards.get("c_1")?.phase, "open");
  assert.equal(fold.cards.size, 1);
  const live = cardFold(items, [answered as CardDetails]);
  assert.equal(live.cards.get("c_1")?.phase, "answered");
  assert.equal(live.newest.has("c_1"), false, "a card this run changed has no settled row to render it in full");
});

test("cards open above the rows held: the summary carries each open card's newest snapshot and call row; the fold takes them first, and a newer snapshot in the list wins", async () => {
  const { summarize } = await import("../../shared/row-counts");
  const second = applyCardCall([created.card!], { ops: [{ op: "create", title: "Tick?", options: [{ label: "Tick" }] }] }, { now: NOW, prepared: { items: [], hrefs: [] } }).details;
  const replaced = applyCardCall([created.card!, second.card!], { ops: [{ op: "create", title: "Archive fewer?", options: [{ label: "Go" }], replaces: "c_2" }] }, { now: NOW, prepared: { items: [], hrefs: [] } }).details;
  // c_1 open, c_2 raised then replaced by c_3: above the list, c_1 and c_3 are open.
  const above = [call("k1"), result("k1", created), call("k2"), result("k2", second), call("k3"), result("k3", replaced), call("k4"), result("k4", answered, true)];
  const s = summarize(above);
  assert.deepEqual(s.cards?.map((c) => [c.card.id, c.rowId]), [["c_1", "k1"], ["c_3", "k3"]], "an error result is never state; superseded c_2 is not open");
  // The fold counts them for the chip, and knows each one's row for the jump.
  const fold = cardFold([row("u9", "user", "anything")], [], s.cards);
  assert.deepEqual(openCards(fold).map((c) => c.id), ["c_1", "c_3"]);
  assert.equal(fold.newest.get("c_1"), "k1");
  // The answer in the rows held closes c_1, whatever the summary said.
  const later = cardFold([call("k5"), result("k5", answered)], [], s.cards);
  assert.deepEqual(openCards(later).map((c) => c.id), ["c_3"]);
  assert.equal(later.newest.get("c_1"), "k5");
  // A result whose call row isn't among the rows is keyed by its own row.
  assert.deepEqual(summarize([result("k1", created)]).cards?.map((c) => c.rowId), ["r-k1"]);
  assert.equal(summarize([call("k5"), result("k5", answered)]).cards, undefined, "no open card, no key");
});

test("a #c_N link is a card ref: in-app, never the route; any other # href stays text", async () => {
  const { renderMarkdown } = await import("./markdown");
  const { html } = renderMarkdown("See [c_5](#c_5), not [the top](#top) or [usage](#/usage).");
  assert.match(html, /<a class="md-app-link md-card-ref" href="#c_5" data-card-ref="c_5" title="Jump to c_5">c_5<\/a>/);
  assert.ok(!/target="_blank"/.test(html), "a card ref opens nothing new");
  assert.match(html, /not the top or/, "#top renders as its text, unlinked");
  assert.match(html, /<a class="md-app-link" href="#\/usage">usage<\/a>/, "a #/ route is still a route");
  const { cardRefId } = await import("./card-refs");
  assert.deepEqual(["#c_5", "#c_12", "#c_0", "#c_5x", "c_5", "#/c_5"].map(cardRefId), ["c_5", "c_12", null, null, null, null]);
});
