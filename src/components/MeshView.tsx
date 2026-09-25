import { createSignal, For, Show } from "solid-js";
import { fetchMesh, fetchMeshCandidates, putMeshPeers } from "../lib/api";
import { relativeTime } from "../lib/format";
import {
  MESH_HREF,
  meshPeers,
  meshState,
  peerUnavailable,
  selfLabel,
  setMeshState,
  type MeshCandidate,
  type MeshPeerEntry,
  type PeerState,
  type PeerStatus,
  type SyncCategory,
  type SyncStatus,
} from "../lib/mesh";
import { createPoll } from "../lib/poll";
import { openSettings } from "../lib/settings-nav";
import { announce } from "../lib/ui-state";
import { iso, InsightsPage } from "./InsightsPage";
import { Banner, Chip, Icon } from "./ui";
import "../mesh.css";

/** While #/mesh is open the host list is re-read this often: status is what the page is for. */
const MESH_PAGE_POLL_MS = 5_000;

const STATE_WORD: Record<PeerState, string> = { up: "Up", down: "Down", skewed: "Other version", refused: "Refused" };
const STATE_TONE: Record<PeerState, "success" | "error" | "warn"> = { up: "success", down: "error", skewed: "warn", refused: "error" };

/** A peer's state in a word as well as a colour; the reason rides the title. */
export function PeerStateChip(props: { peer: PeerStatus }) {
  return (
    <Chip tone={STATE_TONE[props.peer.state]} title={peerUnavailable(props.peer) ?? undefined}>
      {STATE_WORD[props.peer.state]}
    </Chip>
  );
}

export const SYNC_LABEL: Record<SyncCategory, string> = {
  settings: "Settings",
  themes: "Themes",
  extensions: "Extensions",
  logins: "Logins",
};

/** The card's one-line summary of the peers: a count, and the first host that needs attention. */
function cardSummary(peers: PeerStatus[]): { chip: string; tone?: "success" | "warn"; line: string; problem: string | null } {
  if (peers.length === 0) {
    return { chip: "This host only", line: `Only ${selfLabel()} so far. Add a peer to see and start its sessions from here.`, problem: null };
  }
  const up = peers.filter((p) => p.state === "up").length;
  const first = peers.find((p) => p.state !== "up");
  return {
    chip: `${up} of ${peers.length} up`,
    tone: up === peers.length ? "success" : "warn",
    line: `${selfLabel()} and ${peers.length} ${peers.length === 1 ? "peer" : "peers"}: ${peers.map((p) => p.label || p.id).join(", ")}.`,
    problem: first ? peerUnavailable(first) : null,
  };
}

/**
 * The landing page's Mesh section, above Extensions and in the same card: the hosts this one
 * works with, and a link to #/mesh. Shown whether or not a peer is configured: it is also where
 * the first peer gets added. A server that can't say reads as no peers.
 *
 * `data-mesh-ui` marks the one root the mesh adds to this screen (the parity check removes it and
 * compares the rest with the mesh off); its gap is the page's flex gap, so it leaves with it.
 */
export function MeshCard() {
  const summary = () => cardSummary(meshPeers());
  return (
    <section class="explain-section" aria-labelledby="mesh-section-title" data-mesh-ui>
      <h2 class="explain-section-head" id="mesh-section-title">
        Mesh
      </h2>
      <ul class="ext-grid">
        <li>
          <a class="card ext-card" href={MESH_HREF}>
            <div class="ext-card-head">
              <span class="icon ext-card-icon" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
              <h3 class="ext-card-title">Hosts</h3>
              <Chip tone={summary().tone}>{summary().chip}</Chip>
            </div>
            <p class="ext-card-body">{summary().line}</p>
            <Show when={summary().problem}>{(problem) => <p class="ext-card-error">{problem()}</p>}</Show>
          </a>
        </li>
      </ul>
    </section>
  );
}

/** A peer being added from the form, before it is written. */
export interface Draft {
  id: string;
  label: string;
  /** MagicDNS name, short host name or tailnet IP. */
  name: string;
  /** The node's StableID when it came from Find Hosts; typed by hand, the server resolves it. */
  nodeId?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Why a draft can't be added, in words the field can show; null when it can. */
export function draftProblem(d: Draft, taken: readonly string[]): string | null {
  const id = d.id.trim();
  if (!d.name.trim()) return "Type the peer's tailnet name or address.";
  if (!id) return "Give it a short name.";
  if (!ID_RE.test(id)) return "Use up to 32 lowercase letters, digits and dashes for the name, starting with a letter or digit.";
  if (taken.includes(id)) return `A peer named ${id} is already in the list.`;
  return null;
}

/** A tailnet name's first label as a peer id: `alice.tail1.ts.net` → `alice`. */
export const idFromName = (name: string): string =>
  name.trim().toLowerCase().split(".")[0]!.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 32);

/** A peer as peers.json holds it: what a rewrite of the list must carry over unchanged. */
const entryOf = (p: PeerStatus): MeshPeerEntry => ({
  id: p.id,
  label: p.label || undefined,
  nodeId: p.nodeId,
  name: p.name,
  url: p.url,
  priority: p.priority,
});

const tagged = (c: MeshCandidate) => c.login === "tagged-devices" || c.tags.length > 0;
/** Find Hosts offers Use only for an untagged node that runs Sova; the note line says why not. */
const candidateUsable = (c: MeshCandidate) => !c.peerId && !tagged(c) && c.online && c.sova !== "no";

/** What Find Hosts says about a node after its name and address. */
function candidateNote(c: MeshCandidate): string {
  if (!c.online) return "offline";
  if (c.sova === "yes") return `Sova ${c.hello?.version ?? ""}`.trim();
  if (c.sova === "refused") return "runs Sova, doesn't list this host yet";
  return "no Sova answering";
}

/** `#/mesh`: every host, its state and why, editing peers.json, what syncs, and how to start. */
export function MeshView(props: { now: number; titleRef(el: HTMLHeadingElement): void }) {
  // Every answer is the app's mesh state too: the sidebar's marks and New Session follow this page.
  const poll = createPoll(
    () =>
      fetchMesh().then((s) => {
        setMeshState(s);
        return s;
      }),
    MESH_PAGE_POLL_MS,
  );
  const state = () => poll.data() ?? meshState();

  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  /** Write the whole list; the answer is the mesh as it now stands. */
  const writePeers = async (peers: MeshPeerEntry[], said: string): Promise<boolean> => {
    if (saving()) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await putMeshPeers(peers);
      setMeshState(next);
      poll.set(next);
      announce(said);
      return true;
    } catch (err) {
      setSaveError((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const removePeer = (p: PeerStatus) =>
    void writePeers(
      meshPeers().filter((x) => x.id !== p.id).map(entryOf),
      `${p.label || p.id} removed. Its sessions stay on it.`,
    );

  const [draft, setDraft] = createSignal<Draft>({ id: "", label: "", name: "" });
  const [draftTouched, setDraftTouched] = createSignal(false);
  const problem = () => draftProblem(draft(), meshPeers().map((p) => p.id));
  const addPeer = async (e?: Event) => {
    e?.preventDefault();
    setDraftTouched(true);
    if (problem()) return;
    const d = draft();
    const entry: MeshPeerEntry = { id: d.id.trim(), label: d.label.trim() || undefined, name: d.name.trim(), nodeId: d.nodeId };
    if (await writePeers([...meshPeers().map(entryOf), entry], `${entry.label ?? entry.id} added.`)) {
      setDraft({ id: "", label: "", name: "" });
      setDraftTouched(false);
    }
  };

  const [candidates, setCandidates] = createSignal<MeshCandidate[] | null>(null);
  const [finding, setFinding] = createSignal(false);
  const [findError, setFindError] = createSignal<string | null>(null);
  /** Only on the button: discovery asks Tailscale, which the page never does by itself. */
  const findHosts = async () => {
    if (finding()) return;
    setFinding(true);
    setFindError(null);
    try {
      setCandidates(await fetchMeshCandidates());
    } catch (err) {
      setFindError((err as Error).message);
    } finally {
      setFinding(false);
    }
  };
  const useCandidate = (c: MeshCandidate) => {
    const label = c.hello?.label || (c.hostName && c.hostName !== idFromName(c.name) ? c.hostName : "");
    setDraft({ id: idFromName(c.name), label, name: c.name, nodeId: c.nodeId });
    setDraftTouched(false);
    document.getElementById("mesh-add-name")?.focus();
  };
  const sova = () => (candidates() ?? []).filter((c) => c.sova !== "no").length;

  return (
    <InsightsPage
      title="Mesh"
      meta={
        <Show when={state()} fallback={<span>Not read yet</span>}>
          {(s) => (
            <span>
              Served by <strong>{s().self.label || s().self.hostname}</strong>
              <Show when={s().peers.length > 0} fallback=" · no peers yet">
                {" · "}
                {s().peers.filter((p) => p.state === "up").length} of {s().peers.length} peers up
              </Show>
            </span>
          )}
        </Show>
      }
      refreshLabel="Refresh Hosts"
      onRefresh={() => poll.refetch()}
      error={poll.error()}
      errorTitle="Couldn't read the mesh."
      busy={!state() && poll.pending()}
      titleRef={props.titleRef}
    >
      <Show when={state()?.error}>
        {(msg) => (
          <Banner
            tone="error"
            title="peers.json can't be used, so the mesh is off."
            body={`No peer is reached until it's fixed. Saving the list below rewrites it. ${msg()}`}
          />
        )}
      </Show>
      <Show when={saveError()}>
        {(msg) => <Banner tone="error" title="Couldn't save the peers." body={`The list on this host didn't change. ${msg()}`} />}
      </Show>

      <section class="card mesh-card" aria-labelledby="mesh-hosts-title">
        <h2 class="mesh-card-title" id="mesh-hosts-title">
          Hosts
        </h2>
        <ul class="list mesh-hosts">
          <li class="list-row mesh-host">
            <Icon name="terminal" small />
            <div class="list-main">
              <p class="list-title">{state()?.self.label || state()?.self.hostname || "This host"}</p>
              <Show when={state()?.self.dnsName ?? state()?.self.hostname}>{(n) => <p class="list-meta text-mono">{n()}</p>}</Show>
              <Show when={state()?.self.listen?.error}>
                {(e) => <p class="mesh-host-error">Peers can't reach this host yet: {e().replace(/[.\s]+$/, "")}.</p>}
              </Show>
            </div>
            <Chip>This host</Chip>
          </li>
          <For each={state()?.peers ?? []}>
            {(p) => (
              <li class="list-row mesh-host">
                <Icon name="terminal" small />
                <div class="list-main">
                  <p class="list-title">
                    {p.label || p.id}
                    <Show when={p.label && p.label !== p.id}>
                      <span class="text-muted text-mono"> {p.id}</span>
                    </Show>
                  </p>
                  <p class="list-meta">
                    <span class="text-mono">{p.name}</span>
                    <Show when={p.hello}>{(h) => <> · Sova {h().version}</>}</Show>
                    <Show when={p.state !== "up" && p.lastSeen}>
                      {(t) => <span title={iso(t())}> · last answered {relativeTime(iso(t()), props.now)}</span>}
                    </Show>
                    <Show when={p.state !== "up" && !p.lastSeen}> · hasn't answered yet</Show>
                  </p>
                  <Show when={peerUnavailable(p)}>{(why) => <p class="mesh-host-error">{why()}</p>}</Show>
                </div>
                <PeerStateChip peer={p} />
                <button
                  type="button"
                  class="button button-sm button-ghost"
                  aria-label={`Remove ${p.label || p.id}`}
                  aria-disabled={saving() ? "true" : undefined}
                  onClick={() => !saving() && removePeer(p)}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>

        <form class="mesh-add" onSubmit={addPeer} aria-labelledby="mesh-add-title" novalidate>
          <h3 class="mesh-add-title" id="mesh-add-title">
            Add a Peer
          </h3>
          <div class="mesh-add-fields">
            <div class="field">
              <label class="field-label" for="mesh-add-name">
                Tailnet name or address
              </label>
              <input
                id="mesh-add-name"
                class="input input-mono"
                autocomplete="off"
                spellcheck={false}
                placeholder="laptop.tail1234.ts.net"
                value={draft().name}
                onInput={(e) => {
                  const name = e.currentTarget.value;
                  // The id follows the name until the user types one of their own; a typed name
                  // is resolved by the server, so a node picked from Find Hosts no longer applies.
                  setDraft((d) => ({ ...d, name, nodeId: undefined, id: d.id && d.id !== idFromName(d.name) ? d.id : idFromName(name) }));
                }}
              />
            </div>
            <div class="field">
              <label class="field-label" for="mesh-add-id">
                Name
              </label>
              <input
                id="mesh-add-id"
                class="input input-mono"
                autocomplete="off"
                spellcheck={false}
                value={draft().id}
                aria-describedby="mesh-add-id-hint"
                onInput={(e) => setDraft((d) => ({ ...d, id: e.currentTarget.value }))}
              />
              <span class="field-hint" id="mesh-add-id-hint">
                Short and unique. Its sessions' links use it.
              </span>
            </div>
            <div class="field">
              <label class="field-label" for="mesh-add-label">
                Label <span class="text-muted">(optional)</span>
              </label>
              <input
                id="mesh-add-label"
                class="input"
                autocomplete="off"
                placeholder="Laptop"
                value={draft().label}
                onInput={(e) => setDraft((d) => ({ ...d, label: e.currentTarget.value }))}
              />
            </div>
          </div>
          <Show when={draftTouched() && problem()}>{(msg) => <p class="field-error">{msg()}</p>}</Show>
          <div class="cluster">
            <button type="submit" class="button button-primary" aria-disabled={saving() ? "true" : undefined}>
              <Icon name="plus" />
              {saving() ? "Saving…" : "Add Peer"}
            </button>
            <button type="button" class="button" aria-disabled={finding() ? "true" : undefined} onClick={() => void findHosts()}>
              <Icon name="search" />
              {finding() ? "Looking…" : "Find Hosts on Your Tailnet"}
            </button>
          </div>
        </form>

        <Show when={findError()}>
          {(msg) => <Banner tone="error" title="Couldn't list the tailnet's hosts." body={`Nothing was changed. ${msg()}`} />}
        </Show>
        <Show when={candidates()}>
          {(list) => (
            <div class="mesh-candidates">
              <p class="settings-intro" aria-live="polite">
                <Show when={list().length > 0} fallback="Your tailnet shows no other hosts.">
                  {sova()} of {list().length} hosts on your tailnet run Sova. Use fills the form; nothing is saved until you press Add Peer.
                </Show>
              </p>
              <ul class="list">
                <For each={list()}>
                  {(c) => (
                    <li class="list-row mesh-host">
                      <div class="list-main">
                        <p class="list-title">{c.hostName || c.name}</p>
                        <p class="list-meta">
                          <span class="text-mono">{c.name}</span>
                          {" · "}
                          {candidateNote(c)}
                        </p>
                        <Show when={!c.peerId && tagged(c)}>
                          <p class="list-meta">Tagged nodes aren't offered as peers. Type its name above to add it anyway.</p>
                        </Show>
                      </div>
                      <Show
                        when={!c.peerId}
                        fallback={<Chip tone="success">In the list</Chip>}
                      >
                        <Show when={candidateUsable(c)}>
                          <button type="button" class="button button-sm" aria-label={`Use ${c.hostName || c.name}`} onClick={() => useCandidate(c)}>
                            Use
                          </button>
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </Show>
      </section>

      <section class="card mesh-card" aria-labelledby="mesh-sync-title">
        <div class="mesh-card-head">
          <h2 class="mesh-card-title" id="mesh-sync-title">
            Sync
          </h2>
          <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("mesh")}>
            Change What Syncs
          </button>
        </div>
        <Show
          when={meshPeers().length > 0 && (state()?.sync.length ?? 0) > 0}
          fallback={
            <p class="settings-intro">
              <Show when={meshPeers().length > 0} fallback="Nothing syncs until there's a peer. Settings, themes, extensions and logins can then stay the same on every host.">
                Nothing has synced yet.
              </Show>
            </p>
          }
        >
          <ul class="list">
            <For each={state()?.sync ?? []}>{(row) => <SyncRow row={row} now={props.now} />}</For>
          </ul>
        </Show>
      </section>

      <details class="card mesh-card mesh-setup" open={meshPeers().length === 0}>
        <summary class="mesh-card-title">Setting up a first peer</summary>
        <ol class="mesh-steps">
          <li>
            Run Sova on the other machine, and put both machines on the same tailnet. Tailscale is the only gate: there's no Sova login.
          </li>
          <li>
            Add each machine to the other's peers: here with <strong>Add a Peer</strong>, and on the other one from its own Mesh page. A host
            answers only the peers in its own list.
          </li>
          <li>
            When it shows <strong>Up</strong>, its sessions join your session list, marked with its name, and New Session can start one on it.
            They stay on that machine: while it's off, they can't be opened.
          </li>
          <li>
            Want one address that keeps working while a host is down? Set the front door in <strong>Settings → Mesh</strong>.
          </li>
        </ol>
      </details>
    </InsightsPage>
  );
}

function SyncRow(props: { row: SyncStatus; now: number }) {
  const r = () => props.row;
  const chip = () => {
    const row = r();
    if (!row.enabled || row.state === "off") return <Chip>Off</Chip>;
    if (row.state === "error") return <Chip tone="error" title={row.error}>Failed</Chip>;
    if (row.state === "pending") return <Chip tone="info">Syncing</Chip>;
    return <Chip tone="success">In sync</Chip>;
  };
  return (
    <li class="list-row mesh-host">
      <div class="list-main">
        <p class="list-title">{SYNC_LABEL[r().category]}</p>
        <p class="list-meta">
          <Show when={r().enabled} fallback="Kept separate on each host.">
            <Show when={r().lastAt} fallback="Not synced yet.">
              {(t) => <span title={iso(t())}>Last synced {relativeTime(iso(t()), props.now)}</span>}
            </Show>
          </Show>
        </p>
        <Show when={r().state === "error" && r().error}>{(e) => <p class="mesh-host-error">{e()}</p>}</Show>
      </div>
      {chip()}
    </li>
  );
}
