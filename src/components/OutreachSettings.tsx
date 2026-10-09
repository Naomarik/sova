import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { OutreachInfo } from "../../shared/outreach";
import {
  acceptOutreachInfo,
  getOutreach,
  outreachDraft as draft,
  outreachInfo,
  outreachProblem,
  outreachSaveError,
  outreachSaving as saving,
  pauseSender,
  putOutreach,
  reconnectSender,
  senderActions,
  senderFacts,
  senderWords,
  setOutreachDraft,
  setOutreachInfo,
  startSender,
  type OutreachDraft,
} from "../lib/outreach";
import { announce } from "../lib/ui-state";
import { Banner, Chip } from "./ui";
import "../orgs.css";

/** How often the open page reads the sender's state again, so it is live, not only as of the open. */
const LIVE_MS = 5_000;

/**
 * Settings → Outreach (§app.settings-dialog/outreach): how this host reaches the WhatsApp sender
 * (Off · This host · Via a peer) and, when it is here, which peers may send through it; both staged
 * for the dialog's Save Changes. The sender's state, read again every few seconds while the page is
 * open (why it stopped, when it tries again, sends and reconnects against their limits), its controls
 * (§app.outreach/sender-controls: Reconnect Now, Pause/Resume Sender, Start Sender, each saying what it
 * does before it runs), Check Again, this host's Pause all sending (at once), the protected paths,
 * and the note that sent links stay in the operator's own chat history.
 */
export function OutreachSettingsSection() {
  const [stored, { refetch }] = createResource(getOutreach);
  createEffect(() => {
    const i = stored.error ? undefined : stored();
    if (i) acceptOutreachInfo(i);
  });
  const info = (): OutreachInfo | undefined => outreachInfo() ?? (stored.error ? undefined : stored());
  const edit = (patch: Partial<OutreachDraft>) => {
    const d = draft();
    if (d) setOutreachDraft({ ...d, ...patch });
  };
  const off = () => !draft() || saving();
  // Live: the state alone is replaced (setOutreachInfo), never the saved file the draft rebases on.
  const [now, setNow] = createSignal(Date.now());
  const live = setInterval(() => {
    setNow(Date.now());
    if (document.hidden || busy()) return;
    getOutreach().then(setOutreachInfo, () => {});
  }, LIVE_MS);
  onCleanup(() => clearInterval(live));
  const words = () => {
    const s = info()?.sender;
    return s ? senderWords(s, now()) : null;
  };
  const facts = () => {
    const s = info()?.sender;
    return s ? senderFacts(s, now()) : [];
  };
  const actions = () => {
    const i = info();
    return i ? senderActions(i) : { reconnect: false as const, pause: null, start: false };
  };
  const [pausing, setPausing] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  /** A sender control in flight ("reconnect" | "pause" | "start"), or null. */
  const [busy, setBusy] = createSignal<string | null>(null);
  const [confirmBlocked, setConfirmBlocked] = createSignal(false);
  const [controlError, setControlError] = createSignal<string | null>(null);
  const control = async (name: string, run: () => Promise<OutreachInfo>, said: string) => {
    setBusy(name);
    try {
      setOutreachInfo(await run());
      setControlError(null);
      setConfirmBlocked(false);
      announce(said);
    } catch (err) {
      setControlError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const togglePause = async (on: boolean) => {
    setPausing(true);
    try {
      setOutreachInfo(await putOutreach({ paused: on }));
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPausing(false);
    }
  };
  const peers = () => info()?.peers ?? [];

  return (
    <section class="settings-section outreach-settings" aria-labelledby="outreach-heading">
      <h3 class="settings-heading" id="outreach-heading">
        Outreach
      </h3>
      <p class="settings-intro">Send a person their gathering link on WhatsApp, from a sender that holds your number. Sova never pairs or unlinks it.</p>
      <Show when={stored.error}>
        <Banner tone="error" title="Outreach settings can't be read." />
      </Show>
      <Show when={info()?.problem}>{(p) => <Banner tone="warn" title={`outreach.json is ignored until it is fixed: ${p()}`} />}</Show>

      <fieldset class="field">
        <legend class="field-label">Sender</legend>
        <label class="toggle public-links-choice">
          <input type="radio" name="outreach-sender" checked={draft()?.sender === "off"} disabled={off()} onChange={() => edit({ sender: "off" })} />
          <span class="toggle-box" aria-hidden="true" />
          <span class="public-links-choice-name">Off</span>
        </label>
        <label class="toggle public-links-choice">
          <input type="radio" name="outreach-sender" checked={draft()?.sender === "local"} disabled={off()} onChange={() => edit({ sender: "local" })} />
          <span class="toggle-box" aria-hidden="true" />
          <span class="public-links-choice-name">This host</span>
        </label>
        <Show when={draft()?.sender === "local"}>
          <div class="field settings-field">
            <label class="field-label" for="outreach-socket">
              Socket
            </label>
            <input
              id="outreach-socket"
              class="input input-mono"
              autocomplete="off"
              placeholder="Default: the sender's own (sova/whatsapp/sender.sock)"
              value={draft()?.socket ?? ""}
              disabled={off()}
              onInput={(e) => edit({ socket: e.currentTarget.value })}
            />
          </div>
        </Show>
        <label class="toggle public-links-choice">
          <input type="radio" name="outreach-sender" checked={draft()?.sender === "via"} disabled={off() || peers().length === 0} onChange={() => edit({ sender: "via", viaNodeId: draft()?.viaNodeId || peers()[0]?.nodeId || "" })} />
          <span class="toggle-box" aria-hidden="true" />
          <span class="public-links-choice-name">Via a peer{peers().length === 0 ? " (no peers)" : ""}</span>
        </label>
        <Show when={draft()?.sender === "via"}>
          <div class="field settings-field">
            <label class="field-label" for="outreach-via">
              Peer
            </label>
            <select id="outreach-via" class="input" value={draft()?.viaNodeId ?? ""} disabled={off()} onChange={(e) => edit({ viaNodeId: e.currentTarget.value })}>
              <For each={peers()}>{(p) => <option value={p.nodeId}>{p.label}</option>}</For>
            </select>
          </div>
        </Show>
        <Show when={draft() && outreachProblem(draft()!)}>{(p) => <span class="field-error">{p()}</span>}</Show>
      </fieldset>

      <Show when={words()}>
        {(w) => (
          <div class="outreach-sender">
            <div class="outreach-state" role="status">
              <Chip tone={w().tone}>{w().chip}</Chip>
              <span class="outreach-state-text">{w().text}</span>
            </div>
            <Show when={facts().length > 0}>
              <ul class="outreach-facts">
                <For each={facts()}>{(f) => <li>{f}</li>}</For>
              </ul>
            </Show>
            <Show when={confirmBlocked()}>
              <Banner
                tone="warn"
                title="WhatsApp blocked this account."
                body="Reconnecting soon after a block can get the number banned for good; waiting a day or more is safer. Sending stays paused until you press Resume Sender too."
                action={
                  <span class="outreach-actions">
                    <button type="button" class="button button-sm button-destructive" disabled={busy() !== null} onClick={() => void control("reconnect", reconnectSender, "Reconnecting the sender.")}>
                      Reconnect Anyway
                    </button>
                    <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmBlocked(false)}>
                      Cancel
                    </button>
                  </span>
                }
              />
            </Show>
            <div class="outreach-controls">
              <Show when={actions().reconnect && !confirmBlocked()}>
                <div class="outreach-control">
                  <button
                    type="button"
                    class="button button-sm"
                    disabled={busy() !== null}
                    onClick={() => (actions().reconnect === "blocked" ? setConfirmBlocked(true) : void control("reconnect", reconnectSender, "Reconnecting the sender."))}
                  >
                    {busy() === "reconnect" ? "Reconnecting…" : "Reconnect Now"}
                  </button>
                  <span class="field-hint">Tries to connect once now; doesn't count against the automatic limit.</span>
                </div>
              </Show>
              <Show when={actions().pause}>
                {(p) => (
                  <div class="outreach-control">
                    <button type="button" class="button button-sm" disabled={busy() !== null} onClick={() => void control("pause", () => pauseSender(p() === "pause"), p() === "pause" ? "The sender is paused." : "The sender is resumed.")}>
                      {p() === "pause" ? "Pause Sender" : "Resume Sender"}
                    </button>
                    <span class="field-hint">
                      {p() === "pause"
                        ? "Refuses every send through this sender, from every host, until you resume it. The connection stays up."
                        : "Sends through this sender go again, from every host it accepts."}
                    </span>
                  </div>
                )}
              </Show>
              <Show when={actions().start}>
                <div class="outreach-control">
                  <button type="button" class="button button-sm" disabled={busy() !== null} onClick={() => void control("start", startSender, "Starting the sender.")}>
                    {busy() === "start" ? "Starting…" : "Start Sender"}
                  </button>
                  <span class="field-hint">
                    Runs <code>systemctl --user start {info()?.unit?.name}</code> once. Sova never restarts or stops it.
                  </span>
                </div>
              </Show>
              <div class="outreach-control">
                <button type="button" class="button button-sm button-ghost" onClick={() => void refetch()}>
                  Check Again
                </button>
              </div>
            </div>
            <Show when={controlError()}>{(e) => <Banner tone="error" title={e()} />}</Show>
          </div>
        )}
      </Show>

      <Show when={draft()?.sender === "local"}>
        <fieldset class="field">
          <legend class="field-label">Accept sends from</legend>
          <label class="toggle public-links-choice">
            <input type="radio" name="outreach-accept" checked={Array.isArray(draft()?.acceptFrom) && (draft()!.acceptFrom as string[]).length === 0} disabled={off()} onChange={() => edit({ acceptFrom: [] })} />
            <span class="toggle-box" aria-hidden="true" />
            <span class="public-links-choice-name">No other host</span>
          </label>
          <label class="toggle public-links-choice">
            <input type="radio" name="outreach-accept" checked={draft()?.acceptFrom === "all"} disabled={off()} onChange={() => edit({ acceptFrom: "all" })} />
            <span class="toggle-box" aria-hidden="true" />
            <span class="public-links-choice-name">All peers</span>
          </label>
          <ul class="public-links-accept-list">
            <For each={peers()}>
              {(p) => (
                <li>
                  <label class="toggle public-links-check">
                    <input
                      type="checkbox"
                      checked={Array.isArray(draft()?.acceptFrom) && (draft()!.acceptFrom as string[]).includes(p.nodeId)}
                      disabled={off() || draft()?.acceptFrom === "all"}
                      onChange={(e) => {
                        const cur = Array.isArray(draft()?.acceptFrom) ? (draft()!.acceptFrom as string[]) : [];
                        edit({ acceptFrom: e.currentTarget.checked ? [...cur.filter((x) => x !== p.nodeId), p.nodeId] : cur.filter((x) => x !== p.nodeId) });
                      }}
                    />
                    <span class="toggle-box" aria-hidden="true" />
                    <span>{p.label}</span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </fieldset>
      </Show>

      <label class="toggle">
        <input type="checkbox" checked={!!info()?.file.paused} disabled={!info() || pausing()} onChange={(e) => void togglePause(e.currentTarget.checked)} />
        <span class="toggle-box" aria-hidden="true" />
        <span>Pause all sending from this host</span>
      </label>
      <Show when={actionError()}>{(e) => <Banner tone="error" title={e()} />}</Show>

      <Show when={(info()?.protected.length ?? 0) > 0}>
        <div class="field">
          <span class="field-label">Protected paths</span>
          <span class="field-hint">Hidden from the Overseer's file tools:</span>
          <ul class="outreach-protected">
            <For each={info()!.protected}>{(p) => <li class="input-mono">{p}</li>}</For>
          </ul>
        </div>
      </Show>
      <Show when={info()?.sandboxWarning}>{(w) => <Banner tone="warn" title={w()} />}</Show>

      <p class="settings-intro">
        Links you send stay in your own WhatsApp chat history: anyone with your phone can open them. Setting up the sender: <code>docs/outreach/whatsapp.md</code>.
      </p>
      <Show when={outreachSaveError()}>{(e) => <Banner tone="error" title={`Outreach wasn't saved: ${e().message}`} />}</Show>
    </section>
  );
}
