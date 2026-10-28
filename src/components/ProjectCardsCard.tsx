import { createSignal, For, Show } from "solid-js";
import { CARDS_DIR } from "../../shared/transcript-cards";
import { getProjectCards, setCardTrust } from "../lib/api";
import { createPoll } from "../lib/poll";
import { toast } from "../lib/ui-state";

const CARDS_POLL_MS = 30_000;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The project page's Cards list: the card types its main checkout's `.sova/cards/` folders declare,
 * read now, each broken folder with its path and what is wrong, and whether the project's cards are
 * trusted to act for you, with Stop Trusting Cards while they are. Trusting happens on a card, the
 * first time one wants to act.
 */
export function ProjectCardsCard(props: { projectId: string }) {
  const poll = createPoll(() => getProjectCards(props.projectId), CARDS_POLL_MS, { cacheKey: `project:${props.projectId}:cards` });
  const [busy, setBusy] = createSignal(false);
  const types = () => poll.data()?.folders.flatMap((f) => (f.ok ? [f] : [])) ?? [];
  const broken = () => poll.data()?.folders.flatMap((f) => (f.ok ? [] : [f])) ?? [];
  const stopTrusting = async (owner: string) => {
    setBusy(true);
    try {
      await setCardTrust(owner, false);
    } catch (err) {
      toast(`Cards still trusted: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      poll.refetch();
    }
  };
  return (
    <section class="card orgs-section project-cards" aria-labelledby="project-cards">
      <h2 class="orgs-h2" id="project-cards">
        Cards
      </h2>
      <Show when={poll.error() && !poll.data()}>
        <p class="field-error">Couldn't read the card folders. {poll.error()}</p>
      </Show>
      <Show when={poll.data()}>
        {(a) => (
          <>
            <Show when={!a().folders.length}>
              <p class="orgs-line">
                No card types yet. Add a folder under <code>{CARDS_DIR}/</code> on the main checkout, and this project's chats can raise its cards.
              </p>
            </Show>
            <Show when={types().length}>
              <p class="orgs-line">
                {plural(types().length, "card type")}:{" "}
                <For each={types()}>
                  {(t, i) => (
                    <>
                      {i() ? ", " : ""}
                      <code title={t.title}>{t.type}</code>
                    </>
                  )}
                </For>
                .
              </p>
            </Show>
            <Show when={broken().length}>
              <ul class="project-cards-broken" aria-label="Broken card folders">
                <For each={broken()}>
                  {(f) => (
                    <li class="project-card-folder" data-card-folder={f.name}>
                      <div class="project-offer-head">
                        <code>{f.path}</code>
                        <span class="chip chip-warn">
                          <span class="chip-dot" aria-hidden="true" />
                          Broken
                        </span>
                      </div>
                      <p class="field-error">{f.error} It raises nothing until it's fixed.</p>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <div class="orgs-head project-cards-trust">
              <p class="orgs-line">
                {a().trust.trusted ? `${a().trust.name}'s cards are trusted to act for you.` : `${a().trust.name}'s cards aren't trusted to act for you: the first one that wants to asks you.`}
              </p>
              <Show when={a().trust.trusted}>
                <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} onClick={() => !busy() && void stopTrusting(a().trust.owner)}>
                  Stop Trusting Cards
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
