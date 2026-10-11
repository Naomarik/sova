// An overseer's prompt fixed at opening (overseer-opening.ts): the opening values and what was told
// are read back from the run notes on the branch; a part is told once per change, again after a
// compaction, and a part that went away is told as removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HEntry } from "../shared/harness";
import { CARDS_NOTE_MESSAGE } from "../shared/overseer-card";
import { changedText, openingOn, partPrint, toldOn, type LivePart } from "./overseer-opening";

const note = (details: unknown): HEntry => ({ kind: "note", noteType: CARDS_NOTE_MESSAGE, content: "", display: false, details, inMessage: false }) as HEntry;
const parts = (notes: string, extra = ""): LivePart[] => [
  { key: "NOTES", title: "Standing notes", text: notes },
  { key: "EXTRA", title: "Extra", text: extra },
];

test("the first note's opening values stand; the told fingerprints override them, one change at a time", () => {
  const opening = { NOW: "t0", NOTES: "a" };
  const branch: HEntry[] = [note({ v: 1, opening }), note({ v: 1, opening: { NOW: "later" } })];
  assert.deepEqual(openingOn(branch), opening, "the first one holds");
  assert.equal(openingOn([note({ v: 1, cleared: [] })]), undefined);

  const told = toldOn(branch, parts("a"));
  const first = changedText(parts("b"), told);
  assert.match(first.text!, /## Standing notes \(now\)\n\nb/);
  assert.deepEqual(first.told, { NOTES: partPrint("b") });
  // Once told, the same text is not told again.
  const after = [...branch, note({ v: 1, told: first.told })];
  assert.equal(changedText(parts("b"), toldOn(after, parts("a"))).text, undefined);
  // A compaction summarizes the note away: the prompt's opening text stands again, so it is told again.
  const compacted = [...after, { kind: "compaction", summary: "…" } as HEntry];
  assert.match(changedText(parts("b"), toldOn(compacted, parts("a"))).text!, /Standing notes \(now\)/);
  // Emptied, and a part the prompt has that is gone now.
  assert.match(changedText(parts(""), toldOn(after, parts("a"))).text!, /## Standing notes \(now\)\n\n\(now empty\)/);
  const gone = changedText([parts("a")[0]!], toldOn([], [...parts("a"), { key: "section:# Roster", title: "Roster", text: "Tony" }]));
  assert.match(gone.text!, /## Roster \(now\)\n\n\(removed: disregard that part of your system prompt\)/);
});
