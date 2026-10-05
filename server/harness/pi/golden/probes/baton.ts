// Probes owned by batch E (baton and share): the baton view for the operator and for a person, its senders,
// author notes and vocabulary, the recount, the recorded model, the photo count, and the share view's
// shown entries and branch cut, the told summary (the recorded prompt, model and thinking) and each person's
// own messages for the wrap-up. A batch edits only its own probes file, and only to follow a moved function.
import { photoCount, branchModelRef } from "../../../../baton-images";
import { countedMessages } from "../../../../baton-recount";
import { piReplay, recordedModel, recordedPrompt } from "../../../../baton-told";
import { authorNotes, batonView, conversationVocabulary, messageSenders } from "../../../../baton-view";
import { messagesByPerson } from "../../../../baton-wrapup";
import { branchTo, shownEntries } from "../../../../session-share-view";
import { branchOf, parsePi, rawOf } from "../../reader";
import type { Probe } from "../golden";

const NAMES = { p_alice: "Alice", p_bob: "Bob", p_carol: "Carol", p_dave: "Dave", operator: "Omar" };
const ROW = { publicTitle: "Golden launch", state: "active", holder: "p_alice" } as never;

export const probes: Probe[] = [
  {
    name: "baton-view",
    formats: ["pi"],
    run(f) {
      const branch = branchOf(parsePi(f.text).entries);
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
      const branch = branchOf(parsePi(f.text).entries);
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
      const file = parsePi(f.text);
      const branch = branchOf(file.entries);
      const mid = branch[Math.floor(branch.length / 2)]?.id;
      const ids = (b: typeof branch | null) => (b ? b.map((e) => e.id ?? null) : null);
      return {
        // The shown entry as the file has it (the probe recorded pi's raw entry before the move).
        shown: shownEntries(branch).map((s) => ({ ...s, e: rawOf(s.e) })),
        branchTo: { leaf: ids(branchTo(file, null)), mid: ids(branchTo(file, typeof mid === "string" ? mid : null)), missing: ids(branchTo(file, "no-such-entry")) },
      };
    },
  },
  {
    name: "baton-told",
    formats: ["pi"],
    async run(f) {
      const branch = branchOf(parsePi(f.text).entries);
      const replay = await piReplay();
      try {
        return { prompt: recordedPrompt(branch, replay), model: recordedModel(branch) };
      } catch (err) {
        return { $throws: String(err) };
      }
    },
  },
  {
    name: "baton-wrapup",
    formats: ["pi"],
    run(f) {
      return { mine: messagesByPerson(branchOf(parsePi(f.text).entries)) };
    },
  },
];
