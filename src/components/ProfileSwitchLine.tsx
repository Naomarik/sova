import { createEffect, createSignal, on, Show } from "solid-js";
import type { ChatProfileState } from "../../shared/protocol";
import { cancelProfileSwitch } from "../lib/api";
import { useHostScope } from "../lib/host-scope";
import { switchedLine, switchRefused, switchWaitingLine } from "../lib/profile-switch";
import { announce } from "../lib/ui-state";
import { Banner } from "./ui";

/**
 * The thread's line just above the composer for a profile switch (§chat.profiles/switch): while a
 * switch waits for the reply to end, what it will move with Cancel Switch; once it applied, "This
 * chat and its helpers are on {name}."; a held switch refused at the turn's end, why. All of it is
 * the chat's own `chat_profile` state, never a guess from a reply.
 */
export function ProfileSwitchLine(props: { path: string; state: ChatProfileState | null }) {
  const host = useHostScope();
  const [cancelling, setCancelling] = createSignal(false);
  const [cancelError, setCancelError] = createSignal<string | null>(null);
  // Said once per switch that applies (or fails at the turn's end), not on every reconnect's resend.
  let said = "";
  createEffect(
    on(
      () => props.state?.applied ?? props.state?.failed ?? null,
      (s) => {
        if (!s) return;
        const key = "at" in s ? `ok:${s.id}:${s.at}` : `no:${s.id}:${s.reason}`;
        if (said === key) return;
        const first = said === "";
        said = key;
        if (first && "at" in s) return; // already there at connect: shown, not news
        announce("at" in s ? switchedLine(s.name) : `${switchRefused(s.name, s.reason).title} ${switchRefused(s.name, s.reason).body}`);
      },
    ),
  );
  const cancel = async () => {
    if (cancelling()) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelProfileSwitch(props.path, host());
      announce("Switch cancelled. Nothing changed.");
    } catch (err) {
      setCancelError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setCancelling(false);
    }
  };
  return (
    <div class="profile-switch-line">
      <Show when={props.state?.pending}>
        {(p) => (
          <Banner
            tone="info"
            title={switchWaitingLine(p().name, p().helpers, p().setsModel)}
            body={cancelError() ? `Couldn't cancel the switch. ${cancelError()}.` : undefined}
            action={
              <button type="button" class="button button-sm" aria-disabled={cancelling() ? "true" : undefined} onClick={() => void cancel()}>
                {cancelling() ? "Cancelling…" : "Cancel Switch"}
              </button>
            }
          />
        )}
      </Show>
      <Show when={!props.state?.pending && props.state?.failed}>{(f) => <Banner tone="error" title={switchRefused(f().name, f().reason).title} body={switchRefused(f().name, f().reason).body} />}</Show>
      <Show when={!props.state?.pending && !props.state?.failed && props.state?.applied}>{(a) => <Banner tone="success" title={switchedLine(a().name)} />}</Show>
    </div>
  );
}
