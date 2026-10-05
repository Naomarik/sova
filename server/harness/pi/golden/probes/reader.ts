// Probes owned by batch R1 (the reader): what today's parse and branch rule give. A batch edits only its own
// probes file, and only to follow a moved function: call paths change, post-processing never (README.md).
import { activeBranch, parseLines } from "../../reader";
import type { Probe } from "../golden";

const idOf = (e: Record<string, unknown>) => (typeof e.id === "string" ? e.id : null);

export const probes: Probe[] = [
  {
    name: "reader",
    formats: ["pi", "cc"],
    run(f) {
      const entries = parseLines(f.text);
      const branch = activeBranch(entries);
      const header = entries.find((e) => e.type === "session") ?? null;
      return {
        header,
        lines: f.text.split("\n").length,
        entries: entries.length,
        ids: entries.map(idOf),
        branch: branch.map(idOf),
        leaf: branch.length ? idOf(branch[branch.length - 1]!) : null,
        types: branch.map((e) => (typeof e.type === "string" ? e.type : null)),
      };
    },
  },
];
