// Run: pnpm test -- shared/view-cards.test.ts
// The data cards' shapes and checks (§chat.transcript-cards/data-cards): each card's limits, strict
// keys, the first broken field by its path, the 64 KB cap, and the reserved height.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CARD_DATA_MAX_BYTES, checkCardData, dataCardHeight, letterIndex, LIMITS, notRaisedText, type DataCardKind } from "./view-cards";

const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i}`, tradeoff: "t" }));
const q = (over: Record<string, unknown> = {}) => ({ title: "Format", ask: "JSON or SQLite?", options: opts(2), ...over });
const broke = (kind: DataCardKind, data: unknown): string => {
  const r = checkCardData(kind, data);
  assert.equal(r.ok, false, `expected ${kind} to be refused`);
  return r.ok ? "" : `${r.error.path} ${r.error.why}`;
};
const passes = (kind: DataCardKind, data: unknown) => {
  const r = checkCardData(kind, data);
  assert.ok(r.ok, r.ok ? "" : `${r.error.path} ${r.error.why}`);
  return r.data;
};

describe("question", () => {
  test("2 to 8 lettered options, an optional context and recommendation", () => {
    passes("question", q());
    passes("question", q({ options: opts(8), context: "Why it matters", recommendation: { option: "h", why: "fast" } }));
    assert.equal(broke("question", q({ options: opts(1) })), "options has fewer than 2 options");
    assert.equal(broke("question", q({ options: opts(9) })), "options has more than 8 options");
  });

  test("the spec's own example names the field by its path", () => {
    const options = opts(3);
    options[2]!.label = "x".repeat(LIMITS.optionLabel + 1);
    assert.equal(broke("question", q({ options })), "options[2].label is longer than 120 characters");
    const r = checkCardData("question", q({ options }));
    assert.equal(r.ok ? "" : notRaisedText(r.error), "Nothing was raised: options[2].label is longer than 120 characters.");
  });

  test("the recommendation names an option by its letter", () => {
    assert.equal(broke("question", q({ recommendation: { option: "c", why: "w" } })), "recommendation.option is not the letter of an option (a to b)");
    assert.equal(broke("question", q({ recommendation: { option: "B", why: "w" } })), "recommendation.option is not the letter of an option (a to b)");
    assert.equal(broke("question", q({ recommendation: { option: "a" } })), "recommendation.why is missing");
    assert.equal(letterIndex("b", 2), 1);
    assert.equal(letterIndex("c", 2), undefined);
  });

  test("two options with one label are refused, so a recommendation can only name one", () => {
    assert.equal(broke("question", q({ options: [{ label: "Same" }, { label: " same " }] })), "options[1].label repeats another option's label");
  });

  test("strict: unknown keys, wrong types, empty and multi-line titles", () => {
    assert.equal(broke("question", q({ extra: 1 })), "extra is not a field this card has");
    assert.equal(broke("question", q({ options: [{ label: "a", why: "x" }, { label: "b" }] })), "options[0].why is not a field this card has");
    assert.equal(broke("question", q({ title: 3 })), "title is not text");
    assert.equal(broke("question", q({ title: "  " })), "title is empty");
    assert.equal(broke("question", q({ title: "a\nb" })), "title is more than one line");
    assert.equal(broke("question", { ask: "?", options: opts(2) }), "title is missing");
    assert.equal(broke("question", [1]), "data is not an object");
  });

  test("the checked data carries nothing but its fields", () => {
    const d = passes("question", q({ context: undefined }));
    assert.deepEqual(Object.keys(d).sort(), ["ask", "options", "title"]);
  });
});

describe("checklist", () => {
  test("1 to 50 items, each a line and whether it is done", () => {
    passes("checklist", { title: "Steps", items: [{ text: "Build", done: true }] });
    assert.equal(broke("checklist", { title: "Steps", items: [] }), "items has no items");
    assert.equal(broke("checklist", { title: "Steps", items: Array.from({ length: 51 }, () => ({ text: "x", done: false })) }), "items has more than 50 items");
    assert.equal(broke("checklist", { title: "Steps", items: [{ text: "x", done: "yes" }] }), "items[0].done is not true or false");
  });
});

describe("status", () => {
  test("a tone of the reply chips', a line and an optional detail", () => {
    for (const tone of ["ok", "warn", "error", "info", "muted"]) passes("status", { title: "Build", tone, line: "Green" });
    assert.equal(broke("status", { title: "Build", tone: "success", line: "x" }), "tone is not one of ok, warn, error, info, muted");
    assert.equal(broke("status", { title: "Build", tone: "ok", line: "a\nb" }), "line is more than one line");
  });
});

describe("table", () => {
  test("1 to 12 heads and up to 200 rows of plain cells, each row as wide as the heads", () => {
    passes("table", { columns: ["a"], rows: [] });
    passes("table", { title: "T", columns: ["a", "b"], rows: Array.from({ length: 200 }, () => ["1", ""]) });
    assert.equal(broke("table", { columns: [], rows: [] }), "columns has no columns");
    assert.equal(broke("table", { columns: Array.from({ length: 13 }, (_, i) => `c${i}`), rows: [] }), "columns has more than 12 columns");
    assert.equal(broke("table", { columns: ["a"], rows: Array.from({ length: 201 }, () => ["1"]) }), "rows has more than 200 rows");
    assert.equal(broke("table", { columns: ["a", "b"], rows: [["1"]] }), "rows[0] has fewer than 2 cells");
    assert.equal(broke("table", { columns: ["a"], rows: [[1]] }), "rows[0][0] is not text");
  });
});

describe("buttons", () => {
  const b = (does: unknown, over: Record<string, unknown> = {}) => ({ title: "Next", buttons: [{ label: "Go", does, ...over }] });
  test("1 to 4 buttons that answer, send a text or run one command", () => {
    passes("buttons", b({ kind: "answer" }));
    passes("buttons", b({ kind: "send", text: "Go ahead." }, { about: "Sends it", confirm: "Sure?" }));
    passes("buttons", b({ kind: "run", command: "session.send", params: { text: "x" } }));
    assert.equal(broke("buttons", { title: "N", buttons: [] }), "buttons has no buttons");
    assert.equal(broke("buttons", { title: "N", buttons: Array.from({ length: 5 }, (_, i) => ({ label: `B${i}`, does: { kind: "answer" } })) }), "buttons has more than 4 buttons");
  });
  test("a label is at most 32 characters, an about one line", () => {
    assert.equal(broke("buttons", b({ kind: "answer" }, { label: "x".repeat(33) })), "buttons[0].label is longer than 32 characters");
    assert.equal(broke("buttons", b({ kind: "answer" }, { about: "a\nb" })), "buttons[0].about is more than one line");
  });
  test("what a press does takes only its own fields", () => {
    assert.equal(broke("buttons", b({ kind: "answer", text: "x" })), "buttons[0].does answers the card, so it takes nothing else");
    assert.equal(broke("buttons", b({ kind: "send" })), "buttons[0].does.text is not text");
    assert.equal(broke("buttons", b({ kind: "run", command: "Not An Id" })), "buttons[0].does.command is not a command id");
    assert.equal(broke("buttons", b({ kind: "run", command: "session.send", params: [] })), "buttons[0].does.params is not an object");
    assert.equal(broke("buttons", b({ kind: "merge" })), "buttons[0].does.kind is not one of answer, send, run");
  });
});

test("a card's data is at most 64 KB", () => {
  const big = { columns: ["a"], rows: Array.from({ length: 200 }, () => ["x".repeat(400)]) };
  assert.ok(JSON.stringify(big).length > CARD_DATA_MAX_BYTES);
  assert.equal(broke("table", big), "data is larger than 64 KB");
  assert.equal(broke("table", { columns: ["a"], rows: [], n: 10n }), "data is not JSON");
});

test("an unknown card is refused by name", () => {
  assert.equal(broke("chart" as DataCardKind, {}), "draws is not one of question, checklist, status, table, buttons");
});

test("the reserved height grows with the data and caps a table at its shown rows", () => {
  const small = dataCardHeight("question", passes("question", q()) as never);
  const big = dataCardHeight("question", passes("question", q({ options: opts(8), context: "c ".repeat(200) })) as never);
  assert.ok(big > small && small > 0);
  const t10 = dataCardHeight("table", passes("table", { columns: ["a"], rows: Array.from({ length: 10 }, () => ["1"]) }) as never);
  const t200 = dataCardHeight("table", passes("table", { columns: ["a"], rows: Array.from({ length: 200 }, () => ["1"]) }) as never);
  assert.equal(t200 - t10, 52, "past 10 rows only the Show All button adds");
});
