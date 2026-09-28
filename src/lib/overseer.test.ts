import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, TranscriptItem } from "../../shared/protocol";
import {
  briefBody,
  confirmAnswer,
  confirmDetails,
  confirmReply,
  confirmRows,
  CONFIRM_SESSIONS_SHOWN,
  createTurnOwner,
  detailsOf,
  headLists,
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

const row = (id: string, kind: TranscriptItem["kind"], text?: string): TranscriptItem => ({ id, kind, text, raw: {} });
const confirm = { title: "Archive 12 sessions?", options: [{ label: "Archive All" }, { label: "Keep Them", reply: "No, keep them." }] };

test("a confirm card is answered by the next user message, clicked or typed", () => {
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

test("details come from a live result or a persisted tool-result entry", () => {
  const details = { href: "#/usage", label: "Usage" };
  assert.deepEqual(detailsOf({ content: [], details }), details);
  assert.deepEqual(detailsOf({ type: "message", message: { role: "toolResult", details } }), details);
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

const attention = (id: string, tier: AttentionItem["tier"], kind: AttentionItem["kind"], since: number): AttentionItem => ({
  id,
  path: `/s/${id}.jsonl`,
  title: `Session ${id}`,
  where: `~/w/${id}`,
  tier,
  kind,
  since,
  href: `#/s/${id}`,
});
const digestOf = (items: AttentionItem[], total = items.length) => {
  const counts = { act: 0, decide: 0, fyi: 0 };
  for (const i of items) counts[i.tier]++;
  counts.fyi += total - items.length;
  return { items, counts };
};

test("the head's menus split the decide sessions by kind: a reply is finished, a draft or queued input is a draft", () => {
  const { finished, drafts } = headLists(
    digestOf([
      attention("blocked", "act", "needs-input", 50),
      attention("blocked", "decide", "finished", 900),
      attention("blocked", "decide", "draft", 950),
      attention("both", "decide", "finished", 100),
      attention("both", "decide", "draft", 400),
      attention("both", "decide", "queued", 450),
      attention("replied", "decide", "finished", 300),
      attention("queued", "decide", "queued", 200),
      attention("running", "fyi", "working", 1000),
    ]),
  );
  // A session with an act item is counted as "needs you", never in either menu.
  assert.deepEqual(
    finished.rows.map((r) => [r.id, r.since]),
    [
      ["replied", 300],
      ["both", 100],
    ],
  );
  assert.deepEqual(
    drafts.rows.map((r) => [r.id, r.since]),
    [
      ["both", 450],
      ["queued", 200],
    ],
    "queued input is a draft; a session's row takes its newest draft or queued item",
  );
  for (const list of [finished, drafts]) assert.equal(new Set(list.rows.map((r) => r.id)).size, list.rows.length, "no session twice in a menu");
  assert.equal(drafts.rows[1]!.href, "#/s/queued");
  assert.equal(finished.cut || drafts.cut, false, "fyi items past the cap cost no row");
});

test("the head's menus say when the digest's cap dropped act or decide items", () => {
  const items = [attention("a", "act", "error", 1), attention("b", "decide", "finished", 2)];
  const onlyFyi = headLists(digestOf(items, 40));
  assert.deepEqual([onlyFyi.finished.cut, onlyFyi.drafts.cut], [false, false], "only fyi items were cut");
  const cut = headLists({ items, counts: { act: 1, decide: 5, fyi: 0 } });
  assert.deepEqual([cut.finished.cut, cut.drafts.cut], [true, true]);
  assert.deepEqual(headLists({ items: [], counts: { act: 0, decide: 0, fyi: 0 } }), {
    finished: { rows: [], cut: false },
    drafts: { rows: [], cut: false },
  });
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
