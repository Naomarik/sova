import assert from "node:assert/strict";
import { test } from "node:test";
import type { PersonRelation, VisitRow } from "../../shared/orgs";
import { canPreview, firstName, holdLine, leftAt, sinceWords, LINK_STATE, linkLive, messagesLine, namesList, relationWords, visitDuration, visitsSummary, visitWords } from "./person-page";

const ana = { id: "p_ana00001", name: "Ana" };
const ben = { id: "p_ben00001", name: "Ben" };
const you = { id: "operator", name: "Omar" };
const NOW = Date.parse("2026-09-27T12:00:00Z");

test("every relation has its own words, and the operator reads as you", () => {
  const rels: PersonRelation[] = [
    { kind: "started-with" },
    { kind: "handed-to", n: 2, from: you },
    { kind: "passed-on", n: 3, to: [ana] },
    { kind: "offered", n: 4, others: 2 },
    { kind: "took-offer", n: 4 },
    { kind: "lease-lapsed", n: 5 },
    { kind: "referred-here", by: ben },
    { kind: "proposed", person: ana },
    { kind: "conflict", conflictId: "cf_1", area: "invoicing" },
    { kind: "participant" },
  ];
  const words = rels.map(relationWords);
  assert.equal(new Set(words).size, rels.length, "no two relations read the same");
  assert.equal(words[1], "Handed to them by you · #2");
  assert.equal(words[2], "Passed on to Ana · #3");
  assert.equal(words[3], "Offered to them with 2 others · #4");
  assert.equal(relationWords({ kind: "offered", n: 1, others: 1 }), "Offered to them with 1 other · #1");
  assert.equal(relationWords({ kind: "offered", n: 1, others: 0 }), "Offered to them · #1");
  assert.equal(words[6], "Referred here by Ben");
  assert.equal(words[7], "Proposed Ana here");
  assert.equal(words[8], "Asked to settle invoicing");
});

test("names join with a serial comma", () => {
  assert.equal(namesList([ana]), "Ana");
  assert.equal(namesList([ana, ben]), "Ana and Ben");
  assert.equal(namesList([ana, ben, you]), "Ana, Ben, and you");
});

test("who has it now, from their side", () => {
  const base = { holder: null, holdsNow: false, state: "open" as const };
  assert.equal(holdLine({ ...base, holdsNow: true, holder: ana }), "Holds it now");
  assert.equal(holdLine({ ...base, holder: ben }), "With Ben");
  assert.equal(holdLine({ ...base, holder: you }), "With you");
  assert.equal(holdLine({ ...base, offer: { state: "open", invited: 3, includesThem: true } }), "Open to them and 2 others");
  assert.equal(holdLine({ ...base, offer: { state: "open", invited: 1, includesThem: true } }), "Open to them");
  assert.equal(holdLine({ ...base, offer: { state: "open", invited: 2, includesThem: false } }), "Open to 2 people");
  assert.equal(holdLine({ ...base, state: "done", holdsNow: true, holder: ana }), null, "done: nobody holds it");
  assert.equal(holdLine({ ...base, state: "closed" }), null);
});

test("r12: an invitee not reached yet: when their hours start, or that a lease pauses reaching", () => {
  const base = { holder: null, holdsNow: false, state: "open" as const };
  const now = new Date(2026, 8, 30, 15, 0).getTime();
  const until = new Date(2026, 8, 30, 19, 0).toISOString();
  assert.equal(
    holdLine({ ...base, offer: { state: "open", invited: 3, includesThem: true, reach: { state: "waiting", until } } }, now),
    "Open to them and 2 others · not reached yet, waiting until 19:00 your time (in 4h)",
  );
  assert.equal(holdLine({ ...base, offer: { state: "open", invited: 3, includesThem: true, reach: { state: "reached" } } }, now), "Open to them and 2 others");
  assert.equal(
    holdLine({ ...base, holder: ana, offer: { state: "held", invited: 3, includesThem: true, holder: ana, reach: { state: "waiting", until, paused: true } } }, now),
    "With Ana · not reached yet, waiting: nobody new is reached while Ana is answering",
  );
});

test("messages line", () => {
  assert.equal(messagesLine({ messages: 0 }), "0 messages");
  assert.equal(messagesLine({ messages: 1 }), "1 message");
  assert.equal(messagesLine({ messages: 3, lastWroteAt: new Date(NOW - 2 * 3600_000).toISOString() }, NOW), "3 messages · last wrote 2h ago");
});

test("link states: a word for each, and only writes/reads can be turned off", () => {
  const states = Object.keys(LINK_STATE) as (keyof typeof LINK_STATE)[];
  assert.equal(new Set(states.map((s) => LINK_STATE[s].word)).size, states.length);
  assert.deepEqual(states.filter(linkLive), ["writes", "reads"]);
});

const visit = (over: Partial<VisitRow>): VisitRow => ({ id: "v1", kind: "visit", at: "2026-09-27T10:00:00Z", sessionId: "s1", publicTitle: "Q3 invoices", n: 1, device: "Safari · iPhone", ...over });

test("visit rows: opened, preview and scanner muted, refused, capped", () => {
  assert.deepEqual(visitWords(visit({})), { text: "Opened Q3 invoices · Safari · iPhone", muted: false });
  assert.deepEqual(visitWords(visit({ lastSeenAt: "2026-09-27T10:12:00Z" })), { text: "Opened Q3 invoices · Safari · iPhone · for about 12 min", muted: false });
  assert.deepEqual(visitWords(visit({ bot: true, device: "Security scanner" })), { text: "Security scanner · Q3 invoices", muted: true });
  assert.deepEqual(visitWords(visit({ kind: "preview", device: "Slack" })), { text: "Link preview by Slack · Q3 invoices", muted: true });
  assert.equal(visitWords(visit({ kind: "preview", device: "Link preview" })).text, "Link preview · Q3 invoices", "a generic unfurler");
  assert.deepEqual(visitWords(visit({ bot: true, device: "Script" })), { text: "Script · Q3 invoices", muted: true });
  assert.match(visitWords(visit({ kind: "refused" })).text, /^Tried a turned-off link/);
  assert.equal(visitWords(visit({ kind: "capped" })).muted, true);
  assert.match(visitWords(visit({ otherHost: true })).text, /link from another host$/);
});

test("visit duration: nothing under a minute, minutes, then hours", () => {
  assert.equal(visitDuration({ at: "2026-09-27T10:00:00Z" }), null);
  assert.equal(visitDuration({ at: "2026-09-27T10:00:00Z", lastSeenAt: "2026-09-27T10:00:40Z" }), null);
  assert.equal(visitDuration({ at: "2026-09-27T10:00:00Z", lastSeenAt: "2026-09-27T10:05:00Z" }), "for about 5 min");
  assert.equal(visitDuration({ at: "2026-09-27T10:00:00Z", lastSeenAt: "2026-09-27T12:00:00Z" }), "for about 2 h");
  assert.equal(visitDuration({ at: "2026-09-27T10:00:00Z", lastSeenAt: "2026-09-27T11:30:00Z" }), "for about 1.5 h");
});

test("visits summary: count and last, the absence only once a link was sent", () => {
  assert.equal(visitsSummary({ opened: 0, linksEver: 0 }), null);
  assert.equal(visitsSummary({ opened: 0, linksEver: 2 }), "Hasn't opened a link yet.");
  assert.equal(visitsSummary({ opened: 1, lastOpenedAt: new Date(NOW - 5 * 60_000).toISOString(), linksEver: 1 }, NOW), "Opened once · last 5m ago");
  assert.equal(visitsSummary({ opened: 4, lastOpenedAt: new Date(NOW - 3600_000).toISOString(), linksEver: 1 }, NOW), "Opened 4 times · last 1h ago");
});

test("when they left: the newest change of status to left", () => {
  assert.equal(leftAt([]), null);
  assert.equal(
    leftAt([
      { field: "role", to: "x", at: "2026-09-27T00:00:00Z" },
      { field: "status", to: "left", at: "2026-09-26T00:00:00Z" },
      { field: "status", to: "left", at: "2026-09-01T00:00:00Z" },
    ]),
    "2026-09-26T00:00:00Z",
  );
});

test("since words: an age, then a date after on", () => {
  assert.equal(sinceWords(new Date(NOW - 2 * 3600_000).toISOString(), NOW), "2h ago");
  assert.equal(sinceWords("2026-09-01T12:00:00Z", NOW), "on Sep 1");
});

test("first name", () => {
  assert.equal(firstName("Ana María López"), "Ana");
  assert.equal(firstName("  Kim "), "Kim");
});

test("preview only where they were addressed", () => {
  assert.equal(canPreview({ holdsNow: false, relations: [{ kind: "referred-here", by: ana }] }), false);
  assert.equal(canPreview({ holdsNow: false, relations: [{ kind: "proposed", person: ben }, { kind: "conflict", conflictId: "c", area: "x" }] }), false);
  assert.equal(canPreview({ holdsNow: true, relations: [] }), true);
  for (const r of [{ kind: "started-with" }, { kind: "offered", n: 1, others: 1 }, { kind: "participant" }] as PersonRelation[])
    assert.equal(canPreview({ holdsNow: false, relations: [r] }), true, r.kind);
});

test("an owner-page visit names the page, not a conversation", () => {
  const v = { kind: "visit" as const, at: "2026-09-27T10:00:00Z", device: "Phone · Safari", publicTitle: "", via: "owner" as const };
  assert.equal(visitWords(v).text, "Opened the owner page · Phone · Safari");
  assert.equal(visitWords({ ...v, kind: "refused" }).text, "Tried a turned-off link · the owner page");
  assert.equal(visitWords({ ...v, kind: "visit", via: undefined, publicTitle: "Pricing" }).text, "Opened Pricing · Phone · Safari");
});
