import { createSignal, For, Show } from "solid-js";
import { OFFERS_FILE, type ProjectOfferRow } from "../../shared/session-offers";
import { approveProjectOfferRuns, getProjectOffers } from "../lib/api";
import { createPoll } from "../lib/poll";
import { toast } from "../lib/ui-state";

const OFFERS_POLL_MS = 30_000;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The project page's Offers list (§chat.offers/project-list): each offer the project's offers file
 * declares, read now, with its buttons, who shows it and how often it was shown and used; run buttons'
 * approval, and Approve Run Buttons while they aren't. Changes go through the file.
 */
export function ProjectOffersCard(props: { projectId: string }) {
  const poll = createPoll(() => getProjectOffers(props.projectId), OFFERS_POLL_MS, { cacheKey: `project:${props.projectId}:offers` });
  const [busy, setBusy] = createSignal(false);
  const approve = async (fingerprint: string) => {
    setBusy(true);
    try {
      poll.set(await approveProjectOfferRuns(props.projectId, fingerprint));
    } catch (err) {
      toast(`Run buttons not approved: ${err instanceof Error ? err.message : String(err)}`);
      poll.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card orgs-section project-offers" aria-labelledby="project-offers">
      <h2 class="orgs-h2" id="project-offers">
        Offers
      </h2>
      <Show when={poll.error() && !poll.data()}>
        <p class="field-error">Couldn't read the offers. {poll.error()}</p>
      </Show>
      <Show when={poll.data()}>
        {(a) => (
          <>
            <Show when={a().file === "missing"}>
              <p class="orgs-line">
                No offers yet. Declare some in <code>{OFFERS_FILE}</code> on the main checkout, and this project's chats can show them as button cards.
              </p>
            </Show>
            <Show when={a().file === "broken"}>
              <p class="field-error">
                <code>{OFFERS_FILE}</code> is broken, so no offer shows: {a().error}
              </p>
            </Show>
            <Show when={a().runs}>
              {(r) => (
                <div class="project-offers-runs">
                  <p class="orgs-line">
                    {r().approved ? "Run buttons approved: " : "Run buttons need your approval before their offers show: "}
                    {r()
                      .buttons.map((b) => `${b.offer} · ${b.label} runs ${b.run}`)
                      .join("; ")}
                    .
                  </p>
                  <Show when={!r().approved}>
                    <button type="button" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => !busy() && void approve(r().fingerprint)}>
                      Approve Run Buttons
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={a().offers.length}>
              <ul class="project-offers-list">
                <For each={a().offers}>{(o) => <OfferRow offer={o} />}</For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

function OfferRow(props: { offer: ProjectOfferRow }) {
  const o = () => props.offer;
  return (
    <li class="project-offer" data-offer={o().name}>
      <div class="project-offer-head">
        <span class="text-mono">{o().name}</span>
        <Show when={o().title}>{(t) => <strong>{t()}</strong>}</Show>
        <Show when={o().state === "broken"}>
          <span class="chip chip-warn">Broken</span>
        </Show>
        <Show when={o().state === "disabled"}>
          <span class="chip">Disabled</span>
        </Show>
        <Show when={o().rarelyUsed}>
          <span class="chip" title="Shown at least 5 times and used under a fifth of those.">
            Rarely used
          </span>
        </Show>
      </div>
      <Show when={o().state === "broken"}>
        <p class="field-error">{o().error}</p>
      </Show>
      <Show when={o().when}>
        <p class="orgs-line">
          When: {o().when}
          <Show when={o().why}> Why: {o().why}</Show>
        </p>
      </Show>
      <Show when={o().buttons?.length}>
        <ul class="project-offer-buttons">
          <For each={o().buttons}>
            {(b) => (
              <li>
                <strong>{b.label}</strong> · {b.about} <span class="list-meta">({b.kind === "run" ? `runs ${b.run}` : b.to === "shower" ? "sends to the chat that showed it" : "sends a message"})</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="list-meta">
        {o().shownBy === "another-chat" ? "Shown by another chat" : o().shownBy ? "Shown by the agent" : ""}
        {o().shownBy ? " · " : ""}
        Shown {plural(o().shown, "time")}, used {plural(o().used, "time")}
      </p>
    </li>
  );
}
