// Probes owned by batch E (baton and share): the baton view for the operator and for a person, its senders,
// author notes and vocabulary, the recount, the recorded model, the photo count, and the share view's
// shown entries and branch cut. A batch edits only its own probes file, and only to follow a moved function.
import { photoCount, branchModelRef } from "../../../../baton-images";
import { countedMessages } from "../../../../baton-recount";
import { recordedModel } from "../../../../baton-told";
import { authorNotes, batonView, conversationVocabulary, messageSenders } from "../../../../baton-view";
import { branchTo, shownEntries } from "../../../../session-share-view";
import { activeBranch, parseLines } from "../../../../transcript";
import type { Probe } from "../golden";

const NAMES = { p_alice: "Alice", p_bob: "Bob", p_carol: "Carol", p_dave: "Dave", operator: "Omar" };
const ROW = { publicTitle: "Golden launch", state: "active", holder: "p_alice" } as never;

export const probes: Probe[] = [
  {
    name: "baton-view",
    formats: ["pi"],
    run(f) {
      const branch = activeBranch(parseLines(f.text));
      const view = (viewer?: string) => {
        const collect: { data: string; mimeType: string }[] = [];
        const v = batonView({ row: ROW, branch, names: NAMES, viewer: viewer as never, redact: (t) => t, collect });
        return { view: v, photos: collect.length };
      };
      return {
        operator: view(),
        bob: view("p_bob"),
        untilOffer: (() => {
          try {
            return batonView({ row: ROW, branch, names: NAMES, viewer: "p_dave" as never, redact: (t) => t, untilOffer: 2 });
          } catch (err) {
            return { $throws: String(err) };
          }
        })(),
      };
    },
  },
  {
    name: "baton-facts",
    formats: ["pi"],
    run(f) {
      const branch = activeBranch(parseLines(f.text));
      return {
        vocabulary: conversationVocabulary(branch),
        senders: messageSenders(branch, "p_alice" as never),
        sendersNoHolder: messageSenders(branch, null),
        notes: authorNotes(branch, NAMES, "p_alice" as never),
        counted: countedMessages(branch),
        model: recordedModel(branch),
        photos: photoCount(branch),
        modelRef: branchModelRef(branch),
      };
    },
  },
  {
    name: "share-view",
    formats: ["pi"],
    run(f) {
      const entries = parseLines(f.text);
      const branch = activeBranch(entries);
      const mid = branch[Math.floor(branch.length / 2)]?.id;
      const ids = (b: typeof branch | null) => (b ? b.map((e) => e.id ?? null) : null);
      return {
        shown: shownEntries(branch),
        branchTo: { leaf: ids(branchTo(entries, null)), mid: ids(branchTo(entries, typeof mid === "string" ? mid : null)), missing: ids(branchTo(entries, "no-such-entry")) },
      };
    },
  },
];
