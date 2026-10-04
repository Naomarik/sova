import { createSignal, For, Show } from "solid-js";
import { putMeshAccess } from "../lib/api";
import {
  CAP_COPY,
  grantOf,
  grantSummary,
  loginOn,
  MESH_CAPS,
  MESH_PRESETS,
  PRESET_HINT,
  PRESET_LABEL,
  SYNC_CAPS,
  theirLine,
  transitLine,
  withCap,
  withLogin,
  withPreset,
  type MeshAccessPeer,
  type MeshAccessView,
  type MeshCap,
  type MeshGrant,
  type MeshPreset,
} from "../lib/mesh-access";
import { announce } from "../lib/ui-state";

// "What <peer> can see here" (§mesh.peers/grants): one peer's grant on this host, under its row on
// #/mesh. Every change is written at once (a switch takes effect when flipped), and the answer is the
// whole view as it now stands.

export function PeerAccess(props: {
  peer: MeshAccessPeer;
  /** Every other peer's label: who can still pass a synced category on. */
  others: string[];
  logins: MeshAccessView["logins"];
  /** The file can't be read: nothing here can be changed until it's fixed. */
  locked: boolean;
  onSaved(view: MeshAccessView): void;
}) {
  const name = () => props.peer.label || props.peer.id;
  const grant = (): MeshGrant => grantOf(props.peer.grant);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const save = async (next: MeshGrant, said: string) => {
    if (busy() || props.locked) return;
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await putMeshAccess({ peer: props.peer.id, grant: next }));
      announce(said);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const on = (c: MeshCap) => props.peer.effective[c];
  const sessionsOn = () => on("sessions");
  const allKeys = () => props.logins.map((l) => l.key);

  return (
    <details class="mesh-access">
      <summary class="mesh-access-summary">
        <span class="mesh-access-title">What {name()} can see here</span>
        <span class="mesh-access-value">{props.locked ? "Hello only" : grantSummary(grant())}</span>
      </summary>
      <div class="mesh-access-body">
        <label class="field mesh-access-preset">
          <span class="field-label">Preset</span>
          <span class="select-wrap">
            <select
              class="select"
              aria-describedby={`mesh-access-hint-${props.peer.id}`}
              disabled={busy() || props.locked}
              onChange={(e) => {
                const preset = e.currentTarget.value as MeshPreset;
                void save(withPreset(grant(), preset), `${name()} now has ${PRESET_LABEL[preset].toLowerCase()} here.`);
              }}
            >
              <For each={MESH_PRESETS}>
                {(p) => (
                  <option value={p} selected={grant().preset === p}>
                    {PRESET_LABEL[p]}
                  </option>
                )}
              </For>
            </select>
          </span>
          <span class="field-hint" id={`mesh-access-hint-${props.peer.id}`}>
            {PRESET_HINT[grant().preset]}
          </span>
        </label>

        <Show when={sessionsOn()}>
          <p class="mesh-access-note">Sessions run commands on this machine, so {name()} can reach everything else too. The switches below hold back only what sessions doesn't.</p>
        </Show>

        <ul class="mesh-sync-list mesh-access-caps" aria-label={`What ${name()} can do here`}>
          <For each={MESH_CAPS}>
            {(c) => (
              <li>
                <label class="toggle toggle-switch mesh-sync-row">
                  <input
                    type="checkbox"
                    checked={on(c)}
                    disabled={busy() || props.locked}
                    onChange={(e) => {
                      const v = e.currentTarget.checked;
                      void save(withCap(grant(), c, v), `${CAP_COPY[c].label} ${v ? "on" : "off"} for ${name()}.`);
                    }}
                  />
                  <span class="mesh-sync-main">
                    <span class="mesh-sync-name">{CAP_COPY[c].label}</span>
                    <span class="mesh-sync-meta">{CAP_COPY[c].means}</span>
                    {/* Sync replicates host to host: this host's "off" limits only its own exchange. */}
                    <Show when={SYNC_CAPS.includes(c) && !on(c) && props.others.length > 0}>
                      <span class="mesh-sync-meta mesh-access-transit">{transitLine(props.others, name())}</span>
                    </Show>
                  </span>
                  <span class="toggle-box" />
                </label>
                <Show when={c === "sync.logins" && on("sync.logins") && props.logins.length > 0}>
                  <ul class="mesh-sync-list mesh-access-logins" aria-label={`Logins that go to ${name()}`}>
                    <For each={props.logins}>
                      {(l) => (
                        <li>
                          <label class="toggle toggle-switch mesh-sync-row mesh-sync-sub">
                            <input
                              type="checkbox"
                              checked={loginOn(grant(), l.key)}
                              disabled={busy() || props.locked}
                              onChange={(e) => {
                                const v = e.currentTarget.checked;
                                void save(withLogin(grant(), l.key, v, allKeys()), `${l.provider} ${v ? "now goes" : "no longer goes"} to ${name()}.`);
                              }}
                            />
                            <span class="mesh-sync-main">
                              <span class="mesh-sync-name text-mono">{l.provider}</span>
                              <span class="mesh-sync-meta">{l.kind === "api_key" ? "API key" : l.kind === "oauth" ? "Sign-in" : "Login"}</span>
                            </span>
                            <span class="toggle-box" />
                          </label>
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="mesh-access-note">
                    Turning a login off stops sending it from now on. A copy {name()} already has stays there: log that login out there, or rotate it.
                    <Show when={!grant().logins}> Logins you add later go too, until you turn one off.</Show>
                  </p>
                </Show>
              </li>
            )}
          </For>
        </ul>

        <p class="mesh-access-theirs">
          <span class="mesh-sync-name">What this host can see on {name()}</span>
          <span class="mesh-sync-meta">{theirLine(name(), props.peer.theirs)} {name()} decides that on its own Mesh page.</span>
        </p>
        <Show when={error()}>{(msg) => <p class="mesh-host-error">Couldn't save. Nothing changed. {msg()}</p>}</Show>
      </div>
    </details>
  );
}
