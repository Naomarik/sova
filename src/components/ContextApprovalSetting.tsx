import { createResource, createSignal, Show } from "solid-js";
import { getContextApproval, setContextApproval } from "../lib/api";
import { SETTING_HINT, SETTING_LABEL } from "../lib/approvals";
import { toast } from "../lib/ui-state";
import { Toggle } from "./form";

/**
 * Settings → General's **Context files and skills · this computer**: one Sova-wide switch. On (the
 * default), new chats load everything a folder offers except what you disallow; off, they ask first.
 * Saved at once; an open chat keeps the mode it started in.
 */
export function ContextApprovalSection() {
  const [setting, { mutate }] = createResource(getContextApproval);
  const [saving, setSaving] = createSignal(false);
  const change = (on: boolean, el: HTMLInputElement) => {
    if (saving()) {
      el.checked = !on;
      return;
    }
    setSaving(true);
    setContextApproval(on)
      .then((next) => mutate(next))
      .catch((err: Error) => {
        // Nothing changed: the switch goes back to what the server has.
        el.checked = !on;
        toast(`Couldn't change that. ${err.message}`);
      })
      .finally(() => setSaving(false));
  };
  return (
    <section class="settings-updates settings-context-approval" aria-labelledby="settings-context-approval-title">
      <h3 class="settings-type-title" id="settings-context-approval-title">
        Context files and skills · this computer
      </h3>
      <Show when={setting.error && !setting()}>
        <p class="field-error">Couldn't read this setting. {(setting.error as Error).message}</p>
      </Show>
      <Show when={setting()}>
        {(s) => <Toggle switch class="settings-field" label={SETTING_LABEL} hint={SETTING_HINT} checked={s().allowWithoutAsking} disabled={saving()} onChange={change} />}
      </Show>
    </section>
  );
}
