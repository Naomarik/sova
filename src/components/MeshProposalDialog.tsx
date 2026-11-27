import { createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { answerCounts, createAnswerHold } from "../lib/answer-hold";
import { answerMeshProposal, dropMeshProposal, FULL_ACCESS_SENTENCE, proposalText, waitingMeshProposals } from "../lib/mesh-proposals";
import { Banner, trapFocus } from "./ui";

/**
 * Sova's own dialog for an extension's mesh proposal (§mesh.lan/proposals): over whatever is open, the extension's
 * page included, one proposal at a time, oldest first. Its buttons act only on a click the browser marks as the
 * person's (`isTrusted`), never a script's `click()`; the server refuses an extension page's own call besides. That
 * guards against an accident or a careless page, not a hostile one (§app.access/click-limits). Each time the request
 * shown changes (it appears, or the next one takes the place of one answered, run out or withdrawn), the keyboard
 * moves to the dialog itself and both buttons do nothing for a moment (`createAnswerHold`): a second click, or a key
 * press meant for the composer behind, never answers a request not yet read.
 */
export function MeshProposalDialog() {
  const first = () => waitingMeshProposals()[0];
  const count = () => waitingMeshProposals().length;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ id: string; message: string } | null>(null);
  /** A confirm that couldn't be applied is decided, so it leaves the waiting list: why stays here until closed. */
  const [failed, setFailed] = createSignal<{ title: string; message: string } | null>(null);
  let dialog: HTMLDivElement | undefined;
  // Tied to the request's id, not to the dialog mounting: the dialog stays while one request follows another.
  const held = createAnswerHold(() => first()?.id, { onNew: () => queueMicrotask(() => dialog?.focus({ preventScroll: true })) });
  const inert = () => busy() || held();

  const answer = async (e: MouseEvent, id: string, how: "confirm" | "decline") => {
    // A script's element.click() or dispatchEvent is untrusted: only the person's own click answers.
    if (!answerCounts(e, { busy: busy(), held: held() })) return;
    setBusy(true);
    setError(null);
    try {
      await answerMeshProposal(id, how);
      dropMeshProposal(id);
    } catch (err) {
      const message = (err as Error).message;
      setError({ id, message });
      const p = waitingMeshProposals().find((x) => x.id === id);
      if (p && how === "confirm") setFailed({ title: `${p.extension.title}'s proposal wasn't applied`, message });
      dropMeshProposal(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Show when={!first() && failed()}>
      {(f) => (
        <Portal>
          <div class="scrim mesh-proposal-scrim" onClick={() => setFailed(null)} />
          <div class="modal mesh-proposal" role="alertdialog" aria-modal="true" aria-labelledby="mesh-proposal-failed" ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && setFailed(null)}>
            <div class="modal-head">
              <h2 class="modal-title" id="mesh-proposal-failed">
                {f().title}
              </h2>
            </div>
            <div class="modal-body mesh-proposal-body">
              <Banner tone="error" title={f().message} />
            </div>
            <div class="modal-foot">
              <button type="button" class="button" onClick={() => setFailed(null)}>
                Close
              </button>
            </div>
          </div>
        </Portal>
      )}
    </Show>
    <Show when={first()}>
      {(p) => {
        const text = () => proposalText(p());
        return (
          <Portal>
            <div class="scrim mesh-proposal-scrim" />
            <div class="modal mesh-proposal" role="alertdialog" aria-modal="true" aria-labelledby="mesh-proposal-title" aria-describedby="mesh-proposal-what" data-proposal={p().id} tabindex="-1" ref={(el) => {
              dialog = el;
              trapFocus(el, { focus: "root" });
            }}>
              <div class="sheet-grip" aria-hidden="true" />
              <div class="modal-head">
                <h2 class="modal-title" id="mesh-proposal-title">
                  {text().title}
                </h2>
                <Show when={count() > 1}>
                  <span class="mesh-proposal-count">1 of {count()} waiting</span>
                </Show>
              </div>
              <div class="modal-body mesh-proposal-body">
                <p id="mesh-proposal-what" class="mesh-proposal-from">
                  The extension {p().extension.title} ({p().extension.id}) proposes this. Nothing changes until you answer.
                </p>
                <Show when={p().why}>
                  {(why) => (
                    <blockquote class="mesh-proposal-why" aria-label={`${p().extension.title}'s words`}>
                      “{why()}”
                    </blockquote>
                  )}
                </Show>
                <dl class="mesh-proposal-rows">
                  <For each={text().rows}>
                    {(row) => (
                      <>
                        <dt>{row.label}</dt>
                        <dd classList={{ "text-mono": !!row.mono }}>{row.value}</dd>
                      </>
                    )}
                  </For>
                  <Show when={text().grant}>
                    {(g) => (
                      <>
                        <dt>{p().kind === "pair" ? "It may do here" : "It would get"}</dt>
                        <dd>
                          <strong>{g().label}</strong>: {g().hint}
                        </dd>
                      </>
                    )}
                  </Show>
                </dl>
                <Show when={p().kind === "pair" && p().fingerprint}>
                  <p class="mesh-proposal-note">Check the fingerprint by eye against the one the other computer shows.</p>
                </Show>
                <Show when={text().full}>
                  <Banner tone="warn" title={FULL_ACCESS_SENTENCE} />
                </Show>
                <Show when={error()?.id === p().id ? error() : null}>{(e) => <Banner tone="error" title={e().message} />}</Show>
              </div>
              <div class="modal-foot">
                <button type="button" class="button button-ghost" aria-disabled={inert() ? "true" : undefined} onClick={(e) => void answer(e, p().id, "decline")}>
                  Decline
                </button>
                <button type="button" class="button button-primary" aria-disabled={inert() ? "true" : undefined} onClick={(e) => void answer(e, p().id, "confirm")}>
                  {busy() ? "Applying…" : text().action}
                </button>
              </div>
            </div>
          </Portal>
        );
      }}
    </Show>
    </>
  );
}
