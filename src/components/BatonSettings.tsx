import { createEffect, createResource, onMount, Show } from "solid-js";
import { BATON_RULES } from "../../shared/baton-limits";
import { getBatonSettings } from "../lib/api";
import { batonDraft, batonSaved, batonSaveError, batonSaving as saving, samePick, setBatonDraft, setBatonSaved, type BatonDraft } from "../lib/baton-settings-draft";
import { ensureModels, modelByRef, modelList } from "../lib/models";
import { ensureModelPolicy, modelEnabled, modelPolicy } from "../lib/model-policy";
import { priceLine } from "./OwnerCardAssistant";
import { ModelPickButton, pickLabel } from "./ModelPickButton";
import { NumberField, Toggle } from "./form";
import { Banner } from "./ui";
import "./BatonSettings.css";
import { RetryButton, sentence } from "./WorkerSlotRow";

/**
 * Settings → Organizations: the message limit a new hand-off session starts with (a start may set
 * its own; the operator extends one that reaches it), photos and files in gathering chats
 * (§app.baton/images), and the Project Assistant's default model (§app.project-assistant/models),
 * every organization's unless it picks its own. Host state, saved by the dialog's footer
 * (baton-settings-draft.ts holds the save and its error).
 */
export function BatonSettingsSection() {
  const [info, { refetch }] = createResource(getBatonSettings);
  createEffect(() => {
    const i = info.error ? undefined : info();
    if (i) setBatonSaved(i);
  });
  // The default's warnings read the model list and Settings → Models, as the picker does.
  onMount(() => {
    void ensureModels().catch(() => {});
    void ensureModelPolicy().catch(() => {});
  });
  /** Why the picked default won't answer or can't see photos, in the order that matters. */
  const assistantWarning = (): string | null => {
    const ref = batonDraft()?.assistant?.model;
    if (!ref || !modelList()) return null;
    const m = modelByRef(ref);
    if (!m) return "This host can't run this model: organizations that follow it aren't ready.";
    const policy = modelPolicy();
    if (policy && !modelEnabled(policy, ref)) return "Settings → Models turned this model off: organizations that follow it aren't ready.";
    if (m.input && !m.input.includes("image")) return "This model can't see photos: owners who follow it won't get an attach button.";
    return null;
  };
  /** The saved default's price; an unsaved pick says it shows once saved. */
  const assistantPrice = (): string | null => {
    const d = batonDraft()?.assistant;
    if (!d) return null;
    const s = batonSaved()?.assistant;
    return s && samePick(s, d) ? priceLine(s) : "Its price shows once saved.";
  };
  const edit = (patch: Partial<BatonDraft>) => {
    const d = batonDraft();
    if (d) setBatonDraft({ ...d, ...patch });
  };
  /** A number box; its range is its hint, and its rule's sentence when it is out of it. */
  const box = (key: keyof typeof BATON_RULES, label: string, opts: { hint?: string; off?: boolean } = {}) => {
    const r = BATON_RULES[key];
    return (
      <NumberField
        label={label}
        hint={opts.hint ?? `${r.min}–${r.max}`}
        rule={r}
        value={batonDraft()?.[key] ?? ""}
        disabled={saving() || opts.off}
        onInput={(v) => edit({ [key]: v })}
      />
    );
  };
  return (
    <section class="settings-delegate" aria-labelledby="settings-orgs-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-orgs-title">
          Hand-off sessions
        </h3>
      </div>
      <p class="settings-intro">
        How many messages a hand-off session takes in, from everyone, before it comes back to you. A session can set its own
        when you start it, and you can extend one that reaches its limit.
      </p>
      <Show when={info.error}>
        <Banner tone="error" title="Couldn't load the hand-off settings." body="Nothing was changed." action={<RetryButton label="Try Again" onClick={() => void refetch()} />} />
      </Show>
      <Show when={batonDraft() !== null}>
        {box("messagesMax", "Message limit", { hint: "New sessions only; sessions already started keep theirs." })}
        <h4 class="settings-type-title" id="settings-orgs-photos">
          Photos in gathering chats
        </h4>
        <Toggle switch label="People can send photos" checked={batonDraft()?.photosOn ?? true} disabled={saving()} onChange={(on) => edit({ photosOn: on })} />
        <div class="orgs-fields" role="group" aria-labelledby="settings-orgs-photos">
          {box("perMessage", "Per message", { off: !batonDraft()?.photosOn })}
          {box("mb", "Largest photo, MB", { off: !batonDraft()?.photosOn })}
          {box("perConversation", "Per conversation", { off: !batonDraft()?.photosOn })}
        </div>
        <p class="field-hint">Applies to every gathering session on this host, from its next message.</p>
        <h4 class="settings-type-title" id="settings-orgs-files">
          Files in gathering chats
        </h4>
        <div class="orgs-fields" role="group" aria-labelledby="settings-orgs-files">
          {box("fileMb", "Largest file, MB")}
        </div>
        <p class="field-hint">Applies to gathering sessions that take files, from the next upload.</p>
        <h4 class="settings-type-title" id="settings-orgs-assistant">
          Project Assistant
        </h4>
        <div class="field" role="group" aria-labelledby="settings-orgs-assistant-label">
          <span class="field-label" id="settings-orgs-assistant-label">
            Default model
          </span>
          <div class="settings-assistant-default">
            <Show when={batonDraft()?.assistant}>{(p) => <span class="settings-assistant-value">{pickLabel(p())}</span>}</Show>
            <ModelPickButton
              id="settings-assistant-default"
              label={batonDraft()?.assistant ? "Change" : "Choose Model"}
              ariaLabel={batonDraft()?.assistant ? "Change the Project Assistant's default model" : undefined}
              value={batonDraft()?.assistant ?? null}
              disabled={saving()}
              onPick={(pick) => edit({ assistant: pick })}
            />
          </div>
          <Show when={assistantPrice()}>{(t) => <span class="field-hint">{t()}</span>}</Show>
          <span class="field-hint">Every organization uses it unless it picks its own.</span>
          <Show when={assistantWarning()}>{(w) => <span class="field-hint settings-assistant-warn">{w()}</span>}</Show>
        </div>
        <Show when={batonSaveError()}>{(e) => <Banner tone="error" title="Couldn't save the message limit." body={`${sentence(e().message)} Your saved limit is unchanged.`} />}</Show>
      </Show>
    </section>
  );
}
