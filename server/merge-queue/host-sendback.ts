import type { HostFactsWire, HostKind } from "../../shared/merge-queue-hosts";

/**
 * What the host says is the branch's to fix on an open request (§app.merge-queue/send-back): it no longer merges
 * cleanly, the host's own checks failed, or a reviewer asked for changes. Each goes back to the branch's chat by
 * itself, as a request with the host's reason, under the user's standing Land. `key` names the problem at the request's
 * head, so the same problem at the same head goes back once. Null: nothing for the chat (pending, passed, approved,
 * merged, closed, or no word yet). Pure.
 */
export function hostProblem(
  f: HostFactsWire | undefined,
  r: { host?: HostKind; number?: number; url?: string },
  target: string,
): { kind: "conflicts" | "checks" | "changes"; why: string; key: string } | null {
  if (!f || (f.state !== "open" && f.state !== "draft")) return null;
  const H = r.host === "gitlab" ? "GitLab" : r.host === "github" ? "GitHub" : "the host";
  const ref = r.number !== undefined ? `${r.host === "gitlab" ? "!" : "#"}${r.number}` : "the request";
  const where = r.url ? ` (${r.url})` : "";
  const at = f.headSha ?? "";
  if (f.mergeable === "conflicts")
    return { kind: "conflicts", key: `conflicts:${at}`, why: `${H} says ${ref}${where} no longer merges cleanly into ${target}: merge ${target} into the branch and resolve the conflicts` };
  if (f.checks === "fail") return { kind: "checks", key: `checks:${at}`, why: `${H}'s own checks failed on ${ref}${where}: read them there and fix what is the branch's` };
  if (f.review === "changes-requested") return { kind: "changes", key: `changes:${at}`, why: `a reviewer on ${H} asked for changes on ${ref}${where}: read the review there and address it` };
  return null;
}
