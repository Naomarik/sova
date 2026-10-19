// Run: pnpm test -- src/lib/error-feed.test.ts. The thread's error feed (§chat.transcript/states):
// what a live chat view draws at the end of its thread after failures, compared with what a fresh
// load of the same chat draws (the feed is never saved, so a fresh load is a hello on an empty feed).
// The pane below plays ChatView's steps with lib/chat-wait and lib/unacked-sends, as chat-wait.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorHandsBack, WAIT_START, waitOnHello, waitOnOpen, waitOnStatus } from "./chat-wait";
import { EMPTY_FEED, feedOnFailure, feedOnHello, feedOnNote, feedOnOpen, feedOnRefused, feedOnTurnStart, feedRows, type ErrorFeed, type FeedSay } from "./error-feed";
import { UnackedSends } from "./unacked-sends";

/** What ChatView does on each step: the feed, the composer's draft (texts handed back), what it says. */
function pane() {
  const unacked = new UnackedSends();
  const handedBack = new Set<string>();
  let w = WAIT_START;
  let feed: ErrorFeed = EMPTY_FEED;
  let n = 0;
  const p = {
    draft: [] as string[],
    said: [] as FeedSay[],
    feed: () => feed,
    open() {
      w = waitOnOpen(w);
      feed = feedOnOpen(feed);
    },
    hello() {
      w = waitOnHello(w);
      feed = feedOnHello(feed);
    },
    send(text: string): string {
      const id = `c${++n}`;
      unacked.sent(id, text, w.conn);
      return id;
    },
    /** The server's refusal of a send it held for a chat that didn't open (`code: "refused"`). */
    refused(clientId: string, message = "The chat was restarting; your message wasn't sent.") {
      const sent = unacked.take(clientId, handedBack);
      if (sent !== null) p.draft.push(sent.text);
      const step = feedOnRefused(feed, { message, beforeHello: errorHandsBack(w) !== null });
      feed = step.feed;
      p.said.push(...step.says);
    },
    /** A failure `error` (code internal). */
    error(message: string) {
      const conn = errorHandsBack(w);
      const back = conn !== null ? unacked.takeFrom(conn, handedBack) : [];
      p.draft.push(...back.map((u) => u.text));
      const step = feedOnFailure(feed, { message, beforeHello: conn !== null, back: back.length });
      feed = step.feed;
      p.said.push(...step.says);
    },
    /** The socket's status (a close 4500 after an open failure reads "reconnecting"). */
    status(s: Parameters<typeof waitOnStatus>[1]) {
      const r = waitOnStatus(w, s, true);
      if (r.handBack !== null) {
        const back = unacked.takeFrom(r.handBack, handedBack);
        p.draft.push(...back.map((u) => u.text));
        if (back.length) p.said.push({ say: "unsent" });
      }
      w = r.next;
    },
    turnStart() {
      feed = feedOnTurnStart(feed);
    },
    note(message: string, dedupe = false) {
      feed = feedOnNote(feed, message, dedupe);
    },
  };
  return p;
}

/** What a fresh load of the chat draws at its thread's end: a new view, its connection, its hello. */
function freshLoad() {
  const p = pane();
  p.open();
  p.hello();
  return feedRows(p.feed());
}

/** The banners drawn (the rows a usage limit's row may follow without a banner are left out). */
const banners = (feed: ErrorFeed) => feedRows(feed).filter((r) => r.banner !== null);

const START_REASON = "This chat's process didn't start: it could not start its process (no hello in time)";

test("the incident (398db362): a start that failed, the tab's reconnect, a newer turn: the live thread ends as a fresh load's does", () => {
  const p = pane();
  p.open();
  const id = p.send("M"); // sent while the chat starts
  p.refused(id); // the server's retry failed too: its held message is refused
  p.error(START_REASON);
  p.status("reconnecting"); // close 4500
  p.open();
  p.hello(); // a fresh process, ready
  p.send("M"); // sent again
  p.turnStart();
  assert.deepEqual(banners(p.feed()), freshLoad());
  assert.equal(p.feed().turnError, null);
});

test("an earlier turn's error banner goes once a newer turn starts, as on a fresh load", () => {
  const p = pane();
  p.open();
  p.hello();
  p.send("M");
  p.error("400 the provider refused the request");
  assert.equal(banners(p.feed()).length, 1, "shown while it is the last word");
  p.send("N");
  p.turnStart();
  assert.deepEqual(banners(p.feed()), freshLoad());
});

test("a held message refused by a failed start says nothing of its own: the start banner says it, once (a9)", () => {
  const p = pane();
  p.open();
  const id = p.send("M");
  p.refused(id);
  assert.deepEqual(p.said, [], "no toast, no announcement for the refusal itself");
  p.error(START_REASON);
  p.status("reconnecting");
  assert.deepEqual(p.said, [{ say: "startFailed", back: 1 }]);
  assert.deepEqual(p.draft, ["M"], "back in the composer, once");
});

test("a chat that keeps failing to start draws one start banner, the newest reason, said once (a10)", () => {
  const p = pane();
  p.open();
  const id = p.send("M");
  p.refused(id);
  p.error(`${START_REASON}; not ready after 40.3 s`);
  for (const s of ["41.0", "40.1", "40.7"]) {
    p.status("reconnecting");
    p.open();
    p.error(`${START_REASON}; not ready after ${s} s`);
  }
  const rows = banners(p.feed());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.banner, "start", "never 'The turn stopped with an error.': no turn ran");
  assert.equal(rows[0]!.entry.message, `${START_REASON}; not ready after 40.7 s`);
  assert.equal(p.said.filter((s) => s.say === "startFailed").length, 1);
  assert.equal(p.said.length, 1, "nothing else said for it");
});

test("a start failure that gave a message back stays until a newer turn starts; one that gave nothing back goes at the next hello", () => {
  const withMessage = pane();
  withMessage.open();
  withMessage.refused(withMessage.send("M"));
  withMessage.error(START_REASON);
  withMessage.status("reconnecting");
  withMessage.open();
  withMessage.hello();
  assert.equal(banners(withMessage.feed()).length, 1, "it says where the message went");
  withMessage.turnStart();
  assert.deepEqual(banners(withMessage.feed()), freshLoad());

  const empty = pane();
  empty.open();
  empty.error(START_REASON);
  assert.equal(banners(empty.feed()).length, 1);
  assert.deepEqual(empty.said, [{ say: "startFailed", back: 0 }]);
  empty.status("reconnecting");
  empty.open();
  empty.hello();
  assert.deepEqual(banners(empty.feed()), freshLoad());
});

test("a start that failed counts as an error for the workspace roll-up until a newer turn starts", () => {
  const p = pane();
  p.open();
  p.refused(p.send("M"));
  p.error(START_REASON);
  assert.equal(p.feed().turnError, START_REASON);
  p.status("reconnecting");
  p.open();
  p.hello();
  p.turnStart();
  assert.equal(p.feed().turnError, null);
});

test("notices in the feed that aren't a turn's failure stay when a turn starts (a11)", () => {
  const p = pane();
  p.open();
  p.hello();
  p.note("zai/glm-5.3 is turned off in Settings → Models. Pick another model, then send this again.", true);
  p.note("Couldn't reload the transcript after this run: 500");
  p.error("400 the provider refused the request");
  p.turnStart();
  assert.deepEqual(
    banners(p.feed()).map((r) => r.entry.message),
    ["zai/glm-5.3 is turned off in Settings → Models. Pick another model, then send this again.", "Couldn't reload the transcript after this run: 500"],
  );
});

test("a superseded turn failure keeps no banner but still offers its usage limit's row (a11)", () => {
  const p = pane();
  p.open();
  p.hello();
  p.error("You've hit your limit (fake)");
  p.turnStart();
  const rows = feedRows(p.feed());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.banner, null);
});

test("the same turn failure re-reported keeps one banner and is said once; the same failure of a newer turn is new", () => {
  const p = pane();
  p.open();
  p.hello();
  p.error("boom");
  p.error("boom");
  assert.equal(banners(p.feed()).length, 1);
  assert.equal(p.said.length, 1);
  p.turnStart();
  p.error("boom");
  assert.equal(banners(p.feed()).length, 1);
  assert.equal(p.said.length, 2, "the newer turn's failure is announced");
});

test("a refusal after the hello (a turn the chat refused) is still a toast and an announcement", () => {
  const p = pane();
  p.open();
  p.hello();
  const id = p.send("M");
  p.refused(id, "Another session holds this profile.");
  assert.deepEqual(p.said, [{ say: "refused", message: "Another session holds this profile." }]);
  assert.deepEqual(p.draft, ["M"]);
});
