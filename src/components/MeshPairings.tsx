import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { LanStatus } from "../../shared/mesh-lan";
import { addMeshLanPairing, createMeshLanKey, fetchMeshLan, putMeshLanRelay, removeMeshLanPairing } from "../lib/api";
import { MESH_PRESETS, PRESET_HINT, PRESET_LABEL, type MeshPreset } from "../lib/mesh-access";
import { acceptorLine, acceptorReason, pairingProblem, pairingState, portWarning, relayLine, relayProblem, roleWord, type PairingDraft, type RelayExposure } from "../lib/mesh-lan";
import { announce, copyText } from "../lib/ui-state";
import { Banner, Chip, CopyButton, Icon } from "./ui";

const EMPTY: PairingDraft = { role: "dial", fingerprint: "", id: "", label: "", host: "", port: "", internet: false };

// What each internet choice means, said before it is saved (§mesh.lan/pairing).
const RELAY_INTERNET_RISK =
  "The port opens to the whole internet; the accept process answers it, not Sova. Whoever controls this host can reach every dial-out host paired with it, wherever it is, as far as that host's grant to this one allows.";
const PAIR_INTERNET_RISK =
  "This host keeps a connection open to that server from every network it joins, so whoever controls the server can reach this host as far as your grant to it allows. Networks that block the port or inspect TLS can't reach the relay. A work machine's policy may forbid this.";

/**
 * The Mesh page's dial-out pairings (§mesh.lan/pairing): this host's fingerprint, this host as a
 * relay, each pairing's connection, and pairing a host by pasting its fingerprint. A pairing is
 * also a host in the Hosts card, where its grant is set like any peer's.
 */
export function MeshPairings(props: { now: number; taken: readonly string[]; tick: number; onChanged(): void }) {
  const [status, { mutate, refetch }] = createResource(
    () => props.tick,
    () => fetchMeshLan().catch(() => null as LanStatus | null),
  );
  // Connections change on their own: read again every few seconds while the page is open.
  const timer = setInterval(() => void refetch(), 4000);
  onCleanup(() => clearInterval(timer));

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (what: () => Promise<LanStatus>, said: string): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true);
    setError(null);
    try {
      mutate(await what());
      announce(said);
      props.onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const [relayHost, setRelayHost] = createSignal<string | null>(null);
  const [relayPort, setRelayPort] = createSignal<string | null>(null);
  const [relayExposure, setRelayExposure] = createSignal<RelayExposure | null>(null);
  const host = () => relayHost() ?? status()?.relay?.host ?? "";
  const port = () => relayPort() ?? String(status()?.relay?.port ?? "");
  const exposure = () => relayExposure() ?? status()?.relay?.exposure ?? "lan";
  const acceptorState = () => status()?.acceptor.state ?? "not configured";
  // "The internet" is offered only while the accept process runs (or it is already the setting).
  const internetBlocked = () => acceptorReason(acceptorState());
  const [relayTouched, setRelayTouched] = createSignal(false);
  const saveRelay = async (e: Event) => {
    e.preventDefault();
    setRelayTouched(true);
    if (relayProblem(host(), port(), exposure(), acceptorState())) return;
    if (await run(() => putMeshLanRelay({ host: host().trim(), port: Number(port()), exposure: exposure() }), "Relay address saved.")) {
      setRelayHost(null);
      setRelayPort(null);
      setRelayExposure(null);
      setRelayTouched(false);
    }
  };

  const [draft, setDraft] = createSignal<PairingDraft>(EMPTY);
  const [preset, setPreset] = createSignal<MeshPreset>("presence");
  const [touched, setTouched] = createSignal(false);
  const problem = () => pairingProblem(draft(), props.taken, status()?.fingerprint);
  const pair = async (e: Event) => {
    e.preventDefault();
    setTouched(true);
    if (problem()) return;
    const d = draft();
    const ok = await run(
      () =>
        addMeshLanPairing({
          id: d.id.trim(),
          ...(d.label.trim() ? { label: d.label.trim() } : {}),
          role: d.role,
          pin: d.fingerprint,
          ...(d.role === "dial" ? { host: d.host.trim(), port: Number(d.port), ...(d.internet ? { internet: true } : {}) } : {}),
          grant: preset(),
        }),
      `${d.label.trim() || d.id.trim()} paired.`,
    );
    if (ok) {
      setDraft(EMPTY);
      setPreset("presence");
      setTouched(false);
    }
  };

  return (
    <section class="card mesh-card" aria-labelledby="mesh-pairings-title">
      <div class="mesh-card-head">
        <h2 class="mesh-card-title" id="mesh-pairings-title">
          Dial-out pairings
        </h2>
      </div>
      <p class="settings-intro">
        For a host that isn't on your tailnet. The dial-out host connects to a relay, so nothing has to reach it. Each side's grant in Hosts decides what the other may see and do there.
      </p>
      <Show when={error()}>{(msg) => <Banner tone="error" title="Couldn't save the pairing." body={`Nothing changed on this host. ${msg()}`} />}</Show>

      <div class="mesh-pair-self">
        <span class="field-label">This host's fingerprint</span>
        <Show
          when={status()?.fingerprint}
          fallback={
            <div class="cluster">
              <span class="text-muted">None yet. It's made once, and the other host pins it.</span>
              <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} onClick={() => void run(createMeshLanKey, "Fingerprint made.")}>
                Make Fingerprint
              </button>
            </div>
          }
        >
          {(fp) => (
            <div class="cluster">
              <code class="mesh-pair-fingerprint">{fp()}</code>
              <CopyButton label="Copy Fingerprint" text={fp} onCopy={(t) => copyText(t, "Copied this host's fingerprint.")} />
            </div>
          )}
        </Show>
        <span class="field-hint">Paste it on the other host's Mesh page, then check it there by eye.</span>
      </div>

      <form class="mesh-add" onSubmit={saveRelay} aria-labelledby="mesh-relay-title" novalidate>
        <h3 class="mesh-add-title" id="mesh-relay-title">
          This host as a relay
        </h3>
        <p class="list-meta mesh-pair-wrap" aria-live="polite">
          {status() ? relayLine(status()!) : ""}
        </p>
        <Show when={status() && acceptorLine(status()!)}>{(line) => <p class="list-meta">{line()}</p>}</Show>
        <Show when={status()?.acceptor.mismatchAt}>
          {(at) => (
            <Banner
              tone="error"
              title="The accept process vouched for a host its connection didn't prove."
              body={`At ${new Date(at()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Sova refused that connection, so nothing got in. The accept process may be compromised: check this server before you trust it again.`}
            />
          )}
        </Show>
        <label class="field mesh-add-preset">
          <span class="field-label">Reached from</span>
          <span class="select-wrap">
            <select class="select" aria-describedby="mesh-relay-exposure-hint" onChange={(e) => setRelayExposure(e.currentTarget.value as RelayExposure)}>
              <option value="lan" selected={exposure() === "lan"}>
                A local network
              </option>
              <option value="internet" selected={exposure() === "internet"} disabled={!!internetBlocked() && status()?.relay?.exposure !== "internet"}>
                The internet
              </option>
            </select>
          </span>
          <span class="field-hint" id="mesh-relay-exposure-hint">
            <Show when={exposure() === "internet"} fallback={internetBlocked() ? `The internet isn't available: ${internetBlocked()}` : "The internet is available: this host's accept process is running."}>
              {RELAY_INTERNET_RISK}
            </Show>
          </span>
        </label>
        <div class="mesh-add-fields">
          <div class="field">
            <label class="field-label" for="mesh-relay-host">
              Address
            </label>
            <input
              id="mesh-relay-host"
              class="input input-mono"
              autocomplete="off"
              spellcheck={false}
              placeholder={exposure() === "internet" ? "203.0.113.10" : "10.0.0.2"}
              value={host()}
              onInput={(e) => setRelayHost(e.currentTarget.value)}
            />
            <span class="field-hint">
              {exposure() === "internet" ? "One address of this host: its public one, or its private one behind a one-to-one NAT." : "One local-network address of this host, never all of them."}
            </span>
          </div>
          <div class="field">
            <label class="field-label" for="mesh-relay-port">
              Port
            </label>
            <input
              id="mesh-relay-port"
              class="input input-mono"
              inputmode="numeric"
              autocomplete="off"
              placeholder={exposure() === "internet" ? "4803" : undefined}
              value={port()}
              onInput={(e) => setRelayPort(e.currentTarget.value)}
            />
          </div>
        </div>
        <Show when={portWarning(exposure(), port())}>{(msg) => <p class="mesh-host-warn">{msg()}</p>}</Show>
        <Show when={relayTouched() && relayProblem(host(), port(), exposure(), acceptorState())}>{(msg) => <p class="field-error">{msg()}</p>}</Show>
        <div class="cluster">
          <button type="submit" class="button" aria-disabled={busy() ? "true" : undefined}>
            Save Relay
          </button>
          <Show when={status()?.relay}>
            <button type="button" class="button button-ghost" aria-disabled={busy() ? "true" : undefined} onClick={() => void run(() => putMeshLanRelay(null), "This host is no longer a relay.")}>
              Stop Relaying
            </button>
          </Show>
        </div>
      </form>

      <Show when={(status()?.pairings.length ?? 0) > 0}>
        <ul class="list mesh-hosts" aria-label="Pairings">
          <For each={status()!.pairings}>
            {(p) => {
              const st = () => pairingState(p, props.now);
              return (
                <li class="list-row mesh-host mesh-pair-row">
                  <Icon name="network" small />
                  <div class="list-main">
                    <p class="list-title">
                      {p.label || p.id}
                      <Show when={p.label && p.label !== p.id}>
                        <span class="text-muted text-mono"> {p.id}</span>
                      </Show>
                    </p>
                    <p class="list-meta mesh-pair-wrap">
                      {roleWord(p)}
                      <Show when={p.role === "dial" && p.host}>
                        {" · "}
                        <span class="text-mono">
                          {p.host!.includes(":") ? `[${p.host}]` : p.host}:{p.port}
                        </span>
                        <Show when={p.internet}>{" · on the internet"}</Show>
                      </Show>
                    </p>
                    <p class="list-meta mesh-pair-wrap text-mono">{p.fingerprint}</p>
                    <Show when={st().detail}>{(d) => <p class={st().tone === "warn" ? "mesh-host-warn" : "list-meta"}>{d()}</p>}</Show>
                    <Show when={p.cloneSuspected}>
                      <p class="mesh-host-error">Its connections keep replacing each other: 2 machines may hold its key. Remove it and pair again if you don't know why.</p>
                    </Show>
                  </div>
                  <Chip tone={chipTone(st().tone)}>{st().word}</Chip>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    aria-label={`Remove pairing ${p.label || p.id}`}
                    aria-disabled={busy() ? "true" : undefined}
                    onClick={() => void run(() => removeMeshLanPairing(p.id), `${p.label || p.id} unpaired. Its connections ended.`)}
                  >
                    Remove
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <form class="mesh-add" onSubmit={pair} aria-labelledby="mesh-pair-title" novalidate>
        <h3 class="mesh-add-title" id="mesh-pair-title">
          Pair a Host
        </h3>
        <label class="field mesh-add-preset">
          <span class="field-label">The other host is</span>
          <span class="select-wrap">
            <select class="select" onChange={(e) => setDraft((d) => ({ ...d, role: e.currentTarget.value as PairingDraft["role"] }))}>
              <option value="dial" selected={draft().role === "dial"}>
                A relay this host dials
              </option>
              <option value="accept" selected={draft().role === "accept"}>
                A dial-out host that dials this one
              </option>
            </select>
          </span>
        </label>
        <Show when={draft().role === "accept" && !status()?.relay}>
          <p class="mesh-host-warn">Set this host's relay address above, or it has nowhere to dial in.</p>
        </Show>
        <div class="mesh-add-fields">
          <div class="field">
            <label class="field-label" for="mesh-pair-fp">
              Its fingerprint
            </label>
            <input
              id="mesh-pair-fp"
              class="input input-mono"
              autocomplete="off"
              spellcheck={false}
              placeholder="ABCD-EF01-…"
              value={draft().fingerprint}
              onInput={(e) => setDraft((d) => ({ ...d, fingerprint: e.currentTarget.value }))}
            />
          </div>
          <div class="field">
            <label class="field-label" for="mesh-pair-id">
              Name
            </label>
            <input id="mesh-pair-id" class="input input-mono" autocomplete="off" spellcheck={false} value={draft().id} onInput={(e) => setDraft((d) => ({ ...d, id: e.currentTarget.value }))} />
          </div>
          <div class="field">
            <label class="field-label" for="mesh-pair-label">
              Label <span class="text-muted">(optional)</span>
            </label>
            <input id="mesh-pair-label" class="input" autocomplete="off" value={draft().label} onInput={(e) => setDraft((d) => ({ ...d, label: e.currentTarget.value }))} />
          </div>
        </div>
        <Show when={draft().role === "dial"}>
          <div class="mesh-add-fields">
            <div class="field">
              <label class="field-label" for="mesh-pair-host">
                Relay address
              </label>
              <input id="mesh-pair-host" class="input input-mono" autocomplete="off" spellcheck={false} placeholder="relay.example" value={draft().host} onInput={(e) => setDraft((d) => ({ ...d, host: e.currentTarget.value }))} />
            </div>
            <div class="field">
              <label class="field-label" for="mesh-pair-port">
                Port
              </label>
              <input id="mesh-pair-port" class="input input-mono" inputmode="numeric" autocomplete="off" value={draft().port} onInput={(e) => setDraft((d) => ({ ...d, port: e.currentTarget.value }))} />
            </div>
          </div>
          <label class="toggle mesh-pair-internet">
            <input type="checkbox" checked={draft().internet} aria-describedby="mesh-pair-internet-hint" onChange={(e) => setDraft((d) => ({ ...d, internet: e.currentTarget.checked }))} />
            <span class="toggle-box" />
            <span>This relay is on the internet</span>
          </label>
          <span class="field-hint" id="mesh-pair-internet-hint">
            {draft().internet ? PAIR_INTERNET_RISK : "Leave it unchecked for a relay on your own network: this host then dials only local-network addresses."}
          </span>
        </Show>
        <label class="field mesh-add-preset">
          <span class="field-label">What it can see here</span>
          <span class="select-wrap">
            <select class="select" aria-describedby="mesh-pair-preset-hint" onChange={(e) => setPreset(e.currentTarget.value as MeshPreset)}>
              <For each={MESH_PRESETS}>
                {(p) => (
                  <option value={p} selected={preset() === p}>
                    {PRESET_LABEL[p]}
                  </option>
                )}
              </For>
            </select>
          </span>
          <span class="field-hint" id="mesh-pair-preset-hint">
            {PRESET_HINT[preset()]} You can change it any time in Hosts.
          </span>
        </label>
        <Show when={touched() && problem()}>{(msg) => <p class="field-error">{msg()}</p>}</Show>
        <div class="cluster">
          <button type="submit" class="button" aria-disabled={busy() ? "true" : undefined}>
            <Icon name="plus" />
            {busy() ? "Saving…" : "Pair Host"}
          </button>
        </div>
      </form>
    </section>
  );
}

const chipTone = (t: ReturnType<typeof pairingState>["tone"]) => (t === "neutral" ? undefined : t);
