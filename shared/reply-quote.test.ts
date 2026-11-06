// Run: pnpm test -- shared/reply-quote.test.ts
// A reply's text (§chat.composer/reply-text): what the model reads, and that every surface reads
// the same reply back from it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capQuote,
  cleanStagedReply,
  composeReply,
  parseReply,
  quoteFirstLine,
  replyHeader,
  replyLabel,
  replyWords,
  REPLY_ELISION,
  type StagedReply,
} from "./reply-quote";

const reply = (over: Partial<StagedReply> = {}): StagedReply => ({ entryId: "1a2b3c4d", role: "assistant", part: false, quote: "one\ntwo", trimmed: false, ...over });

test("the message the model reads: first line, quote behind '> ', blank line, then the words", () => {
  assert.equal(
    composeReply(reply(), "Why two?"),
    "[Replying to your earlier reply · 1a2b3c4d]\n> one\n> two\n\nWhy two?",
  );
});

test("the first line names whose message, and a passage", () => {
  assert.equal(replyHeader(reply()), "[Replying to your earlier reply · 1a2b3c4d]");
  assert.equal(replyHeader(reply({ role: "user" })), "[Replying to my earlier message · 1a2b3c4d]");
  assert.equal(replyHeader(reply({ part: true })), "[Replying to part of your earlier reply · 1a2b3c4d]");
  assert.equal(replyHeader(reply({ role: "user", part: true })), "[Replying to part of my earlier message · 1a2b3c4d]");
});

test("round trip: every role and part reads back as what was staged", () => {
  for (const role of ["user", "assistant"] as const) {
    for (const part of [false, true]) {
      const r = reply({ role, part, quote: "a\n\n  indented\n> already quoted" });
      const back = parseReply(composeReply(r, "words\nover two lines"));
      assert.deepEqual(back, { entryId: r.entryId, role, part, quote: r.quote, words: "words\nover two lines" });
    }
  }
});

test("an empty quote line is a bare '>' and reads back empty", () => {
  const text = composeReply(reply({ quote: "a\n\nb" }), "x");
  assert.match(text, /\n> a\n>\n> b\n\nx$/);
  assert.equal(parseReply(text)?.quote, "a\n\nb");
});

test("a quote line that itself starts with '>' keeps it", () => {
  const back = parseReply(composeReply(reply({ quote: "> nested\n>> deeper" }), "w"));
  assert.equal(back?.quote, "> nested\n>> deeper");
});

test("CRLF line ends read as \\n", () => {
  const back = parseReply("[Replying to my earlier message · abcd1234]\r\n> one\r\n> two\r\n\r\nwords");
  assert.deepEqual(back, { entryId: "abcd1234", role: "user", part: false, quote: "one\ntwo", words: "words" });
  assert.equal(capQuote("a\r\nb\rc").quote, "a\nb\nc");
});

test("a hand-typed lookalike reads as a reply (accepted by design)", () => {
  const back = parseReply("[Replying to your earlier reply · deadbeef]\n> what you said\nmy answer");
  assert.equal(back?.entryId, "deadbeef");
  assert.equal(back?.words, "my answer");
});

test("what doesn't parse: no quote line, a bad id, another first line, a later reply line", () => {
  assert.equal(parseReply("[Replying to your earlier reply · 1a2b3c4d]\n\nno quote"), null);
  assert.equal(parseReply("[Replying to your earlier reply · ab]\n> short id"), null);
  assert.equal(parseReply("[Replying to your earlier reply · has space]\n> x"), null);
  assert.equal(parseReply("[Replying to someone · 1a2b3c4d]\n> x"), null);
  assert.equal(parseReply("hello\n[Replying to your earlier reply · 1a2b3c4d]\n> x"), null);
  assert.equal(parseReply(""), null);
  assert.equal(replyWords("plain words"), "plain words");
});

test("ids: pi's 8 hex, and longer ids with - and _ up to 64", () => {
  for (const id of ["1a2b3c4d", "abcd", "a_b-c", "x".repeat(64)]) assert.equal(parseReply(`[Replying to your earlier reply · ${id}]\n> q`)?.entryId, id);
  assert.equal(parseReply(`[Replying to your earlier reply · ${"x".repeat(65)}]\n> q`), null);
  assert.equal(parseReply("[Replying to your earlier reply · a:b1]\n> q"), null);
});

test("a reply sent with no words of its own (staged answers alone) still parses", () => {
  const back = parseReply(composeReply(reply(), ""));
  assert.equal(back?.words, "");
  assert.equal(back?.quote, "one\ntwo");
});

test("the cap: up to 4,000 characters whole; over it the first 3,000 and the last 1,000 around '> […]'", () => {
  const whole = "a".repeat(4000);
  assert.deepEqual(capQuote(whole), { quote: whole, trimmed: false });
  const long = `${"h".repeat(3000)}${"m".repeat(2000)}${"t".repeat(1000)}`;
  const { quote, trimmed } = capQuote(long);
  assert.equal(trimmed, true);
  assert.equal(quote, `${"h".repeat(3000)}\n${REPLY_ELISION}\n${"t".repeat(1000)}`);
  const text = composeReply(reply({ quote, trimmed }), "w");
  assert.ok(text.includes(`\n> ${REPLY_ELISION}\n`));
  assert.ok(text.length < 4100, `${text.length}`);
});

test("the cap never splits a character in two", () => {
  const emoji = "😀"; // two UTF-16 units
  const long = `${"a".repeat(2999)}${emoji}${"b".repeat(2000)}${emoji}${"c".repeat(999)}`;
  const { quote } = capQuote(long);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(quote), "no lone high surrogate");
  assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(quote), "no lone low surrogate");
});

test("a selection's outer blank space goes; blank-only lines become empty", () => {
  assert.equal(capQuote("\n\n  hello  \n \t \nworld\n\n").quote, "  hello  \n\nworld");
});

test("labels and the one-line preview", () => {
  assert.equal(replyLabel({ role: "assistant", part: false }), "Replying to the agent's reply");
  assert.equal(replyLabel({ role: "user", part: false }), "Replying to your message");
  assert.equal(replyLabel({ role: "assistant", part: true }), "Replying to part of the agent's reply");
  assert.equal(replyLabel({ role: "user", part: true }), "Replying to part of your message");
  assert.equal(quoteFirstLine("\n\n  first\nsecond"), "  first");
});

test("a stored reply is checked field by field", () => {
  assert.deepEqual(cleanStagedReply(reply()), reply());
  assert.deepEqual(cleanStagedReply({ entryId: "1a2b3c4d", role: "user", quote: "q" }), { entryId: "1a2b3c4d", role: "user", part: false, quote: "q", trimmed: false });
  assert.equal(cleanStagedReply(null), null);
  assert.equal(cleanStagedReply({ ...reply(), entryId: "no spaces allowed" }), null);
  assert.equal(cleanStagedReply({ ...reply(), role: "system" }), null);
  assert.equal(cleanStagedReply({ ...reply(), quote: "  " }), null);
  assert.equal(cleanStagedReply({ ...reply(), quote: "x".repeat(8001) }), null);
});

test("takeBack: the first reply comes back as its words and its reply; any later one comes back whole", async () => {
  const { takeBack } = await import("./reply-quote");
  const a = composeReply(reply({ entryId: "aaaa1111" }), "first");
  const b = composeReply(reply({ entryId: "bbbb2222", role: "user" }), "second");
  const back = takeBack(["plain", a, b]);
  assert.deepEqual(back.texts, ["plain", "first", b]);
  assert.equal(back.reply?.entryId, "aaaa1111");
  assert.equal(back.reply?.trimmed, false);
  assert.deepEqual(takeBack(["no reply"]), { texts: ["no reply"], reply: null });
  const long = capQuote("x".repeat(5000));
  assert.equal(takeBack([composeReply(reply({ ...long }), "w")]).reply?.trimmed, true, "a cut quote reads back as cut");
});

test("share pages carry no message id: the reply's id is replaced, its quote and words kept", async () => {
  const { withoutReplyId, SHARED_REPLY_ID } = await import("./reply-quote");
  const shown = withoutReplyId(composeReply(reply(), "my words"));
  assert.ok(!shown.includes("1a2b3c4d"));
  assert.deepEqual(parseReply(shown), { entryId: SHARED_REPLY_ID, role: "assistant", part: false, quote: "one\ntwo", words: "my words" });
  assert.equal(withoutReplyId("plain"), "plain");
});
