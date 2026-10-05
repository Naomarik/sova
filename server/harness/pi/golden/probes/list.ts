// Probes owned by batch D (list and head scanners): the session summary's stable fields, the head and tail
// scanners behind it, the title input, the tagger's last turn, the scheduler's last turn and the project
// costs title. A batch edits only its own probes file, and only to follow a moved function (README.md).
import { statSync } from "node:fs";
import { titleOf as projectCostTitle } from "../../../../project-costs";
import { lastTurn } from "../../../../schedule-routes";
import { readTitleInput } from "../../../../session-autotitle";
import { readTailTurn } from "../../../../session-tags";
import { getSessionSummary, readHead, readTailContext, readTailModel, readTailReply } from "../../../../sessions-index";
import type { Probe } from "../golden";

/** What the summary says from the file alone. Its mtime fields, its path and every overlay from this
    server's own stores (live records, seen marks, groups, readiness) are left out. */
const SUMMARY_FIELDS = ["id", "cwd", "title", "createdAt", "model", "context", "outlineNow", "outlineGist", "outlineAt", "outlineTopics", "parent", "parentId", "target", "remoteCwd", "align", "profile"] as const;

export const probes: Probe[] = [
  {
    name: "summary",
    formats: ["pi"],
    async run(f) {
      const s = await getSessionSummary(f.file());
      if (!s) return null;
      const out: Record<string, unknown> = {};
      for (const k of SUMMARY_FIELDS) if (k in s) out[k] = (s as unknown as Record<string, unknown>)[k];
      return out;
    },
  },
  {
    name: "head",
    formats: ["pi", "cc"],
    run: (f) => readHead(f.file()),
  },
  {
    name: "tail",
    formats: ["pi"],
    async run(f) {
      const path = f.file();
      const size = statSync(path).size;
      return { model: await readTailModel(path, size), context: await readTailContext(path, size), reply: await readTailReply(path, size) };
    },
  },
  {
    name: "title-input",
    formats: ["pi"],
    run: (f) => readTitleInput(f.file()),
  },
  {
    name: "tail-turn",
    formats: ["pi"],
    run: (f) => readTailTurn(f.file(), statSync(f.file()).size),
  },
  {
    name: "schedule-last-turn",
    formats: ["pi"],
    run: (f) => lastTurn(f.file()),
  },
  {
    name: "project-costs-title",
    formats: ["pi"],
    run: (f) => projectCostTitle(f.file(), "(fallback)"),
  },
];
