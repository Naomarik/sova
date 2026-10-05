import { Show } from "solid-js";
import { getPreviews } from "../lib/api";
import { meshPeers } from "../lib/mesh";
import { createPoll } from "../lib/poll";
import { readShares, SHARES_HREF, sharesCardLine, sharesCounts, sharesOverview } from "../lib/session-shares";
import { CountChip } from "./ui";
import "../extensions.css";

const SHARES_POLL_MS = 30_000;

/** One read of this host and every up peer, as counts; throws when nothing answered, so the poll keeps the last ones. */
async function readCounts() {
  const hosts: (string | null)[] = [null, ...meshPeers().filter((p) => p.state === "up").map((p) => p.id)];
  const counts = sharesCounts(await readShares(hosts, { overview: sharesOverview, previews: () => getPreviews().then((l) => l.previews) }));
  if (!counts) throw new Error("No host answered.");
  return counts;
}

/**
 * The overview's Shares card (§chat.transcript/landing-page), the Explanations card's shape: the
 * way to #/shares, with how many public links are live and who is viewing now. A host that doesn't
 * answer is left out of the counts; the Shares page names it.
 */
export function OverviewSharesCard() {
  const poll = createPoll(readCounts, SHARES_POLL_MS);
  return (
    <section class="explain-section" aria-labelledby="shares-section-title">
      <h2 class="explain-section-head" id="shares-section-title">
        Shares
      </h2>
      <ul class="ext-grid ext-grid-full">
        <li>
          <a class="card ext-card" href={SHARES_HREF}>
            <div class="ext-card-head">
              <span class="icon ext-card-icon" style={{ "--icon": "url(/icons/external.svg)" }} aria-hidden="true" />
              <h3 class="ext-card-title">Shares</h3>
              <Show when={poll.data()}>
                {(c) => (
                  <CountChip>
                    <span class="text-num">{c().total}</span>
                  </CountChip>
                )}
              </Show>
            </div>
            <p class="ext-card-body">
              <Show when={poll.data()} fallback="Reading shares…">
                {(c) => sharesCardLine(c())}
              </Show>
            </p>
          </a>
        </li>
      </ul>
    </section>
  );
}
