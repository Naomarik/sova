import assert from "node:assert/strict";
import { test } from "node:test";
import { checkViewData, schemaError } from "./card-schema";
import { needsUpdatingText, parseCardFile, viewAnswerOf } from "./transcript-cards";

// A view's declared data shape (§chat.transcript-cards/files) and its check (/data-cards).

const shape = {
  type: "object",
  required: ["title", "points"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 40 },
    tone: { enum: ["ok", "warn"] },
    points: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", required: ["x"], properties: { x: { type: "integer" }, y: { type: ["number", "null"] } } } },
  },
};

test("a shape says only types, required fields, enums and string and array lengths; anything else is refused, by its path", () => {
  assert.equal(schemaError(shape), null);
  assert.match(schemaError({ type: "object", pattern: "x" })!, /^data\.pattern is not something a card's data shape may say/);
  assert.match(schemaError({ properties: { a: { $ref: "#/x" } } })!, /^data\.properties\.a\.\$ref is not/);
  assert.match(schemaError({ items: { type: "date" } })!, /^data\.items\.type must be one of/);
  assert.match(schemaError({ maxLength: -1 })!, /maxLength must be a whole number/);
  assert.match(schemaError({ enum: [{}] })!, /enum must list/);
  assert.match(schemaError("object")!, /must be an object/);
});

test("data checked against its shape: the first field that broke a rule, by its path", () => {
  const ok = { title: "Build times", points: [{ x: 1, y: 2.5 }, { x: 2, y: null }] };
  assert.deepEqual(checkViewData(shape, ok), { ok: true, data: ok });
  const why = (d: unknown) => {
    const c = checkViewData(shape, d);
    return c.ok ? "ok" : `${c.error.path} ${c.error.why}`;
  };
  assert.equal(why({ points: [{ x: 1 }] }), "title is missing");
  assert.equal(why({ title: "", points: [{ x: 1 }] }), "title is empty");
  assert.equal(why({ title: "x".repeat(41), points: [{ x: 1 }] }), "title is longer than 40 characters");
  assert.equal(why({ title: "t", tone: "bad", points: [{ x: 1 }] }), 'tone must be one of "ok", "warn"');
  assert.equal(why({ title: "t", points: [] }), "points has fewer than 1 items");
  assert.equal(why({ title: "t", points: [{ x: 1 }, { x: 1.5 }] }), "points[1].x must be integer");
  assert.equal(why({ title: "t", points: [{ x: 1, y: "2" }] }), "points[0].y must be number or null");
  assert.equal(why({ title: "t", points: [{}] }), "points[0].x is missing");
  assert.equal(why("x".repeat(70 * 1024)), "data is larger than 64 KB");
});

test("card.json for a view: its shape checked, its toolkit kept whatever it is (the card says when it needs updating)", () => {
  const file = (o: Record<string, unknown>) => JSON.stringify({ version: 1, toolkit: 1, title: "Chart", draws: "view", data: shape, ...o });
  const v1 = parseCardFile("chart", file({}), true);
  assert.ok(v1.ok && v1.decl.toolkit === 1 && v1.decl.draws === "view");
  const v2 = parseCardFile("chart", file({ toolkit: 2 }), true);
  assert.ok(v2.ok && v2.decl.toolkit === 2, "another toolkit is still a type: its card says it needs updating");
  assert.equal(needsUpdatingText(2), "This card needs updating for this Sova: it was built for toolkit v2, and this Sova runs v1.");
  const bad = parseCardFile("chart", file({ data: { type: "object", format: "date" } }), true);
  assert.ok(!bad.ok && /data\.format is not something/.test(bad.error));
  const noVersion = parseCardFile("chart", file({ toolkit: "1" }), true);
  assert.ok(!noVersion.ok && /toolkit must be the toolkit version/.test(noVersion.error));
});

test("a view's own answer: one line of words, and any JSON it carries", () => {
  assert.deepEqual(viewAnswerOf({ text: " 3 bars ", value: { n: 3 } }), { ok: true, value: { view: { text: "3 bars", value: { n: 3 } } }, text: "3 bars" });
  assert.deepEqual(viewAnswerOf({ view: { text: "ok" } }), { ok: true, value: { view: { text: "ok", value: null } }, text: "ok" });
  assert.ok(!viewAnswerOf({ text: "" }).ok);
  assert.ok(!viewAnswerOf({ text: "a\nb" }).ok);
  assert.ok(!viewAnswerOf({ text: "x".repeat(201) }).ok);
  assert.ok(!viewAnswerOf({ text: "ok", value: "x".repeat(17 * 1024) }).ok);
});
