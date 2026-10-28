// The private-text backstop's matcher (a note's, an owner update's): about 60 characters in a
// row, ignoring case and spacing; the words named are the checked text's own, widened to whole words.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holdsContact, PRIVATE_REPEAT, repeatedRun } from "./private-text-match";

const SECRET = "The owners plan to sell the academy next spring to a rival group, and staff must not know.";

describe("repeatedRun", () => {
  test("the threshold is 60 characters: one short of it is the writer's own words", () => {
    assert.equal(PRIVATE_REPEAT, 60);
    const run = SECRET.slice(0, 60);
    assert.equal(repeatedRun(`News: ${run}`, SECRET), run, "60 in a row counts");
    assert.equal(repeatedRun(`News: ${SECRET.slice(0, 59)}`, SECRET), null, "59 do not");
  });

  test("ignores case and spacing, and names the checked text's words, widened to whole words", () => {
    const text = "Quick note:\nTHE OWNERS plan to sell   the academy next spring to a rival group, and staff should hear it first.";
    assert.equal(repeatedRun(text, SECRET), "THE OWNERS plan to sell the academy next spring to a rival group, and staff");
  });

  test("a run that starts or ends mid-word is widened to the whole word of the checked text", () => {
    const secret = "xxowners plan to sell the academy next spring to a rival group and staffyy";
    assert.equal(repeatedRun("The owners plan to sell the academy next spring to a rival group and staffing.", secret), "owners plan to sell the academy next spring to a rival group and staffing");
  });

  test("the longest run wins, and a long quote is cut", () => {
    const long = `${"word ".repeat(80)}end`;
    const hit = repeatedRun(long, long)!;
    assert.ok(hit.length <= 200 && hit.endsWith("…"), hit);
  });

  test("no source, a short source or a short text: no hit", () => {
    assert.equal(repeatedRun("anything at all", ""), null);
    assert.equal(repeatedRun(SECRET, "too short"), null);
    assert.equal(repeatedRun("", SECRET), null);
  });
});

describe("holdsContact", () => {
  test("a contact value, ignoring case and spacing; under 5 characters never counts", () => {
    assert.equal(holdsContact("Mail KIM.LEE@example.test now", "kim.lee@example.test"), true);
    assert.equal(holdsContact("Call +1 555  000 0100", "+1 555 000 0100"), true);
    assert.equal(holdsContact("Call me", "1234"), false);
    assert.equal(holdsContact("anything", undefined), false);
  });
});
