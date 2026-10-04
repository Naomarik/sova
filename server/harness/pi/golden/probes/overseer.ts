// Probes owned by batch F (overseer and routes): the Overseer's run-note folds over a branch, the last reply
// it reads from rows, the open alignments, and the align and merge-readiness scans read whole and read
// incrementally (a prefix, then the rest appended). A batch edits only its own probes file, and only to
// follow a moved function (README.md).
import { appendFileSync, statSync } from "node:fs";
import { openAlignmentsOf, readAlignScan } from "../../../../align-state";
import { readReadinessScan } from "../../../../merge-readiness";
import { briefedBlockers, listedCleared, promptedOnBranch } from "../../../../overseer-run-note";
import { lastReplyIn } from "../../../../overseer-tools";
import { activeBranch, normalizeEntries, parseLines } from "../../../../transcript";
import type { Fixture, Probe } from "../golden";

/** A scan read whole, and read on a prefix then again after the rest is appended (it must agree). */
async function scans<T>(f: Fixture, name: string, read: (path: string, size: number, prev: T | null) => Promise<T>): Promise<{ full: T; prefix: T; grown: T }> {
  const path = f.file();
  const full = await read(path, statSync(path).size, null);
  const lines = f.text.split(/(?<=\n)/);
  const half = Math.ceil(lines.length / 2);
  const copy = f.copy(name, lines.slice(0, half).join(""));
  const prefix = await read(copy, statSync(copy).size, null);
  appendFileSync(copy, lines.slice(half).join(""));
  const grown = await read(copy, statSync(copy).size, prefix);
  return { full, prefix, grown };
}

export const probes: Probe[] = [
  {
    name: "overseer-folds",
    formats: ["pi"],
    run(f) {
      const branch = activeBranch(parseLines(f.text));
      return {
        prompted: promptedOnBranch(branch),
        briefed: briefedBlockers(branch),
        cleared: listedCleared(branch),
        lastReply: lastReplyIn(normalizeEntries(branch)) ?? null,
        openAlignments: openAlignmentsOf(branch),
      };
    },
  },
  {
    name: "align-scan",
    formats: ["pi"],
    run: (f) => scans(f, "align", readAlignScan),
  },
  {
    name: "readiness-scan",
    formats: ["pi"],
    async run(f) {
      const s = await scans(f, "readiness", async (path, size, prev: { scan: any } | null) => readReadinessScan(path, size, prev?.scan ?? null));
      return s;
    },
  },
];
