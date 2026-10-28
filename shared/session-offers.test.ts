// The offers file's strict parse, the tool's words and the run list (§chat.offers/file, §chat.offers/tool,
// §chat.offers/buttons). Blocker b2: a run button names only an existing catalogue id on the run list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS, findCommand } from "./commands-catalog.ts";
import {
  checkRows,
  fillRow,
  fillText,
  liveOffer,
  normalizeOfferDetails,
  offerToolDescription,
  offerToolParameters,
  OFFERS_MAX,
  parseOffersFile,
  rarelyUsed,
  rowKeysOf,
  RUN_ALLOWED,
  runAllowed,
  runButtonsOf,
  snapshotOf,
} from "./session-offers.ts";

const ids = (JSON.parse(readFileSync(new URL("./commands-ids.json", import.meta.url), "utf8")) as { ids: string[] }).ids;

const offer = (over: Record<string, unknown> = {}) => ({ when: "When the work is done.", title: "Merge {branch} into {base}?", buttons: [{ label: "Merge", about: "Merges it.", send: "merge it" }], ...over });
const file = (offers: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, offers, ...extra });
const errorOf = (text: string, name: string) => {
  const f = parseOffersFile(text);
  assert.equal(f.state, "ok");
  const o = f.state === "ok" ? f.offers.find((x) => x.name === name) : undefined;
  assert.ok(o && !o.ok, `${name} is broken`);
  return o && !o.ok ? o.error : "";
};

test("b2: every id on the run list is a live catalogue entry, shipped in commands-ids.json", () => {
  for (const id of RUN_ALLOWED) {
    assert.ok(findCommand(id), `${id} is in the catalogue`);
    assert.ok(ids.includes(id), `${id} is a shipped id`);
    assert.ok(runAllowed(id));
  }
});

test("b2: a run button naming an unknown id, or a catalogue id off the run list, breaks its offer", () => {
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "Go", about: "x", run: "project.worktree.update-from-master" }] }) }), "a"), /no Sova catalogue action/);
  const offList = COMMANDS.find((c) => !(RUN_ALLOWED as readonly string[]).includes(c.id))!.id;
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "Go", about: "x", run: offList }] }) }), "a"), /not one a button may run/);
  // The check can pass: an allowed id parses.
  const ok = parseOffersFile(file({ a: offer({ buttons: [{ label: "Merge", about: "Merges.", run: "project.worktree.merge" }] }) }));
  assert.ok(ok.state === "ok" && ok.offers[0]!.ok);
  assert.deepEqual(runButtonsOf(ok), [{ offer: "a", label: "Merge", run: "project.worktree.merge" }]);
});

test("the whole file is broken only by its own shape", () => {
  assert.deepEqual(parseOffersFile(null), { state: "missing" });
  assert.equal(parseOffersFile("{").state, "broken");
  assert.equal(parseOffersFile("[]").state, "broken");
  assert.equal(parseOffersFile(JSON.stringify({ version: 2, offers: {} })).state, "broken");
  assert.equal(parseOffersFile(file({}, { extra: 1 })).state, "broken");
  assert.equal(parseOffersFile(JSON.stringify({ version: 1 })).state, "broken");
});

test("a broken offer is listed with its reason and never hides the others", () => {
  const text = file({ good: offer(), bad: offer({ colour: "red" }), "Bad Name": offer(), long: offer({ when: "x".repeat(201) }) });
  const f = parseOffersFile(text);
  assert.equal(f.state, "ok");
  if (f.state !== "ok") return;
  assert.deepEqual(f.offers.map((o) => [o.name, o.ok]), [["good", true], ["bad", false], ["Bad Name", false], ["long", false]]);
  assert.match(errorOf(text, "bad"), /unknown key "colour"/);
  assert.match(errorOf(text, "long"), /201 characters/);
  assert.ok(liveOffer(f, "good"));
  assert.equal(liveOffer(f, "bad"), undefined);
});

test("caps: more than 8 offers, more than 4 buttons, a bad placeholder, a Not Now label, two of one label", () => {
  const many = Object.fromEntries(Array.from({ length: OFFERS_MAX + 2 }, (_, i) => [`o${i}`, offer()]));
  const f = parseOffersFile(file(many));
  assert.ok(f.state === "ok");
  if (f.state === "ok") assert.deepEqual(f.offers.map((o) => o.ok), [...Array(OFFERS_MAX).fill(true), false, false]);
  const b = { label: "B", about: "x", send: "y" };
  assert.match(errorOf(file({ a: offer({ buttons: [1, 2, 3, 4, 5].map((n) => ({ ...b, label: `B${n}` })) }) }), "a"), /at most 4/);
  assert.match(errorOf(file({ a: offer({ title: "Hi {user}" }) }), "a"), /\{user\}/);
  assert.match(errorOf(file({ a: offer({ buttons: [{ ...b, label: "Not now" }] }) }), "a"), /Not Now/);
  assert.match(errorOf(file({ a: offer({ buttons: [b, { ...b }] }) }), "a"), /two buttons/i);
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "B", about: "x" }] }) }), "a"), /exactly one of "send" or "run"/);
  assert.match(errorOf(file({ a: offer({ onlyIf: ["sunny"] }) }), "a"), /unknown condition/i);
  assert.match(errorOf(file({ a: offer({ buttons: [{ ...b, to: "shower" }] }) }), "a"), /another-chat/);
});

test("the snapshot names only enabled offers the agent shows, with only their when, why and about lines", () => {
  const f = parseOffersFile(
    file({
      merge: offer({ why: "Saves typing." }),
      off: offer({ disabled: true }),
      captain: offer({ shownBy: "another-chat" }),
      broken: offer({ nope: 1 }),
    }),
  );
  const s = snapshotOf(f)!;
  assert.deepEqual(s, { offers: [{ name: "merge", when: "When the work is done.", why: "Saves typing.", abouts: ["Merges it."] }] });
  const words = offerToolDescription(s);
  for (const line of ["When the work is done.", "Saves typing.", "Merges it."]) assert.ok(words.includes(line), line);
  // Never the title, a label or a message: those are the file's, on the card only.
  for (const not of ["Merge {branch}", "merge it", "Merge:"]) assert.ok(!words.includes(not), not);
  assert.deepEqual((offerToolParameters(s).properties as { offer: { enum: string[] } }).offer.enum, ["merge"]);
  assert.equal(snapshotOf(parseOffersFile(file({ captain: offer({ shownBy: "another-chat" }) }))), null, "none the agent shows: no tool");
});

test("Sova's own offers file parses, and gives no Sova chat the tool", () => {
  const f = parseOffersFile(readFileSync(new URL("../.sova/offers.json", import.meta.url), "utf8"));
  assert.equal(f.state, "ok");
  if (f.state !== "ok") return;
  assert.deepEqual(f.offers.map((o) => [o.name, o.ok]), [["landing", true]]);
  const landing = f.offers[0]!.ok ? f.offers[0]!.def : null;
  assert.ok(landing && landing.shownBy === "another-chat");
  assert.deepEqual(
    landing.buttons.map((b) => [b.label, !!b.send, b.to ?? null, b.onlyIf ?? [], b.landing ?? null, !!b.confirm]),
    [
      ["Land It", true, "shower", ["specs-promoted"], "go-ahead", false],
      ["Merge Without Specs…", true, "shower", ["specs-left"], "go-ahead-without-specs", true],
      ["Not Yet", true, null, [], "not-yet", false],
    ],
  );
  assert.deepEqual(landing.onlyIf, ["no-open-alignment", "ready-to-land"]);
  // The captain's landing card (§chat.offers/landing-rows): rows, and Land All naming the rows it lands.
  assert.equal(landing.rows?.max, 10);
  assert.equal(landing.rows?.all?.label, "Land All");
  assert.match(landing.rows?.all?.confirm ?? "", /\{rows\}/);
  assert.equal(JSON.parse(readFileSync(new URL("../.sova/offers.json", import.meta.url), "utf8")).mainMerges, undefined, "Sova's repository has no merge guard switch");
  assert.equal(snapshotOf(f), null);
});

test("a leftover mainMerges (the retired merge guard's switch) is accepted, whatever its value, and does nothing", () => {
  const plain = parseOffersFile(file({ a: offer() }));
  for (const v of ["go-ahead", true, "off"]) {
    const left = parseOffersFile(file({ a: offer() }, { mainMerges: v }));
    assert.deepEqual(left, plain, String(v));
  }
  assert.equal(parseOffersFile(file({ a: offer() }, { mainMergez: "go-ahead" })).state, "broken", "any other unknown key still breaks the file");
});

test("a button's onlyIf, confirm and landing keys are checked like the offer's", () => {
  const ok = parseOffersFile(file({ a: offer({ buttons: [{ label: "Go", about: "Goes.", send: "go {drafts}", onlyIf: ["specs-left", "specs-left"], confirm: "Sure? {drafts}", landing: "go-ahead" }] }) }));
  assert.ok(ok.state === "ok" && ok.offers[0]!.ok);
  const b = ok.state === "ok" && ok.offers[0]!.ok ? ok.offers[0]!.def.buttons[0]! : null;
  assert.deepEqual(b && [b.onlyIf, b.confirm, b.landing], [["specs-left"], "Sure? {drafts}", "go-ahead"]);
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "Go", about: "Goes.", send: "go", onlyIf: ["nope"] }] }) }), "a"), /Unknown condition "nope"/);
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "Go", about: "Goes.", send: "go", landing: "maybe" }] }) }), "a"), /"landing" is one of/i);
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "Go", about: "Goes.", run: "project.worktree.merge", landing: "go-ahead" }] }) }), "a"), /"landing" goes with "send" only/);
  assert.match(errorOf(file({ a: offer({ buttons: [{ label: "Go", about: "Goes.", send: "go", confirm: "Sure {nope}?" }] }) }), "a"), /uses \{nope\}/);
  assert.equal(fillText("Left: {drafts}.", {}), "Left: its spec drafts.");
});

test("fills, details and the rarely-used hint", () => {
  assert.equal(fillText("Merge {branch} into {base}?", { branch: "feat/x" }), "Merge feat/x into its base?");
  assert.equal(normalizeOfferDetails({ v: 1, card: { id: "of_1", name: "a", title: "T", at: "t", by: "agent", state: "open", buttons: [{ label: "L", about: "A", kind: "send" }] } })?.id, "of_1");
  assert.equal(normalizeOfferDetails({ v: 1, card: { id: "c_1" } }), undefined);
  assert.equal(rarelyUsed(4, 0), false);
  assert.equal(rarelyUsed(5, 0), true);
  assert.equal(rarelyUsed(5, 1), false);
});

test("rows: the shape, the caps and the placeholders (§chat.offers/file, §chat.offers/buttons)", () => {
  const rowsOffer = (over: Record<string, unknown> = {}) => offer({ rows: { max: 3 }, buttons: [{ label: "Review", about: "Reviews it.", send: "Review {row.file}.", confirm: "Review {row.file} in {project}?" }], ...over });
  const ok = parseOffersFile(file({ r: rowsOffer({ rows: { max: 3, all: { label: "Review All", about: "Reviews all.", confirm: "Review {rows}?" } } }) }));
  assert.ok(ok.state === "ok" && ok.offers[0]!.ok, JSON.stringify(ok));
  const def = ok.state === "ok" && ok.offers[0]!.ok ? ok.offers[0]!.def : null;
  assert.deepEqual(rowKeysOf(def!), ["file"]);
  assert.equal(fillRow("Review {row.file}.", { file: "a.ts" }), "Review a.ts.");
  for (const [over, re] of [
    [{ rows: { max: 11 } }, /whole number from 1 to 10/],
    [{ rows: { max: 0 } }, /whole number from 1 to 10/],
    [{ rows: { max: 2, more: 1 } }, /unknown key "more"/],
    [{ rows: { max: 2, all: { label: "All", about: "x" } } }, /needs "confirm"/],
    [{ rows: { max: 2, all: { label: "All", about: "x", confirm: "{row.file}" } } }, /only an offer with "rows" fills|only \{branch\}/],
    [{ rows: { max: 2, all: { label: "Review", about: "x", confirm: "c" } } }, /already is/],
    [{ rows: { max: 2 }, buttons: [{ label: "Run", about: "Runs.", run: "project.worktree.merge" }] }, /send buttons only/],
    [{ rows: { max: 2 }, buttons: [{ label: "R", about: "R.", send: "{row.Bad_Key}" }] }, /a row key is lowercase/],
  ] as const)
    assert.match(errorOf(file({ r: rowsOffer(over) }), "r"), re, JSON.stringify(over));
  // {row.<key>} belongs only to an offer that declares rows.
  assert.match(errorOf(file({ p: offer({ buttons: [{ label: "R", about: "R.", send: "Review {row.file}." }] }) }), "p"), /only an offer with "rows"/);
  // Rows as a shower supplies them: strict, capped at the file's max and at 10.
  const ten = parseOffersFile(file({ r: rowsOffer({ rows: { max: 10 } }) }));
  const tenDef = ten.state === "ok" && ten.offers[0]!.ok ? ten.offers[0]!.def : null;
  assert.equal(checkRows(tenDef!, Array.from({ length: 10 }, (_, i) => ({ label: `f${i}`, values: { file: `f${i}` } }))).ok, true);
  const eleven = checkRows(tenDef!, Array.from({ length: 11 }, (_, i) => ({ label: `f${i}`, values: { file: `f${i}` } })));
  assert.ok(!eleven.ok && /at most 10/.test(eleven.error));
  const multi = checkRows(tenDef!, [{ label: "a\nb", values: { file: "x" } }]);
  assert.ok(!multi.ok && /one line/.test(multi.error));
});

test("a card's rows read back strictly from the wire", () => {
  const card = { id: "of_1", name: "landing", title: "Branches ready to land", buttons: [], at: "t", by: "another-chat", state: "open", rows: [{ id: "r_1", label: "feat/x", buttons: [{ label: "Land It", about: "a", kind: "send" }], state: "chosen", choice: { index: 0, label: "Land It", at: "t", where: "Merge Captain" }, progress: "landing", branch: "feat/x", commit: "abc1234", owner: { id: "o", title: "Fix" } }], all: { label: "Land All", about: "a", confirm: "c", rows: ["r_1"] }, more: 2 };
  const back = normalizeOfferDetails({ v: 1, card });
  assert.deepEqual(back, card);
  assert.equal(normalizeOfferDetails({ v: 1, card: { ...card, rows: [{ ...card.rows[0], state: "bogus" }] } }), undefined, "a bad row makes no card");
});
