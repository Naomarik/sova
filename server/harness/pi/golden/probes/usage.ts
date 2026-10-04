// Probes owned by batch C (usage, context, workers): context fill, a session's facts for insights, the last
// turn's facts for attention, skills, worker fill and skills, and the unread count (full and incremental).
// Spend is the usage ledger's since feat/usage-ledger: no transcript reader prices anything, so no spend
// probe reads a session file. A batch edits only its own probes file, and only to follow a moved function.
import { appendFileSync, statSync } from "node:fs";
import { readTailBranch, turnFacts } from "../../../../attention-signals";
import { extractFacts } from "../../../../insights";
import { collectSkills } from "../../../../skills";
import { activeBranch, parseLines } from "../../../../transcript";
import { UnreadReplies } from "../../../../unread-replies";
import { contextTally, readTailFill } from "../../../../worker-context";
import { forgetWorkerSkills, workerSkills } from "../../../../worker-skills";
import type { WorkerInfo } from "../../../../../shared/protocol";
import type { Probe } from "../golden";

const window = (ref: string) => (ref ? 200_000 : null);

/** `since` values for the unread count: before everything, the middle entry's time, after the last. */
function sinces(text: string): Record<string, number> {
  const times = parseLines(text)
    .map((e) => (typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return { zero: 0, mid: times[Math.floor(times.length / 2)] ?? 0, after: (times[times.length - 1] ?? 0) + 1 };
}

export const probes: Probe[] = [
  {
    name: "insights-facts",
    formats: ["pi"],
    run: (f) => extractFacts(f.text),
  },
  {
    name: "attention-turn",
    formats: ["pi"],
    async run(f) {
      return { full: turnFacts(await readTailBranch(f.file())), window4k: turnFacts(await readTailBranch(f.file(), 4096)) };
    },
  },
  {
    name: "skills",
    formats: ["pi", "cc"],
    run: (f) => collectSkills(activeBranch(parseLines(f.text))),
  },
  {
    name: "worker-skills",
    formats: ["pi", "cc"],
    async run(f) {
      const path = f.file();
      forgetWorkerSkills(path);
      const worker = { id: "ag_01", name: "golden", status: "running", working: true, sessionFile: path } as WorkerInfo;
      return (await workerSkills([worker], () => path)) ?? null;
    },
  },
  {
    name: "worker-fill",
    formats: ["pi", "cc"],
    run(f) {
      const path = f.file();
      const format = f.format === "pi" ? "pi" : "claude";
      return { tail: readTailFill(path, statSync(path).size, format), tally: contextTally(format, window)(f.text, "snapshot") };
    },
  },
  {
    name: "unread",
    formats: ["pi"],
    async run(f) {
      const out: Record<string, unknown> = {};
      for (const [name, since] of Object.entries(sinces(f.text))) out[name] = await new UnreadReplies().count(f.file(), since);
      // The incremental path: count a prefix, append the rest, count again; a fresh count must agree.
      const lines = f.text.split(/(?<=\n)/);
      const half = Math.ceil(lines.length / 2);
      const path = f.copy("unread", lines.slice(0, half).join(""));
      const u = new UnreadReplies();
      const before = await u.count(path, 0);
      appendFileSync(path, lines.slice(half).join(""));
      const after = await u.count(path, 0);
      out.incremental = { before, after, fullCounts: u.full, fresh: await new UnreadReplies().count(path, 0) };
      return out;
    },
  },
];
