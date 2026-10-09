import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { LABEL_MAX, type OutreachInfo, type SenderEntry } from "../../shared/outreach";
import {
  acceptOutreachInfo,
  entryChoice,
  entryPicked,
  getSenders,
  numberWords,
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

/** A sender's own name, before the operator's label: This host, the added number's name, or the peer's. */
function baseLabel(id: string, peers: { nodeId: string; label: string }[]): string {
  if (id === "local") return "This host";
  if (id.startsWith("local:")) return id.slice("local:".length);
  const nodeId = id.slice("peer:".length);
  return peers.find((p) => p.nodeId === nodeId)?.label ?? nodeId;
}

/**
 * Settings → Outreach (§app.settings-dialog/outreach): the numbers this host can send from
 * (§app.outreach/sender-list: this host's own, the numbers added on it, each peer's that accepts it),
 * the default picked with a radio, Off; Add a Number, each number's label, and, when the default is
 * here, which peers may send through it; all staged for the dialog's Save Changes. One number at a
 * time is managed (the default at first): its state, read again every few seconds while the page is
 * open (why it stopped, when it tries again, sends and reconnects against its limits), its controls
 * (§app.outreach/sender-controls: Reconnect Now, Pause/Resume Sender, Start Sender; and on its own host
 * Link a Phone / Unlink This Number, §app.outreach/sender-link; each saying what it does before it
 * runs), Check Again, this host's Pause all sending (at once), the protected paths, and the note that
 * sent links stay in the operator's own chat history.
 */
export function OutreachSettingsSection() {
  /** The number whose state and controls show (null: the default). */
  const [managed, setManaged] = createSignal<string | null>(null);
  const [stored, { refetch }] = createResource(() => getOutreach());
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
    getOutreach(managed() ?? undefined).then(setOutreachInfo, () => {});
  }, LIVE_MS);
  onCleanup(() => clearInterval(live));
  // The list of senders: read on open, after a save (the saved file changes) and on Check Again.
  const savedFile = () => JSON.stringify(info()?.file ?? null);
  const [senders, { refetch: refetchSenders }] = createResource(savedFile, () => getSenders());
  const peers = () => info()?.peers ?? [];
  /** The list as the draft has it: an added number staged for removal leaves it, one staged to add joins it (not saved yet). */
  const entries = (): (SenderEntry & { unsaved?: true })[] => {
    const listed = senders.error ? [] : (senders.latest ?? []);
    const d = draft();
    if (!d) return listed;
    const kept = listed.filter((e) => !e.id.startsWith("local:") || d.numbers.some((n) => `local:${n.id}` === e.id));
    const added = d.numbers
      .filter((n) => !kept.some((e) => e.id === `local:${n.id}`))
      .map((n) => ({ id: `local:${n.id}`, where: "local" as const, socket: n.socket, label: n.id, status: { state: "unreachable" as const }, chosen: false, unsaved: true as const }));
    const firstPeer = kept.findIndex((e) => e.where === "peer");
    return firstPeer < 0 ? [...kept, ...added] : [...kept.slice(0, firstPeer), ...added, ...kept.slice(firstPeer)];
  };
  const labelFor = (id: string) => draft()?.labels[id]?.trim() || baseLabel(id, peers());
  const selected = () => info()?.selected ?? null;
  const here = () => {
    const id = selected() ?? "";
    return id === "local" || id.startsWith("local:");
  };
  const manage = (id: string) => {
    setManaged(id);
    setControlError(null);
    setConfirmBlocked(false);
    void getOutreach(id).then(setOutreachInfo, () => {});
  };
  const [adding, setAdding] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newSocket, setNewSocket] = createSignal("");
  const addNumber = () => {
    const d = draft();
    if (!d) return;
    edit({ numbers: [...d.numbers, { id: newName().trim(), socket: newSocket().trim() }] });
    setAdding(false);
    setNewName("");
    setNewSocket("");
  };
  const removeNumber = (id: string) => {
    const d = draft();
    if (!d) return;
    const name = id.slice("local:".length);
    const { [id]: _gone, ...labels } = d.labels;
    edit({ numbers: d.numbers.filter((n) => n.id !== name), labels });
    if (managed() === id) manage(d.sender === "off" ? "local" : d.sender);
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
        <legend class="field-label">Numbers</legend>
        <span class="field-hint">The default sends for every organization that doesn't pick its own number in its settings. A message never moves to another number.</span>
        <ul class="sender-list">
          <For each={entries()}>
            {(e) => {
              // The managed number's row follows the state this page reads every few seconds; the others are as of the list's read.
              const st = () => (e.id === selected() && info()?.sender) || e.status;
              const w = () => senderWords(st(), now(), e.where === "local");
              const missing = () => e.where === "local" && st().state === "unreachable" && e.id !== selected();
              return (
                <li class="sender-row">
                  <label class="toggle public-links-choice">
                    <input type="radio" name="outreach-sender" checked={entryPicked(e, draft())} disabled={off()} onChange={() => edit(entryChoice(e))} />
                    <span class="toggle-box" aria-hidden="true" />
                    <span class="sender-row-main">
                      <span class="sender-row-head">
                        <span class="public-links-choice-name">{labelFor(e.id)}</span>
                        <Show when={st().me}>{(me) => <span class="sender-row-number input-mono">{me()}</span>}</Show>
                        <Show when={entryPicked(e, draft())}>
                          <span class="sender-row-default">Default</span>
                        </Show>
                        <Show when={!missing() && !e.unsaved}>
                          <Chip tone={w().tone}>{w().chip}</Chip>
                        </Show>
                      </span>
                      <span class="sender-row-facts">
                        {e.unsaved
                          ? "Added when you save."
                          : missing()
                            ? "No sender answers on this host."
                            : st().state === "unreachable"
                              ? (st().why ?? "Not reachable.")
                              : (senderUse(st()) ?? "")}
                      </span>
                      <Show when={e.socket}>{(sock) => <span class="sender-row-facts input-mono">{sock()}</span>}</Show>
                    </span>
                  </label>
                  <Show when={!e.unsaved && e.id !== selected()}>
                    <button type="button" class="button button-sm button-ghost sender-row-manage" onClick={() => manage(e.id)} aria-label={`Manage ${labelFor(e.id)}`}>
                      Manage
                    </button>
                  </Show>
                  <Show when={e.unsaved}>
                    <button type="button" class="button button-sm button-ghost sender-row-manage" disabled={off()} onClick={() => removeNumber(e.id)}>
                      Remove Number
                    </button>
                  </Show>
                  <Show when={e.id === "local" && draft()?.sender === "local"}>
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
        <Show
          when={adding()}
          fallback={
            <div class="button-row">
              <button type="button" class="button button-sm" disabled={off()} onClick={() => setAdding(true)}>
                Add a Number
              </button>
            </div>
          }
        >
          <div class="sender-add">
            <span class="field-hint">Another sender on this host, one number each: its own SOVA_WA_HOME and socket. The guide to running a second number: docs/outreach/whatsapp.md.</span>
            <div class="field settings-field">
              <label class="field-label" for="outreach-new-name">
                Name
              </label>
              <input id="outreach-new-name" class="input input-mono" autocomplete="off" placeholder="sales" value={newName()} onInput={(ev) => setNewName(ev.currentTarget.value)} />
            </div>
            <div class="field settings-field">
              <label class="field-label" for="outreach-new-socket">
                Socket
              </label>
              <input id="outreach-new-socket" class="input input-mono" autocomplete="off" placeholder="Absolute, like …/sova/whatsapp-sales/sender.sock" value={newSocket()} onInput={(ev) => setNewSocket(ev.currentTarget.value)} />
            </div>
            <div class="button-row">
              <button type="button" class="button button-sm" disabled={!newName().trim() || !newSocket().trim()} onClick={addNumber}>
                Add Number
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Show>
        <Show when={senders.error}>
          <span class="field-error">The list of senders can't be read. Check Again to retry.</span>
        </Show>
        <Show when={draft() && outreachProblem(draft()!)}>{(p) => <span class="field-error">{p()}</span>}</Show>
      </fieldset>

      <Show when={words()}>
        {(w) => (
          <div class="outreach-sender">
            <Show when={selected()}>
              {(id) => (
                <div class="sender-manage">
                  <h4 class="sender-manage-head">
                    {numberWords({ label: labelFor(id()), me: info()?.sender.me })}
                  </h4>
                  <div class="field settings-field">
                    <label class="field-label" for="outreach-label">
                      Label
                    </label>
                    <input
                      id="outreach-label"
                      class="input"
                      autocomplete="off"
                      maxLength={LABEL_MAX}
                      placeholder={baseLabel(id(), peers())}
                      value={draft()?.labels[id()] ?? ""}
                      disabled={off()}
                      onInput={(ev) => edit({ labels: { ...(draft()?.labels ?? {}), [id()]: ev.currentTarget.value } })}
                    />
                    <span class="field-hint">A short name for this number, like Office. Never the number itself.</span>
                  </div>
                  <Show when={id().startsWith("local:")}>
                    <div class="outreach-control">
                      <button type="button" class="button button-sm button-destructive" disabled={off() || draft()?.sender === id()} onClick={() => removeNumber(id())}>
                        Remove Number
                      </button>
                      <span class="field-hint">
                        {draft()?.sender === id() ? "It is the default: make another number the default first." : "Takes it off this list when you save. Its sender and its linked phone stay as they are."}
                      </span>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
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
                    <button type="button" class="button button-sm button-destructive" disabled={busy() !== null} onClick={() => void control("reconnect", () => reconnectSender(selected() ?? undefined), "Reconnecting the sender.")}>
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
                    onClick={() => (actions().reconnect === "blocked" ? setConfirmBlocked(true) : void control("reconnect", () => reconnectSender(selected() ?? undefined), "Reconnecting the sender."))}
                  >
                    {busy() === "reconnect" ? "Reconnecting…" : "Reconnect Now"}
                  </button>
                  <span class="field-hint">Tries to connect once now; doesn't count against the automatic limit.</span>
                </div>
              </Show>
              <Show when={actions().pause}>
                {(p) => (
                  <div class="outreach-control">
                    <button type="button" class="button button-sm" disabled={busy() !== null} onClick={() => void control("pause", () => pauseSender(p() === "pause", selected() ?? undefined), p() === "pause" ? "The sender is paused." : "The sender is resumed.")}>
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
              <Show when={selected()} keyed>
                {(id) => <SenderLink sender={id} link={actions().link} unlink={actions().unlink} disabled={busy() !== null} onChanged={(i) => (i ? setOutreachInfo(i) : void getOutreach(id).then(setOutreachInfo, () => {}))} />}
              </Show>
              <Show when={actions().start}>
                <div class="outreach-control">
                  <button type="button" class="button button-sm" disabled={busy() !== null} onClick={() => void control("start", () => startSender(selected() ?? undefined), "Starting the sender.")}>
                    {busy() === "start" ? "Starting…" : "Start Sender"}
                  </button>
                  <span class="field-hint">
                    Runs <code>systemctl --user start {info()?.unit?.name}</code> once. Sova never restarts or stops it.
                  </span>
                </div>
              </Show>
              <div class="outreach-control">
                <button type="button" class="button button-sm button-ghost" onClick={() => (void getOutreach(selected() ?? undefined).then(setOutreachInfo, () => {}), void refetch(), void refetchSenders())}>
                  Check Again
                </button>
              </div>
            </div>
            <Show when={controlError()}>{(e) => <Banner tone="error" title={e()} />}</Show>
          </div>
        )}
      </Show>

      <Show when={draft()?.sender === "local" || draft()?.sender.startsWith("local:")}>
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
