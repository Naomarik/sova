// Probes owned by batch H (chat-manager history and the fork copy): the strict fork reader, the fork prefix
// for every entry on the branch plus an abandoned and a missing id, the regenerate target and the rewind
// check for every id, and the chat's title. A batch edits only its own probes file, and only to follow a
// moved function (README.md).
import { resolveRegenerate, rewindSession, titleOf } from "../../../../chat-manager";
import { activeBranchLines, forkPrefix, isFanoutSource, parseSourceDoc } from "../../../../session-fork";
import { activeBranch, parseLines } from "../../../../transcript";
import type { Fixture, Probe } from "../golden";

/** The ids each per-id probe asks about: the branch's, then one abandoned entry's, then one that isn't there. */
function askedIds(f: Fixture): string[] {
  const entries = parseLines(f.text);
  const branch = activeBranch(entries).map((e) => e.id).filter((id): id is string => typeof id === "string");
  const on = new Set(branch);
  const abandoned = entries.find((e) => typeof e.id === "string" && e.type !== "session" && !on.has(e.id))?.id as string | undefined;
  return [...branch, ...(abandoned ? [abandoned] : []), "no-such-entry"];
}

export const probes: Probe[] = [
  {
    name: "fork",
    formats: ["pi"],
    run(f) {
      const parsed = parseSourceDoc(f.text);
      if (!parsed.ok) return { parse: parsed };
      const walked = activeBranchLines(parsed.doc);
      const prefixes: Record<string, unknown> = {};
      for (const id of askedIds(f)) {
        const plan = forkPrefix(parsed.doc, id);
        prefixes[id] = plan.ok ? { ok: true, prefix: plan.prefix.map((l) => l.raw) } : plan;
      }
      return {
        parse: { ok: true, lines: parsed.doc.lines.length },
        branch: walked.ok ? walked.branch.map((l) => l.entry.id) : walked,
        fanout: isFanoutSource(parsed.doc),
        prefixes,
      };
    },
  },
  {
    name: "regenerate",
    formats: ["pi"],
    run(f) {
      const branch = activeBranch(parseLines(f.text));
      const out: Record<string, unknown> = {};
      for (const id of askedIds(f)) {
        out[id] = resolveRegenerate(branch as never, id);
        out[`${id}:0`] = resolveRegenerate(branch as never, `${id}:0`);
      }
      return out;
    },
  },
  {
    name: "rewind",
    formats: ["pi"],
    async run(f) {
      const branch = activeBranch(parseLines(f.text));
      const out: Record<string, unknown> = {};
      for (const id of askedIds(f)) {
        // A stand-in session: pi's navigateTree hands back the target's text (its text blocks joined), the
        // marker write is recorded. What is pinned is Sova's target check and its editor-text cleanup.
        const marks: unknown[] = [];
        const target = branch.find((e) => e.id === id);
        const content = target?.message?.content;
        const editorText = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
        const session = {
          isStreaming: false,
          isCompacting: false,
          sessionManager: {
            getBranch: () => branch,
            getLeafId: () => (branch.length ? branch[branch.length - 1]!.id : null),
            appendCustomEntry: (type: string, data: unknown) => void marks.push({ type, data }),
          },
          navigateTree: async () => ({ editorText, cancelled: false }),
        };
        const outcome = await rewindSession(session as never, id, { guard() {}, beforeMarker() {}, queued: () => false });
        out[id] = { outcome, marks };
      }
      return out;
    },
  },
  {
    name: "chat-title",
    formats: ["pi"],
    run(f) {
      const branch = activeBranch(parseLines(f.text));
      return titleOf({ getBranch: () => branch as never });
    },
  },
];
