import { Show } from "solid-js";
import type { OwnerRequestCard } from "../../shared/project-assistant";
import { relativeTime, stampTime } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { orgRequestHref } from "../lib/orgs-route";
import { firstName, KIND_WORD } from "../lib/owner-requests";
import "./OrgRequests.css";

/**
 * An owner request at the top of the chat Start Chat opened (§app.project-assistant/request-chat):
 * a note the model reads with the operator's first message, drawn as "Request from {first name}"
 * with its kind, project, filed time, text, and Open in Requests back to its row.
 */
export function OwnerRequestNote(props: { card: OwnerRequestCard }) {
  const now = useMinuteNow();
  const c = () => props.card;
  const who = () => firstName(c().ownerName) || "the owner";
  return (
    <section class="card owner-request-note" aria-label={`Request from ${who()}: ${c().title}`}>
      <div class="owner-request-note-head">
        <span class="owner-request-note-from">Request from {who()}</span>
        <a class="button button-sm" href={orgRequestHref(c().orgId, c().requestId)}>
          Open in Requests
        </a>
      </div>
      <p class="owner-request-note-meta text-caption text-muted">
        {KIND_WORD[c().kind] ?? "Request"} · {c().project} · filed{" "}
        <span title={stampTime(c().filedAt)}>{relativeTime(c().filedAt, now())}</span>
      </p>
      <p class="owner-request-note-title">{c().title}</p>
      <Show when={c().text}>
        <p class="org-request-text">{c().text}</p>
      </Show>
    </section>
  );
}
