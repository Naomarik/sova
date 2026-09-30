import { createResource, createSignal, Show } from "solid-js";
import type { ProfileSource } from "../../shared/profiles";
import type { PlaybookInfo } from "../../shared/protocol";
import { linkedPlaybook, missingPlaybookText } from "../../shared/playbooks";
import { fetchPlaybooks } from "../lib/api";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { Markdown } from "./Markdown";
import { Banner, Icon, trapFocus } from "./ui";

/**
 * The empty screen's playbook card (§chat.profiles/playbook): the playbook the picked profile links,
 * View Playbook, and Run Playbook, which sends its turn with the message box's text as the
 * playbook's text. Nothing is sent before Run Playbook is pressed.
 */
export function ProfilePlaybookCard(props: {
  cwd: string | null;
  playbook: string;
  source?: ProfileSource;
  /** Why sending isn't possible now (the composer's own reason), or null. */
  blocked?: string | null;
  /** Send the playbook's turn; false = refused (nothing was sent). */
  onRun(playbook: PlaybookInfo): boolean;
}) {
  const [catalog] = createResource(
    () => props.cwd ?? "",
    (cwd) => fetchPlaybooks(cwd || null).catch(() => undefined),
  );
  const found = () => linkedPlaybook(catalog()?.playbooks ?? [], props.playbook, props.source);
  const [viewing, setViewing] = createSignal(false);
  return (
    <Show when={catalog.state !== "pending" && !catalog.loading}>
      <Show
        when={found()}
        fallback={<Banner tone="warn" title={missingPlaybookText(props.playbook)} />}
      >
        {(pb) => (
          <div class="profile-playbook" role="group" aria-label={`Playbook: ${pb().title}`}>
            <div class="profile-playbook-head">
              <Icon name="bulb" small />
              <span class="text-eyebrow">Playbook</span>
            </div>
            <p class="profile-playbook-title">{pb().title}</p>
            <Show when={pb().description}>
              <p class="profile-muted">{pb().description}</p>
            </Show>
            <p class="profile-muted">Anything you type in the message box goes with it.</p>
            <div class="profile-playbook-actions">
              <button type="button" class="button button-sm" onClick={() => setViewing(true)}>
                View Playbook
              </button>
              <button
                type="button"
                class="button button-sm button-primary"
                aria-disabled={props.blocked ? "true" : undefined}
                title={props.blocked ?? undefined}
                onClick={() => {
                  if (props.blocked) return;
                  props.onRun(pb());
                }}
              >
                Run Playbook
              </button>
            </div>
            <Show when={props.blocked}>{(b) => <p class="profile-muted">{b()}</p>}</Show>
            <Show when={viewing()}>
              <div class="scrim" onClick={() => setViewing(false)} />
              <div
                class="modal profile-playbook-view"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ppv-title"
                ref={(el) => trapFocus(el)}
                onKeyDown={(e) => e.key === "Escape" && setViewing(false)}
              >
                <div class="modal-head">
                  <h2 class="modal-title" id="ppv-title">
                    {pb().title}
                  </h2>
                  <p class="profile-muted text-mono">{tildePath(pb().dir, home())}/PLAYBOOK.md</p>
                </div>
                <div class="modal-body profile-playbook-body">
                  <Markdown text={pb().body} />
                </div>
                <div class="modal-foot">
                  <button type="button" class="button button-ghost" onClick={() => setViewing(false)}>
                    Close
                  </button>
                </div>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
}
