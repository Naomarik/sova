import type { AttentionItem } from "../../shared/protocol";
import { deployAttention, type DeployAttention } from "./deploy";

/**
 * Deploys in the Overseer's attention digest (§app.project-services/deploy-status): a target whose latest
 * deploy failed (its steps, its verify, or its runner) and an overseer's request to deploy are act-tier
 * items of no session, linked to the project's page, where its Deploy panel says what happened.
 */

const DETAIL_MAX = 200;

/** The digest's items from `facts` (pure); `projectOf` names the registered project holding a root. */
export function deployItems(facts: readonly DeployAttention[], projectOf: (root: string) => { id: string; name: string } | null): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const f of facts) {
    const p = projectOf(f.root);
    if (!p) continue;
    const detail = f.detail.length > DETAIL_MAX ? `${f.detail.slice(0, DETAIL_MAX - 1)}…` : f.detail;
    out.push({ id: `${f.kind}:${p.id}:${f.target}`, path: "", title: p.name, where: f.root, tier: "act", kind: f.kind, since: f.since, detail, href: `#/projects/${encodeURIComponent(p.id)}` });
  }
  return out;
}

/** Every deploy item on this host. */
export async function deployAttentionItems(): Promise<AttentionItem[]> {
  const { listProjects } = await import("../projects/spaces");
  const projects = listProjects();
  return deployItems(deployAttention(), (root) => {
    const p = projects.find((x) => x.root === root);
    return p ? { id: p.id, name: p.name || p.id } : null;
  });
}
