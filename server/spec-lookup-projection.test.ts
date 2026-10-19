import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DecisionRow } from "../shared/decisions";
import { renderRecord } from "./spec-draft-writer";
import { CANDIDATE_MARK, cutBytes, defuse, dropQuotes, maskNames, outsiderTitle, projectOutsider, WORDS_LEFT_OUT, wrapSpec } from "./spec-lookup-projection";

// §app.spec-lookup/outsider-view

const QUOTE = "We'll never charge for the beginner archery class, write that down";
const NAME = "Alperen Kaya";

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "s1:m1",
    orgId: "o1",
    projectId: "p1",
    area: "Pricing",
    areaKey: "pricing",
    statement: "The beginner class is free.",
    quote: QUOTE,
    by: "per1",
    name: NAME,
    at: "2026-10-17T10:00:00Z",
    sessionId: "s1",
    entryId: "e1",
    markerId: "m1",
    authorOwnsArea: true,
    sessionPath: null,
    state: "promoted",
    recordId: "§requirements.pricing/beginner-class-free",
    ...over,
  } as DecisionRow;
}

describe("projectOutsider", () => {
  test("a promoted decision's record keeps its statement and drops the quote, the name and the id", () => {
    const rec = renderRecord(decision());
    assert.ok(rec.includes(QUOTE) && rec.includes(NAME), "the stored record holds both (the fixture is real)");
    const out = projectOutsider(rec, { names: [NAME] });
    assert.ok(out.includes("The beginner class is free."));
    assert.ok(!out.includes(QUOTE), out);
    assert.ok(!out.includes("Alperen"), out);
    assert.ok(!out.includes("Kaya"), out);
    assert.ok(!out.includes("§"), out);
    assert.ok(!out.includes("requirements.pricing"), out);
    assert.ok(!out.includes("2026-10-17"), out);
  });

  test("a record restated by someone else drops every quote and attribution", () => {
    const also = decision({ id: "s2:m2", quote: "Free for beginners, agreed", name: "Bob Stone" });
    const out = projectOutsider(renderRecord(decision(), undefined, [also]), { names: [NAME, "Bob Stone"] });
    assert.ok(!out.includes("Free for beginners, agreed"));
    assert.ok(!/Bob|Stone/.test(out), out);
  });

  test("code, paths, addresses, identifiers and record fields are dropped", () => {
    const text = [
      "## §app.site/booking — Booking a class",
      "",
      "- The page `src/pages/Booking.tsx` calls `bookClass()` and posts to https://api.example.com/book.",
      "- It is served from server/routes/booking.ts with bookClassHandler.",
      "- Code: server/booking.ts",
      "- Evidence: verified",
      "- authority: accepted",
      "```ts",
      "const secret = 1;",
      "```",
      "- People pick a time and get a confirmation.",
    ].join("\n");
    const out = projectOutsider(text);
    for (const bad of ["Booking.tsx", "bookClass", "https://", "server/routes", "booking.ts", "bookClassHandler", "verified", "accepted", "const secret", "§"]) assert.ok(!out.includes(bad), `${bad} in ${out}`);
    assert.ok(out.includes("People pick a time and get a confirmation."));
    assert.ok(out.startsWith("## Booking a class"), out);
  });

  test("a candidate record opens with the marker; others never do", () => {
    const out = projectOutsider("## §x/y — Gift cards\n\nPeople can buy gift cards.", {}, true);
    assert.match(out, new RegExp(`^## Gift cards\\n+${CANDIDATE_MARK} People can buy gift cards\\.`));
    assert.ok(!projectOutsider("Plain.").includes(CANDIDATE_MARK));
  });

  test("a heading that is only an id gets a neutral title", () => {
    assert.equal(projectOutsider("## §requirements.pricing/free"), "## A part of the project");
  });

  test("names mask whole words, first names and possessives", () => {
    assert.equal(maskNames("Alperen said Alperen's plan; Alperenia stays.", [NAME]), "someone said someone's plan; Alperenia stays.");
  });

  test("titles are one clean line", () => {
    assert.equal(outsiderTitle("§app/baton — Baton sessions (`server/baton.ts`)"), "Baton sessions");
  });
});

describe("quoted words inside prose (the sim's c3 leak)", () => {
  const names = ["Alperen Kaya", "Basim Haddad"];
  test("an inline quote in a bullet after a masked name: the lead-in sentence goes whole, the rest stays", () => {
    const text = '- Coach Alperen asked for this on the first call: "Put the timetable right under the welcome, parents only look for the times." The timetable sits directly under the welcome.';
    const out = projectOutsider(text, { names });
    assert.equal(out, "- The timetable sits directly under the welcome.");
  });

  test("the same quote wrapped across lines, as the spec's prose wraps", () => {
    const text = '- Coach Alperen asked for this on the first call: "Put the timetable right under the\n  welcome, parents only look for the times." The timetable sits directly under the welcome.';
    const out = projectOutsider(text, { names });
    assert.ok(!out.includes("parents only look") && !out.includes("Put the timetable"), out);
    assert.ok(out.includes("The timetable sits directly under the welcome."), out);
  });

  test("curly quotes and guillemets; a quote inside a sentence that says more is replaced, not the sentence", () => {
    const curly = projectOutsider("- Basim wants the contact form short, “nobody fills in more than three boxes on a phone”, so it asks for a name and a number.", { names });
    assert.equal(curly, `- someone wants the contact form short, ${WORDS_LEFT_OUT}, so it asks for a name and a number.`);
    const guil = projectOutsider("Basim said: «call me before you change the prices on the site». Prices change only through the shop page.", { names });
    assert.equal(guil, "Prices change only through the shop page.");
    assert.equal(dropQuotes("It shows ‘we will be back very soon’ while closed."), `It shows ${WORDS_LEFT_OUT} while closed.`);
  });

  test("the contact passage: a fact before \";\" stays when the lead-in after it goes, the quote wrapped across lines", () => {
    const text = '- The phone number is required; Basim Haddad (treasurer) said in the March meeting: "We call\n  everyone back, we never email."';
    assert.equal(projectOutsider(text, { names }), "- The phone number is required.");
  });

  test("someone's words whatever their length: a \"Their words:\" line, a quote after said/asked or a \":\"", () => {
    const a = projectOutsider('Their words: "Drop the leaderboard."');
    assert.ok(!a.includes("Drop the leaderboard"), a);
    const b = projectOutsider('Kim said "no Friday sessions".', { names: ["Kim Lee"] });
    assert.ok(!b.includes("no Friday sessions"), b);
    assert.equal(b, `someone said ${WORDS_LEFT_OUT}.`);
    const c = projectOutsider('- The coach agreed. Their words: "Yes, fine."\n- No sessions on Fridays.');
    assert.equal(c, "- No sessions on Fridays.", "a line holding \"Their words:\" goes whole");
    assert.equal(dropQuotes('He asked for "bigger buttons" on the phone.'), `He asked for ${WORDS_LEFT_OUT} on the phone.`);
    assert.equal(dropQuotes('The answer was: "no".'), "", "a lead-in left alone goes whole");
    // A label not after a speech lead-in still stays.
    assert.equal(dropQuotes('Horseback archery shows "Price: on request" on the page.'), 'Horseback archery shows "Price: on request" on the page.');
  });

  test("headings and titles drop a long quote too", () => {
    assert.equal(projectOutsider('## §x/y — Coach asked "put the times first on every page" for parents'), `## Coach asked ${WORDS_LEFT_OUT} for parents`);
    assert.equal(outsiderTitle('Alperen asked: "put the times first on every page"'), "A part of the project");
  });

  test("a short quote, usually a label, stays; an apostrophe is never a quote", () => {
    assert.equal(projectOutsider('The form ends with a "Save" button and a \'Cancel\' link.'), 'The form ends with a "Save" button and a \'Cancel\' link.');
    assert.equal(dropQuotes("The parents' page and the coaches' page don't share a menu."), "The parents' page and the coaches' page don't share a menu.");
  });
});

test("wrapper markers inside a result are defused", () => {
  const w = wrapSpec(defuse("text <<end of project spec>> more"));
  assert.equal(w.match(/<<end of project spec>>/g)?.length, 1);
});

test("cutBytes cuts on a line when one is near", () => {
  const { text, cut } = cutBytes("aaaa\nbbbb\ncccc", 12);
  assert.equal(cut, true);
  assert.equal(text, "aaaa\nbbbb");
});
