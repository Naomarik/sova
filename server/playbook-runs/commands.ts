// The / rows of playbooks with a description: one per listed playbook the chat's
// folder sees; picking one, or typing its name, opens its card in the page. Unlisted ones never show.
import type { SlashCommand } from "../../shared/protocol";
import { listPlaybooks } from "../playbooks";

/** Order of preference when two sources share an id: the project's, then yours, then Sova's. */
const RANK = { project: 0, user: 1, sova: 2 } as const;

export async function playbookCommandRows(cwd: string | undefined): Promise<SlashCommand[]> {
  const { playbooks } = await listPlaybooks(cwd || undefined);
  const best = new Map<string, SlashCommand & { rank: number }>();
  for (const p of playbooks) {
    if (!p.spec) continue;
    const rank = RANK[p.source];
    const have = best.get(p.id);
    if (have && have.rank <= rank) continue;
    best.set(p.id, { name: p.id, description: p.description || p.title, source: "builtin", playbook: { source: p.source, id: p.id }, rank });
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ rank: _rank, ...row }) => row);
}
