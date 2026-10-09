import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { OutreachInfo, SenderEntry } from "../../shared/outreach";
import {
  acceptOutreachInfo,
  entryChoice,
  entryPicked,
  getSenders,
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
  senderUse,
  senderWords,
  setOutreachDraft,
  setOutreachInfo,
  startSender,
  type OutreachDraft,
} from "../lib/outreach";
import { announce } from "../lib/ui-state";
import { SenderLink } from "./SenderLink";
import { Banner, Chip } from "./ui";
import "../orgs.css";

/** How often the open page reads the sender's state again, so it is live, not only as of the open. */
const LIVE_MS = 5_000;

/**
 * Settings → Outreach (§app.settings-dialog/outreach): which sender this host sends through, picked
 * from the list of every sender it can use (§app.outreach/sender-list: this host's own, each peer whose
 * sender accepts it, Off) and, when it is here, which peers may send through it; both staged for the
 * dialog's Save Changes. The chosen sender's state, read again every few seconds while the page is
 * open (why it stopped, when it tries again, sends and reconnects against their limits), its controls
 * (§app.outreach/sender-controls: Reconnect Now, Pause/Resume Sender, Start Sender; and on its own host
 * Link a Phone / Unlink This Number, §app.outreach/sender-link; each saying what it does before it
 * runs), Check Again, this host's Pause all sending (at once), the protected paths, and the note that
 * sent links stay in the operator's own chat history.
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
  // The list of senders: read on open, after a save (the saved file changes) and on Check Again.
  const savedRoute = () => JSON.stringify(info()?.file.sender ?? null);
  const [senders, { refetch: refetchSenders }] = createResource(savedRoute, () => getSenders());
  const entries = (): SenderEntry[] => (senders.error ? [] : (senders.latest ?? []));
  const here = () => {
    const r = info()?.file.sender;
    return typeof r === "object" && "local" in r;
  };
  const words = () => {
    const s = info()?.sender;
    return s ? senderWords(s, now(), here()) : null;
  };
  const facts = () => {
    const s = info()?.sender;
    return s ? senderFacts(s, now()) : [];
  };
  const actions = () => {
    const i = info();
    return i ? senderActions(i) : { reconnect: false as const, pause: null, start: false, link: false, unlink: false };
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
      <p class="settings-intro">Send a person their gathering link on WhatsApp, from a sender that holds your number.</p>
      <Show when={stored.error}>
        <Banner tone="error" title="Outreach settings can't be read." />
      </Show>
      <Show when={info()?.problem}>{(p) => <Banner tone="warn" title={`outreach.json is ignored until it is fixed: ${p()}`} />}</Show>

      <fieldset class="field">
        <legend class="field-label">Sender</legend>
        <span class="field-hint">The number this host sends from: its own sender, or a peer's that accepts it.</span>
        <ul class="sender-list">
          <For each={entries()}>
            {(e) => {
              // The chosen sender's row follows the state this page reads every few seconds; the others are as of the list's read.
              const st = () => (e.chosen && info()?.sender) || e.status;
              const w = () => senderWords(st(), now(), e.where === "local");
              const missing = () => e.where === "local" && st().state === "unreachable" && !e.chosen;
              return (
                <li class="sender-row">
                  <label class="toggle public-links-choice">
                    <input type="radio" name="outreach-sender" checked={entryPicked(e, draft())} disabled={off()} onChange={() => edit(entryChoice(e))} />
                    <span class="toggle-box" aria-hidden="true" />
                    <span class="sender-row-main">
                      <span class="sender-row-head">
                        <span class="public-links-choice-name">{e.label}</span>
                        <Show when={st().me}>{(me) => <span class="sender-row-number input-mono">{me()}</span>}</Show>
                        <Show when={!missing()}>
                          <Chip tone={w().tone}>{w().chip}</Chip>
                        </Show>
                      </span>
                      <span class="sender-row-facts">
                        {missing() ? "No sender answers on this host." : st().state === "unreachable" ? (st().why ?? "Not reachable.") : (senderUse(st()) ?? "")}
                      </span>
                    </span>
                  </label>
                  <Show when={e.where === "local" && draft()?.sender === "local"}>
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
                        onInput={(ev) => edit({ socket: ev.currentTarget.value })}
                      />
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
          <Show when={senders.loading && entries().length === 0}>
            <li class="field-hint">Asking this host and its peers for their senders…</li>
          </Show>
          <li class="sender-row">
            <label class="toggle public-links-choice">
              <input type="radio" name="outreach-sender" checked={draft()?.sender === "off"} disabled={off()} onChange={() => edit({ sender: "off" })} />
              <span class="toggle-box" aria-hidden="true" />
              <span class="public-links-choice-name">Off</span>
            </label>
          </li>
        </ul>
        <Show when={senders.error}>
          <span class="field-error">The list of senders can't be read. Check Again to retry.</span>
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
              <SenderLink link={actions().link} unlink={actions().unlink} disabled={busy() !== null} onChanged={(i) => (i ? setOutreachInfo(i) : void getOutreach().then(setOutreachInfo, () => {}))} />
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
                <button type="button" class="button button-sm button-ghost" onClick={() => (void refetch(), void refetchSenders())}>
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
        Links you send stay in your own WhatsApp chat history: anyone with your phone can open them. Installing a sender: <code>docs/outreach/whatsapp.md</code>.
      </p>
      <Show when={outreachSaveError()}>{(e) => <Banner tone="error" title={`Outreach wasn't saved: ${e().message}`} />}</Show>
    </section>
  );
}
