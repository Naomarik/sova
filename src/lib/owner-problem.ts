// Why a read on the Owner page failed (§app.owner-page/page): the page's own reads and the Project
// Assistant's read the same answer statuses the same way. Pure (no DOM, no Solid), so node tests run it.

/** Why a load failed. `unknown`/`gone`/`expired`/`busy` are about the link (the whole page);
    `missing` is one project or conversation that isn't on the page; `offline` is a public gateway's
    503 (the host it lives on is offline: the page stays and keeps trying); `unavailable` is a 404
    with no `code` on a read the page's newer routes serve (an older gateway refusing the address);
    `failed` is anything else. */
export type OwnerProblemKind = "unknown" | "gone" | "expired" | "busy" | "missing" | "offline" | "unavailable" | "failed";

export class OwnerLoadError extends Error {
  constructor(
    readonly kind: OwnerProblemKind,
    /** On a link that turned off unused: the owner already asked for a new one. */
    readonly asked = false,
  ) {
    super(kind);
  }
}

/** The kinds that are about the link itself: the page's dead-link screen, nothing of the page stays. */
export const DEAD_LINK_KINDS: readonly OwnerProblemKind[] = ["unknown", "gone", "expired", "busy"];
export const isDeadLink = (k: OwnerProblemKind | null | undefined): k is "unknown" | "gone" | "expired" | "busy" => !!k && DEAD_LINK_KINDS.includes(k);

/**
 * The problem a failed answer means; null when the status is a success. `read`: `home` (the page's
 * home read: a 404 is the link), `sub` (a project or conversation: a 404 `missing` is that item), or
 * `assistant` (the chat: a 404 with no `code` is a gateway that doesn't pass its address yet).
 */
export function ownerProblemOf(status: number, body: unknown, read: "home" | "sub" | "assistant"): OwnerLoadError | null {
  if (status >= 200 && status < 300) return null;
  const b = (body && typeof body === "object" ? body : {}) as { why?: unknown; asked?: unknown; code?: unknown };
  if (status === 410) return new OwnerLoadError(b.why === "expired" ? "expired" : "gone", b.asked === true);
  if (status === 404) {
    if (read === "sub" && b.code === "missing") return new OwnerLoadError("missing");
    if (read === "assistant" && b.code === undefined) return new OwnerLoadError("unavailable");
    return new OwnerLoadError("unknown");
  }
  if (status === 429) return new OwnerLoadError("busy");
  if (status === 503) return new OwnerLoadError("offline");
  return new OwnerLoadError("failed");
}

/** What the Project Assistant says in place of its chat when its first read failed (§design.copy-deck/owner-page). */
export function assistantProblemText(kind: "unavailable" | "failed", op: string): { title: string; body: string; tryAgain: boolean } {
  if (kind === "unavailable")
    return { title: "The Project Assistant can't open on this link yet.", body: `${op} has to update the server your link goes through. Your projects still open.`, tryAgain: false };
  return { title: "We couldn't load the Project Assistant.", body: "Try again in a minute.", tryAgain: true };
}
