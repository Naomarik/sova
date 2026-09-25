import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { ApiError, claimMeshLogin, fetchFrontDoor, fetchMesh, fetchMeshCandidates, fetchMeshLogins, getMeshSettings, putMeshPeers, putMeshSettings } from "../lib/api";
import { copyText } from "../lib/ui-state";
import { relativeTime } from "../lib/format";
import {
  claimable,
  claimRefusal,
  conflictLine,
  conflictSummary,
  frontDoorProblems,
  hostLabel,
  listWords,
  loginConflicts,
  loginName,
  MESH_HREF,
  meshOn,
  meshPeers,
  moveItem,
  frontDoorLeftOut,
  withExclusion,
  orderKeepingLeftOut,
  PLACEHOLDER_HOST,
  serveUrlProblem,
  meshState,
  peerUnavailable,
  selfLabel,
  setMeshState,
  type HelloChange,
  type MeshCandidate,
  type MeshLoginEntry,
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
import { Banner, Chip, CopyButton, Icon } from "./ui";
import { openMeshDetails, SYNC_LABEL } from "../lib/mesh-details";
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
  const [ticks, setTicks] = createSignal(0);
  /** Logins the list below shows waiting on a choice: the Logins row then says so in words. */
  const [loginConflictCount, setLoginConflictCount] = createSignal(0);
  const poll = createPoll(
    () =>
      fetchMesh().then((s) => {
        setMeshState(s);
        setTicks((n) => n + 1);
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
        <div class="mesh-card-head">
          <h2 class="mesh-card-title" id="mesh-hosts-title">
            Hosts
          </h2>
          <Show when={meshOn()}>
            <button type="button" class="button button-sm" onClick={openMeshDetails}>
              <Icon name="info" small />
              Mesh Details
            </button>
          </Show>
        </div>
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
            <For each={state()?.sync ?? []}>{(row) => <SyncRow row={row} now={props.now} conflicts={row.category === "logins" ? loginConflictCount() : 0} />}</For>
          </ul>
          <Show when={state()?.sync.find((r) => r.category === "logins" && r.enabled && r.state !== "off")}>
            <LoginList tick={ticks()} onConflicts={setLoginConflictCount} />
          </Show>
        </Show>
      </section>

      <FrontDoorSection frontDoor={state()?.frontDoor ?? null} />

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

function SyncRow(props: { row: SyncStatus; now: number; conflicts?: number }) {
  const r = () => props.row;
  /** Conflicts the login list below names: the choice is the user's, not a failure. */
  const waiting = () => (r().state === "error" ? props.conflicts ?? 0 : 0);
  const chip = () => {
    const row = r();
    if (!row.enabled || row.state === "off") return <Chip>Off</Chip>;
    if (waiting()) return <Chip tone="warn">Needs a choice</Chip>;
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
        <Show when={!waiting() && r().state === "error" && r().error}>{(e) => <p class="mesh-host-error">{e()}</p>}</Show>
        <Show when={waiting()}>
          {(n) => <p class="list-meta">{conflictSummary(n())}</p>}
        </Show>
      </div>
      {chip()}
    </li>
  );
}

const LOGIN_STATE: Record<MeshLoginEntry["state"], { word: string; tone?: "success" | "error" | "warn" }> = {
  live: { word: "Live", tone: "success" },
  expired: { word: "Expired", tone: "warn" },
  dead: { word: "Failed", tone: "error" },
  "logged-out": { word: "Logged out" },
};

/**
 * Each login this host syncs, one per key. A key that two hosts held differently before they
 * synced stays unsynced until the user keeps one host's: that host's then wins everywhere, so the
 * button asks first. Read only while the mesh is on and login sync is, re-read on each page poll.
 */
function LoginList(props: { tick: number; onConflicts(n: number): void }) {
  const [logins, { refetch }] = createResource(
    () => ({ tick: props.tick }),
    () => fetchMeshLogins().then((r) => r.entries).catch(() => null),
  );
  const [asking, setAsking] = createSignal<string | null>(null);
  const [claiming, setClaiming] = createSignal<string | null>(null);
  const [claimError, setClaimError] = createSignal<{ key: string; message: string } | null>(null);
  /** The ones waiting on a choice first. */
  const rows = () => {
    const all = logins.latest ?? [];
    const waiting = loginConflicts(all);
    return [...waiting, ...all.filter((e) => !waiting.includes(e))];
  };
  createEffect(() => props.onConflicts(loginConflicts(logins.latest ?? []).length));
  onCleanup(() => props.onConflicts(0));
  const noun = (e: MeshLoginEntry) => (e.kind === "api_key" ? "key" : "login");
  const hosts = (e: MeshLoginEntry) => listWords((e.conflictWith ?? []).map(hostLabel));

  const keep = async (e: MeshLoginEntry) => {
    setAsking(null);
    setClaiming(e.key);
    setClaimError(null);
    try {
      await claimMeshLogin(e.key);
      announce(`${selfLabel()}'s ${loginName(e)} now syncs to ${hosts(e)}.`);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setClaimError({ key: e.key, message: claimRefusal(e, status, (err as Error).message) });
    } finally {
      setClaiming(null);
      void refetch();
    }
  };

  return (
    <Show when={rows().length > 0}>
      <div class="mesh-logins">
        <h3 class="mesh-add-title">Logins on {selfLabel()}</h3>
        <ul class="list">
          <For each={rows()}>
            {(e) => (
              <li class="list-row mesh-host">
                <div class="list-main">
                  <p class="list-title">{loginName(e)}</p>
                  <Show
                    when={e.conflictWith?.length}
                    fallback={
                      <p class="list-meta">
                        <Show when={e.origin} fallback="Not synced yet.">
                          {(o) => (o() === meshState()?.self.id ? "Made on this host." : `From ${hostLabel(o())}.`)}
                        </Show>
                      </p>
                    }
                  >
                    <p class="list-meta">
                      {conflictLine(e, hostLabel)}
                    </p>
                    <Show when={asking() === e.key}>
                      <div class="mesh-login-ask">
                        <p class="list-meta">
                          {hosts(e)} {e.conflictWith!.length === 1 ? "replaces its" : "replace theirs"} with this host's {loginName(e)}. This host's stays as
                          it is.
                        </p>
                        <div class="mesh-login-ask-actions">
                          <button
                            type="button"
                            class="button button-sm button-primary"
                            ref={(el) => queueMicrotask(() => el.focus())}
                            onClick={() => void keep(e)}
                          >
                            Keep This Host's {noun(e) === "key" ? "Key" : "Login"}
                          </button>
                          <button type="button" class="button button-sm button-ghost" onClick={() => setAsking(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </Show>
                    <Show when={claimError()?.key === e.key && claimError()}>{(err) => <p class="mesh-host-error">{err().message}</p>}</Show>
                  </Show>
                </div>
                <Show
                  when={e.conflictWith?.length}
                  fallback={<Chip tone={LOGIN_STATE[e.state].tone}>{LOGIN_STATE[e.state].word}</Chip>}
                >
                  <Show when={asking() !== e.key}>
                    <button
                      type="button"
                      class="button button-sm"
                      disabled={claiming() === e.key || !claimable(e)}
                      title={claimable(e) ? undefined : `This host's ${noun(e)} is ${e.state === "dead" ? "failed" : "logged out"}.`}
                      onClick={() => setAsking(e.key)}
                    >
                      {claiming() === e.key ? "Keeping…" : `Keep This Host's ${noun(e) === "key" ? "Key" : "Login"}`}
                    </button>
                  </Show>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

/**
 * The stale-tab banner: the host answering this tab is not the one that loaded it, or serves a
 * different Sova. A different protocol can't be worked around, so it has no Dismiss; a newer build
 * or a new host is information, and the tab keeps working.
 */
export function StaleTabBanner(props: { change: HelloChange; onDismiss(): void }) {
  const c = () => props.change;
  const reload = (
    <button type="button" class="button button-sm button-primary" onClick={() => location.reload()}>
      Reload Tab
    </button>
  );
  return (
    <div class="stale-tab">
      <Show
        when={!c().protocol}
        fallback={
          <Banner
            tone="warn"
            title="This tab is older than the Sova answering it."
            body={`${c().host ? `The front door moved it to ${c().host!.to}, which` : "The host"} runs a different version, so this tab can't talk to it reliably. Reload to continue; your sessions are unchanged.`}
            action={reload}
          />
        }
      >
        <Banner
          tone="info"
          title={c().host ? `You're now on ${c().host!.to}.` : "A newer Sova is available."}
          body={
            <>
              <Show when={c().host}>
                {(h) => (
                  <>
                    The front door moved this tab from {h().from}. Every session still lives on the host that made it, and opens from
                    here while that host answers.{" "}
                  </>
                )}
              </Show>
              <Show when={c().build}>This host serves a newer build of this page. Reload when you're ready.</Show>
            </>
          }
          action={
            <span class="cluster">
              <Show when={c().build}>{reload}</Show>
              <button type="button" class="button button-sm button-ghost" onClick={() => props.onDismiss()}>
                Dismiss
              </button>
            </span>
          }
        />
      </Show>
    </div>
  );
}

/**
 * The front door: the order hosts take over in, and the Caddyfile that does it. Sova only
 * generates the file; Caddy runs wherever the user puts it. Each move is saved at once (the order
 * is a setting like any other), and the file below is re-read so it always matches the list.
 */
function FrontDoorSection(props: { frontDoor: string | null }) {
  const [config, { refetch, mutate }] = createResource(fetchFrontDoor);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const problems = () => frontDoorProblems(config.latest?.order ?? []);

  /** The host whose address is being edited, and the field's text. */
  const [editing, setEditing] = createSignal<{ id: string; value: string; touched: boolean } | null>(null);
  const [addressError, setAddressError] = createSignal<string | null>(null);
  const isSelf = (id: string) => id === meshState()?.self.id;
  /**
   * Save one host's browser-facing address: this host's through Settings, a peer's through its
   * peers.json entry (the other entries go back as they are; one written without a serve URL keeps
   * the one it has). This host's may be cleared, which returns it to its MagicDNS default.
   */
  const saveAddress = async () => {
    const e = editing();
    if (!e || saving()) return;
    const value = e.value.trim();
    const clearing = !value && isSelf(e.id);
    if (!clearing && serveUrlProblem(value)) return setEditing({ ...e, touched: true });
    setSaving(true);
    setAddressError(null);
    try {
      if (isSelf(e.id)) await putMeshSettings({ serveUrl: value || null });
      else {
        const next = await putMeshPeers(meshPeers().map((p) => (p.id === e.id ? { ...entryOf(p), serveUrl: value } : entryOf(p))));
        setMeshState(next);
      }
      setEditing(null);
      announce(clearing ? "This host's address is back to its tailnet name." : "Address saved. The Caddyfile below uses it.");
      await refetch();
    } catch (err) {
      setAddressError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const buttons = new Map<string, HTMLButtonElement>();

  // Leaving a host out (one with no browser-facing address, e.g. a phone). Only with the mesh on:
  // with this host alone there is nothing to leave out, and nothing new is read.
  const [settings, { mutate: setSettings }] = createResource(() => (meshOn() ? { on: true } : false), getMeshSettings);
  const leftOut = () => {
    const st = meshState();
    if (!st || !meshOn()) return [];
    const hosts = [{ id: st.self.id, label: st.self.label || st.self.hostname }, ...meshPeers().map((p) => ({ id: p.id, label: p.label }))];
    return frontDoorLeftOut(hosts, settings.latest?.frontDoorExclude, (config.latest?.order ?? []).map((h) => h.id));
  };
  const [includeError, setIncludeError] = createSignal<string | null>(null);
  /** Put a host in or leave it out; false when the server refused (the switch goes back). */
  const setIncluded = async (id: string, name: string, include: boolean): Promise<boolean> => {
    if (saving()) return false;
    setSaving(true);
    setIncludeError(null);
    try {
      setSettings(await putMeshSettings({ frontDoorExclude: withExclusion(settings.latest?.frontDoorExclude, id, !include) }));
      announce(include ? `${name} is back in the front door, last in the order.` : `${name} is left out of the front door.`);
      await refetch();
      return true;
    } catch (err) {
      setIncludeError((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const move = async (from: number, to: number) => {
    const c = config();
    if (!c || saving()) return;
    const before = c;
    const order = moveItem(c.order, from, to);
    const moved = order[to]!;
    mutate({ ...c, order });
    setSaving(true);
    setError(null);
    try {
      await putMeshSettings({ frontDoorOrder: orderKeepingLeftOut(order.map((h) => h.id), leftOut().map((h) => h.id)) });
      announce(`${moved.label || moved.id} is now number ${to + 1} of ${order.length}.`);
      await refetch();
    } catch (err) {
      mutate(before);
      setError((err as Error).message);
    } finally {
      setSaving(false);
      // The pressed button may be gone (the row moved to an end): keep focus on the row that moved.
      const key = `${moved.id}:${to > from ? "down" : "up"}`;
      const alt = `${moved.id}:${to > from ? "up" : "down"}`;
      const el = buttons.get(key);
      (el && el.getAttribute("aria-disabled") !== "true" ? el : buttons.get(alt))?.focus();
    }
  };

  return (
    <section class="card mesh-card" aria-labelledby="mesh-front-door-title">
      <h2 class="mesh-card-title" id="mesh-front-door-title">
        Front door
      </h2>
      <p class="settings-intro">
        One address for all your hosts: the first one in this order that answers serves you, and the next takes over when it stops.
        <Show when={props.frontDoor}>
          {(url) => (
            <>
              {" "}
              Yours is <span class="text-mono">{url()}</span>.
            </>
          )}
        </Show>
      </p>
      <Show when={config.error}>
        {(err) => <Banner tone="error" title="Couldn't read the front door." body={`Nothing was changed. ${(err() as Error).message}`} />}
      </Show>
      <Show when={error()}>
        {(msg) => <Banner tone="error" title="Couldn't save the order." body={`The previous order stands. ${msg()}`} />}
      </Show>
      <Show when={includeError()}>
        {(msg) => <Banner tone="error" title="Couldn't change which hosts are in." body={`Nothing changed. ${msg()}`} />}
      </Show>
      <Show when={problems().placeholders.length > 0}>
        <Banner
          tone="warn"
          title={`${problems().placeholders.length === 1 ? "1 host has" : `${problems().placeholders.length} hosts have`} no address yet.`}
          body="Its tailnet name isn't known, so the file has a placeholder there. Set its address below, or Caddy can't reach it."
        />
      </Show>
      <Show when={problems().mixedSchemes}>
        <Banner
          tone="warn"
          title="These addresses mix http and https."
          body="Caddy refuses a front door whose hosts differ in scheme. Give them all https (tailscale serve) or all http."
        />
      </Show>
      <Show when={config.latest}>
        {(c) => (
          <>
            <ol class="list mesh-order" aria-label="Failover order">
              <For each={c().order}>
                {(h, i) => {
                  const name = () => h.label || h.id;
                  const first = () => i() === 0;
                  const last = () => i() === c().order.length - 1;
                  /** The front door needs one host: the last one in can't be left out. */
                  const onlyIn = () => c().order.length === 1;
                  return (
                    <li class="list-row mesh-host">
                      <span class="mesh-order-n text-num" aria-hidden="true">
                        {i() + 1}
                      </span>
                      <div class="list-main">
                        <p class="list-title">{name()}</p>
                        <p class="list-meta text-mono">{h.upstream}</p>
                        <Show when={h.upstream.includes(PLACEHOLDER_HOST)}>
                          <p class="mesh-host-warn">Placeholder: set this host's address.</p>
                        </Show>
                        <Show when={onlyIn() && leftOut().length > 0}>
                          <p class="list-meta" id={`mesh-fd-only-${h.id}`}>
                            The only host in. The front door needs at least one.
                          </p>
                        </Show>
                        <Show when={editing()?.id === h.id}>
                          <form
                            class="mesh-address"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void saveAddress();
                            }}
                          >
                            <label class="visually-hidden" for={`mesh-address-${h.id}`}>
                              Address of {name()}
                            </label>
                            <input
                              id={`mesh-address-${h.id}`}
                              class="input input-mono"
                              autocomplete="off"
                              spellcheck={false}
                              placeholder={`https://${h.id}.tail1234.ts.net:8443`}
                              value={editing()!.value}
                              ref={(el) => queueMicrotask(() => el.focus())}
                              aria-describedby={`mesh-address-${h.id}-hint`}
                              onInput={(e) => setEditing({ id: h.id, value: e.currentTarget.value, touched: false })}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  setEditing(null);
                                }
                              }}
                            />
                            <span class="field-hint" id={`mesh-address-${h.id}-hint`}>
                              <Show
                                when={editing()!.touched && serveUrlProblem(editing()!.value.trim()) && !(isSelf(h.id) && !editing()!.value.trim())}
                                fallback={
                                  isSelf(h.id)
                                    ? "Where a browser opens this host. Empty goes back to its tailnet name on :8443."
                                    : "Where a browser opens this host, as the front door should reach it."
                                }
                              >
                                <span class="field-error">{serveUrlProblem(editing()!.value.trim())}</span>
                              </Show>
                            </span>
                            <Show when={addressError()}>{(msg) => <span class="field-error">Not saved: {msg()}</span>}</Show>
                            <span class="cluster">
                              <button type="submit" class="button button-sm button-primary" aria-disabled={saving() ? "true" : undefined}>
                                Save Address
                              </button>
                              <button type="button" class="button button-sm button-ghost" onClick={() => setEditing(null)}>
                                Cancel
                              </button>
                            </span>
                          </form>
                        </Show>
                      </div>
                      <Show when={editing()?.id !== h.id}>
                        <button
                          type="button"
                          class="button button-sm button-ghost"
                          aria-label={`Change Address of ${name()}`}
                          onClick={() => {
                            setAddressError(null);
                            setEditing({ id: h.id, value: h.upstream.includes(PLACEHOLDER_HOST) ? "" : h.upstream, touched: false });
                          }}
                        >
                          Change Address
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="button button-icon button-ghost"
                        aria-label={`Move ${name()} Up`}
                        title="Move Up"
                        aria-disabled={first() || saving() ? "true" : undefined}
                        ref={(el) => buttons.set(`${h.id}:up`, el)}
                        onClick={() => !first() && void move(i(), i() - 1)}
                      >
                        <Icon name="chevron-down" class="mesh-icon-up" />
                      </button>
                      <button
                        type="button"
                        class="button button-icon button-ghost"
                        aria-label={`Move ${name()} Down`}
                        title="Move Down"
                        aria-disabled={last() || saving() ? "true" : undefined}
                        ref={(el) => buttons.set(`${h.id}:down`, el)}
                        onClick={() => !last() && void move(i(), i() + 1)}
                      >
                        <Icon name="chevron-down" />
                      </button>
                      <Show when={meshOn()}>
                        <label class="toggle toggle-switch mesh-fd-in">
                          <input
                            type="checkbox"
                            checked
                            disabled={saving() || onlyIn()}
                            aria-label={`${name()} in the Front Door`}
                            aria-describedby={onlyIn() && leftOut().length > 0 ? `mesh-fd-only-${h.id}` : undefined}
                            onChange={(e) => {
                              const el = e.currentTarget;
                              void setIncluded(h.id, name(), false).then((ok) => ok || (el.checked = true));
                            }}
                          />
                          <span class="mesh-fd-in-word" aria-hidden="true">
                            In
                          </span>
                          <span class="toggle-box" />
                        </label>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ol>
            <Show when={leftOut().length > 0}>
              <ul class="list mesh-order" aria-label="Left out of the front door">
                <For each={leftOut()}>
                  {(h) => {
                    const name = () => h.label || h.id;
                    return (
                      <li class="list-row mesh-host mesh-host-out">
                        <span class="mesh-order-n text-num" aria-hidden="true">
                          –
                        </span>
                        <div class="list-main">
                          <p class="list-title">{name()}</p>
                          <p class="list-meta">Left out. The front door never sends you here.</p>
                        </div>
                        <label class="toggle toggle-switch mesh-fd-in">
                          <input
                            type="checkbox"
                            checked={false}
                            disabled={saving()}
                            aria-label={`${name()} in the Front Door`}
                            onChange={(e) => {
                              const el = e.currentTarget;
                              void setIncluded(h.id, name(), true).then((ok) => ok || (el.checked = false));
                            }}
                          />
                          <span class="mesh-fd-in-word" aria-hidden="true">
                            In
                          </span>
                          <span class="toggle-box" />
                        </label>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
            <div class="mesh-code-head">
              <h3 class="mesh-add-title">Caddyfile</h3>
              <CopyButton label="Copy Caddyfile" text={() => c().caddyfile} onCopy={(t) => copyText(t, "Copied the Caddyfile.")} />
            </div>
            <pre class="mesh-code" aria-label="Caddyfile" tabindex="0">
              <code>{c().caddyfile}</code>
            </pre>
            <p class="settings-intro">
              Run Caddy with this file on a machine that stays up and can reach every host over the tailnet (a small server, or this one).
            </p>
            <p class="settings-intro">
              Then put the address it serves in{" "}
              <button type="button" class="mesh-link" onClick={() => openSettings("mesh")}>
                Settings → Mesh → Front door
              </button>
              , so the hosts know it.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
