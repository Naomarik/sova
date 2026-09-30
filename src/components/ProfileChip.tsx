import { createResource, createSignal, For, Show } from "solid-js";
import { CAPABILITY_LABEL, profileSentence, titleCase, type Profile } from "../../shared/profiles";
import type { ChatProfileInfo, SessionSummary } from "../../shared/protocol";
import { fetchProfiles, setSessionArchived } from "../lib/api";
import { openProfileStart } from "../lib/profile-start";
import { defaultTools, profileIconName } from "../lib/profiles";
import { openSettings } from "../lib/settings-nav";
import { toast } from "../lib/ui-state";
import { Icon } from "./ui";

/**
 * The session head's profile chip (§chat.profiles/after-first-message): read-only once the first
 * message is sent. Default shows none.
 */
export function ProfileChip(props: { summary: SessionSummary; info: ChatProfileInfo | null }) {
  const [open, setOpen] = createSignal(false);
  const [listing] = createResource(open, () => fetchProfiles().catch(() => undefined));
  const field = () => props.summary.profile;
  const snap = () => props.info?.profile ?? null;
  const shown = () => !!field() && (props.info ? props.info.locked && !!snap() : true);
  const counts = () => {
    const i = props.info;
    if (!i) return undefined;
    const total = defaultTools(i).length;
    return { kept: total - i.removed.length, total };
  };
  /** The saved profile it came from, when it still exists (Run Again, Edit). */
  const source = (): (Profile & { builtin: boolean }) | undefined => {
    const l = listing();
    const id = field()?.id;
    if (!l || !id) return undefined;
    const b = l.builtins.find((p) => p.id === id);
    if (b) return { ...b, builtin: true };
    const y = l.profiles.find((p) => p.id === id);
    return y ? { ...y, builtin: false } : undefined;
  };
  const stop = async () => {
    setOpen(false);
    try {
      await setSessionArchived(props.summary.path, true);
      toast(`Stopped ${field()!.label}. Find it under Archive.`);
    } catch (err) {
      toast(`Couldn't stop it. ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <Show when={shown() && field()}>
      {(f) => (
        <span
          class="profile-chip-wrap"
          onFocusOut={(e) => {
            const to = e.relatedTarget as Node | null;
            if (!to || !e.currentTarget.contains(to)) setOpen(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <button type="button" class="button button-ghost profile-chip" aria-expanded={open()} aria-haspopup="dialog" title={`Profile: ${f().label}`} onClick={() => setOpen(!open())}>
            <Icon name={profileIconName(f().icon)} small />
            <span class="profile-chip-label">{f().label}</span>
          </button>
          <Show when={open()}>
            <div class="profile-popover" role="dialog" aria-label={`${f().label} profile`}>
              <p class="profile-popover-sentence">{snap() ? profileSentence(snap()!, counts()?.kept, counts()?.total) : `A ${f().label} session.`}</p>
              <Show when={snap()}>
                {(p) => (
                  <ul class="profile-change-list">
                    <For each={p().grant}>
                      {(g) => (
                        <li class="profile-change profile-change-add">
                          <span class="profile-change-sign" aria-hidden="true">+</span>
                          <span class="profile-change-name">{CAPABILITY_LABEL[g]}</span>
                        </li>
                      )}
                    </For>
                    <For each={p().remove}>
                      {(r) => (
                        <li class="profile-change">
                          <span class="profile-change-sign" aria-hidden="true">−</span>
                          <span class="profile-change-name">{CAPABILITY_LABEL[r]}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                )}
              </Show>
              <p class="profile-muted">Fixed when the first message was sent.</p>
              <div class="profile-popover-actions">
                <Show when={source()}>
                  {(p) => (
                    <button type="button" class="button button-sm button-primary" onClick={() => (setOpen(false), openProfileStart(p(), props.summary.cwd))}>
                      Run Again
                    </button>
                  )}
                </Show>
                <Show when={source()}>
                  {(p) => (
                    <button type="button" class="button button-sm" onClick={() => (setOpen(false), openSettings("profiles"))}>
                      {p().builtin ? "Duplicate Profile" : "Edit Profile"}
                    </button>
                  )}
                </Show>
                <Show when={f().singleton && !props.summary.archived}>
                  <button type="button" class="button button-sm button-ghost" onClick={() => void stop()}>
                    Stop {titleCase(f().label)}
                  </button>
                </Show>
              </div>
              <p class="profile-muted">Changes reach new sessions only.</p>
            </div>
          </Show>
        </span>
      )}
    </Show>
  );
}
