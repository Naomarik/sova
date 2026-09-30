import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { PUSH_KINDS, type PushKind, type PushTestResult } from "../../shared/protocol";
import { contactProblem } from "../../shared/push";
import { deletePushSubscription, getPushInfo, sendPushTest } from "../lib/api";
import { relativeTime, tildePath } from "../lib/format";
import {
  currentSubscription,
  deviceIdOf,
  disableThisDevice,
  enableThisDevice,
  notificationPermission,
  pushSupport,
} from "../lib/push";
import { pushDraft as draft, pushSaveError, pushSaving as saving, setPushDraft, setPushSaved } from "../lib/push-draft";
import { home } from "../lib/ui-state";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

/** The kind words, as the notifications say them (server/push.ts PUSH_KIND_LABEL), with what each means. */
const KIND: Record<PushKind, { label: string; hint: string }> = {
  "needs-input": { label: "Needs input", hint: "A dialog is open." },
  "open-questions": { label: "Open questions", hint: "An alignment has questions waiting on your answer." },
  error: { label: "Error", hint: "The last turn stopped with an error." },
  "baton-needs-you": { label: "Baton", hint: "A baton session waits on you." },
  "worker-error": { label: "Subagent error", hint: "A subagent ended in an error." },
};

/**
 * Settings → Notifications → Phone Notifications: this device's subscription (an action, at once), the
 * device list with Remove and Send Test (actions), and the settings the dialog's Save Changes
 * writes (push-draft.ts): the switch, the contact address, the kinds and quiet hours.
 */
export function PushSettingsSection() {
  const [info, { refetch }] = createResource(getPushInfo);
  const loaded = () => (info.error ? undefined : info());
  createEffect(() => {
    const i = loaded();
    if (i) setPushSaved(i.settings);
  });

  const support = pushSupport();
  const [permission, setPermission] = createSignal(notificationPermission());
  /** This browser's device id while it holds a subscription; null without one. */
  const [thisId, setThisId] = createSignal<string | null>(null);
  const readThisDevice = async () => {
    const sub = await currentSubscription().catch(() => null);
    setThisId(sub ? await deviceIdOf(sub.endpoint) : null);
  };
  void readThisDevice();

  const [busy, setBusy] = createSignal<"enable" | "disable" | "test" | string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [test, setTest] = createSignal<PushTestResult | null>(null);

  const subscribedHere = () => {
    const id = thisId();
    return !!id && !!loaded()?.devices.some((d) => d.id === id);
  };

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(sentence(err instanceof Error ? err.message : String(err)));
    } finally {
      setPermission(notificationPermission());
      await readThisDevice();
      void refetch();
      setBusy(null);
    }
  };

  const d = () => draft();
  const edit = (patch: Partial<NonNullable<ReturnType<typeof draft>>>) => {
    const cur = d();
    if (cur) setPushDraft({ ...cur, ...patch });
  };
  const contactIssue = () => {
    const c = d()?.contact.trim() ?? "";
    return c ? contactProblem(c) : null;
  };
  const savedContact = () => !!loaded()?.settings.contact;

  const testSummary = (r: PushTestResult) => {
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.filter((x) => !x.ok);
    const head = `Sent to ${ok} of ${r.results.length} device${r.results.length === 1 ? "" : "s"}.`;
    return failed.length ? `${head} ${failed.map((f) => `${f.label}: ${sentence(f.error ?? "failed")}`).join(" ")}` : head;
  };

  return (
    <section class="settings-delegate push-settings" aria-labelledby="settings-push-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-push-title">
          Phone Notifications
        </h3>
      </div>
      <p class="settings-intro">Sova can notify your phone when a session needs you, even with Sova closed.</p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the notification settings."
          body={sentence(info.error instanceof Error ? info.error.message : String(info.error))}
          action={<RetryButton label="Try Again" onClick={() => void refetch()} />}
        />
      </Show>

      <Show when={loaded()}>
        {(i) => (
          <>
            <fieldset class="settings-delegate-profile">
              <legend class="settings-delegate-legend">This device</legend>
              <Show
                when={support === "ok"}
                fallback={
                  <p class="field-hint" data-testid="push-unsupported">
                    {support === "ios-home-screen"
                      ? "On iPhone and iPad, add Sova to your Home Screen first, then open it from there to turn this on."
                      : support === "insecure"
                        ? "This browser allows notifications only over https or on localhost."
                        : support === "no-worker"
                          ? "Notifications need the built app. The development server runs no service worker."
                          : "This browser can't receive push notifications."}
                  </p>
                }
              >
                <div class="push-this-device">
                  <Show
                    when={permission() !== "denied"}
                    fallback={<p class="field-hint">Notifications are blocked for Sova in this browser's settings. Allow them there to turn this on.</p>}
                  >
                    <Show
                      when={subscribedHere()}
                      fallback={
                        <>
                          <p class="push-status">
                            <Chip>Off</Chip> <span>Not on for this device.</span>
                          </p>
                          <button type="button" class="button button-primary button-sm" disabled={!!busy()} onClick={() => void run("enable", enableThisDevice)}>
                            {busy() === "enable" ? "Turning On…" : "Enable on This Device"}
                          </button>
                        </>
                      }
                    >
                      <p class="push-status">
                        <Chip tone="success">On</Chip> <span>On for this device.</span>
                      </p>
                      <button type="button" class="button button-sm" disabled={!!busy()} onClick={() => void run("disable", disableThisDevice)}>
                        {busy() === "disable" ? "Turning Off…" : "Turn Off on This Device"}
                      </button>
                    </Show>
                  </Show>
                </div>
              </Show>
              <Show when={actionError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
            </fieldset>

            <fieldset class="settings-delegate-profile">
              <legend class="settings-delegate-legend">Devices</legend>
              <Show when={i().devices.length > 0} fallback={<p class="field-hint">No devices yet.</p>}>
                <ul class="push-devices" data-testid="push-devices">
                  <For each={i().devices}>
                    {(dev) => (
                      <li class="push-device">
                        <div class="push-device-text">
                          <span class="push-device-name">
                            {dev.label}
                            <Show when={dev.id === thisId()}>
                              <span class="field-hint"> · this device</span>
                            </Show>
                          </span>
                          <span class="push-device-fact">
                            Added {relativeTime(dev.createdAt)}.{" "}
                            <Show
                              when={dev.lastError && (dev.lastErrorAt ?? 0) >= (dev.lastOkAt ?? 0)}
                              fallback={<Show when={dev.lastOkAt}>{(t) => <>Last delivered {relativeTime(t())}.</>}</Show>}
                            >
                              <span class="push-device-error">Last try failed: {dev.lastError}</span>
                            </Show>
                          </span>
                        </div>
                        <button
                          type="button"
                          class="button button-sm button-ghost"
                          aria-label={`Remove ${dev.label}`}
                          disabled={!!busy()}
                          onClick={() =>
                            void run(dev.id, async () => {
                              // This browser's own device: drop its subscription too, so nothing re-adds it.
                              if (dev.id === thisId()) await disableThisDevice();
                              else await deletePushSubscription({ id: dev.id });
                            })
                          }
                        >
                          Remove
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class="settings-delegate-actions">
                <button
                  type="button"
                  class="button button-sm"
                  disabled={!!busy() || i().devices.length === 0}
                  title={!savedContact() ? "Save a contact address first." : undefined}
                  onClick={() =>
                    void run("test", async () => {
                      setTest(null);
                      setTest(await sendPushTest());
                    })
                  }
                >
                  {busy() === "test" ? "Sending…" : "Send Test"}
                </button>
              </div>
              <Show when={test()}>
                {(r) => (
                  <p class="field-hint" role="status" data-testid="push-test-result">
                    {testSummary(r())}
                  </p>
                )}
              </Show>
            </fieldset>

            <Show when={d()}>
              {(cur) => (
                <fieldset class="settings-delegate-profile">
                  <legend class="settings-delegate-legend">Settings</legend>
                  <label class="toggle toggle-switch settings-team-enable">
                    <span>Send phone notifications</span>
                    <input type="checkbox" checked={cur().enabled} disabled={saving()} onChange={(e) => edit({ enabled: e.currentTarget.checked })} />
                    <span class="toggle-box" />
                  </label>
                  <p class="field-hint">Off, nothing is sent to any device. Send Test still works.</p>

                  <div class="field">
                    <label class="field-label" for="push-contact">
                      Contact address
                    </label>
                    <input
                      class="input text-mono"
                      id="push-contact"
                      type="text"
                      inputmode="email"
                      autocomplete="off"
                      spellcheck={false}
                      placeholder="mailto:you@example.com"
                      value={cur().contact}
                      aria-invalid={contactIssue() ? "true" : undefined}
                      aria-describedby="push-contact-hint"
                      disabled={saving()}
                      onInput={(e) => edit({ contact: e.currentTarget.value })}
                    />
                    <Show
                      when={contactIssue()}
                      fallback={
                        <span class="field-hint" id="push-contact-hint">
                          A mailto: address or https:// URL for whoever runs this server. Push services require one, and nothing is sent without it.
                        </span>
                      }
                    >
                      {(p) => (
                        <span class="field-error" id="push-contact-hint">
                          {p()}
                        </span>
                      )}
                    </Show>
                  </div>

                  <div class="field">
                    <span class="field-label" id="push-kinds-label">
                      Notify me about
                    </span>
                    <div class="push-kinds" role="group" aria-labelledby="push-kinds-label">
                      <For each={PUSH_KINDS}>
                        {(k) => (
                          <label class="toggle">
                            <input
                              type="checkbox"
                              checked={cur().kinds[k]}
                              disabled={saving()}
                              onChange={(e) => edit({ kinds: { ...cur().kinds, [k]: e.currentTarget.checked } })}
                            />
                            <span class="toggle-box" aria-hidden="true" />
                            <span>
                              {KIND[k].label}
                              <span class="field-hint"> · {KIND[k].hint}</span>
                            </span>
                          </label>
                        )}
                      </For>
                    </div>
                  </div>

                  <label class="toggle toggle-switch settings-team-enable">
                    <span>Quiet hours</span>
                    <input
                      type="checkbox"
                      checked={cur().quietHours.enabled}
                      disabled={saving()}
                      onChange={(e) => edit({ quietHours: { ...cur().quietHours, enabled: e.currentTarget.checked } })}
                    />
                    <span class="toggle-box" />
                  </label>
                  <div class="push-quiet">
                    <div class="field">
                      <label class="field-label" for="push-quiet-start">
                        From
                      </label>
                      <input
                        class="input text-num"
                        id="push-quiet-start"
                        type="time"
                        value={cur().quietHours.start}
                        disabled={saving() || !cur().quietHours.enabled}
                        onInput={(e) => edit({ quietHours: { ...cur().quietHours, start: e.currentTarget.value } })}
                      />
                    </div>
                    <div class="field">
                      <label class="field-label" for="push-quiet-end">
                        To
                      </label>
                      <input
                        class="input text-num"
                        id="push-quiet-end"
                        type="time"
                        value={cur().quietHours.end}
                        disabled={saving() || !cur().quietHours.enabled}
                        onInput={(e) => edit({ quietHours: { ...cur().quietHours, end: e.currentTarget.value } })}
                      />
                    </div>
                  </div>
                  <p class="field-hint">This server's clock. What arrives during quiet hours is never sent, not even later.</p>
                </fieldset>
              )}
            </Show>

            <Show when={pushSaveError()}>
              {(e) => <Banner tone="error" title="Couldn't save the notification settings." body={`${sentence(e().message)} Your saved settings are unchanged.`} />}
            </Show>
            <p class="settings-delegate-file">
              Stored in <code>{tildePath(i().file, home())}</code>.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
