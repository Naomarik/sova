import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { fetchMesh, getMeshSettings, putMeshSettings } from "../lib/api";
import { meshOn, setMeshState, SYNC_CATEGORIES, type MeshSettings, type SyncCategory } from "../lib/mesh";
import { announce } from "../lib/ui-state";
import { SYNC_LABEL } from "../lib/mesh-details";
import { Banner } from "./ui";

/** What each category carries between hosts, as the switch's second line. */
const SYNC_META: Record<SyncCategory, string> = {
  settings: "Sova's settings, the model policy and mode defaults.",
  themes: "The themes in your themes folder. Which one this browser wears stays its own.",
  extensions: "Installed extensions and their manifest.",
  logins: "Provider sign-ins and API keys in pi's auth.json, and Claude Code's login. Tailscale and SSH keys never leave their machine.",
};

/**
 * Settings → Mesh: what this host is called, what it keeps in step with its peers, and the front
 * door's address. Every change is written the moment it is made (a switch at once, a field when
 * you leave it or press Enter), like the rest of Settings; a failed write puts the old value back
 * and says so.
 */
export function MeshSettingsSection() {
  const [stored, { mutate }] = createResource(getMeshSettings);
  const [label, setLabel] = createSignal("");
  const [frontDoor, setFrontDoor] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  createEffect(() => {
    const s = stored();
    if (!s) return;
    setLabel(s.hostLabel);
    setFrontDoor(s.frontDoor ?? "");
  });

  const save = async (next: MeshSettings, said: string) => {
    const before = stored();
    if (!before) return;
    mutate(next);
    setSaving(true);
    setError(null);
    try {
      mutate(await putMeshSettings(next));
      announce(said);
      // The name shows on the card, in New Session and on the Mesh page: they read the mesh state.
      void fetchMesh().then(setMeshState, () => {});
    } catch (err) {
      mutate(before);
      setLabel(before.hostLabel);
      setFrontDoor(before.frontDoor ?? "");
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const commitLabel = () => {
    const s = stored();
    const v = label().trim();
    if (!s || v === s.hostLabel) return;
    if (!v) {
      setLabel(s.hostLabel);
      return;
    }
    void save({ ...s, hostLabel: v }, `This host is now called ${v}.`);
  };
  const commitFrontDoor = () => {
    const s = stored();
    const v = frontDoor().trim();
    if (!s || v === (s.frontDoor ?? "")) return;
    void save({ ...s, frontDoor: v || null }, v ? "Front door saved." : "Front door cleared.");
  };
  const toggle = (c: SyncCategory) => {
    const s = stored();
    if (!s) return;
    const on = !s.sync[c];
    void save({ ...s, sync: { ...s.sync, [c]: on } }, `${SYNC_LABEL[c]} ${on ? "sync" : "no longer sync"} with your peers.`);
  };
  /** "api-keys": this host neither takes nor offers subscription sign-ins; only API keys move. */
  const subscriptionsOn = () => stored()?.loginKinds !== "api-keys";
  const toggleSubscriptions = () => {
    const s = stored();
    if (!s) return;
    const on = !subscriptionsOn();
    void save(
      { ...s, loginKinds: on ? "all" : "api-keys" },
      on ? "Subscription sign-ins sync with this host again." : "Only API keys sync with this host now.",
    );
  };
  const onEnter = (e: KeyboardEvent, commit: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div class="stack mesh-settings">
      <p class="settings-intro">How this host appears to its peers, and what it keeps the same as them. Peers themselves are added on the Mesh page.</p>
      <Show when={stored.error}>
        {(err) => <Banner tone="error" title="Couldn't read the mesh settings." body={`Nothing was changed. ${(err() as Error).message}`} />}
      </Show>
      <Show when={error()}>
        {(msg) => <Banner tone="error" title="Couldn't save the change" body={`The setting on this host didn't update, so the previous value stands. ${msg()}`} />}
      </Show>
      <div class="field settings-field">
        <label class="field-label" for="mesh-host-label">
          This host's name
        </label>
        <input
          id="mesh-host-label"
          class="input"
          autocomplete="off"
          value={label()}
          disabled={!stored()}
          aria-describedby="mesh-host-label-hint"
          onInput={(e) => setLabel(e.currentTarget.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => onEnter(e, commitLabel)}
        />
        <span class="field-hint" id="mesh-host-label-hint">
          Shown beside its sessions on every host, and in New Session's Host field.
        </span>
      </div>

      <fieldset class="mesh-settings-sync">
        <legend class="field-label">Keep in sync with peers</legend>
        <ul class="mesh-sync-list">
          <For each={SYNC_CATEGORIES}>
            {(c) => (
              <li>
                <label class="toggle toggle-switch mesh-sync-row">
                  <input type="checkbox" checked={!!stored()?.sync[c]} disabled={!stored() || saving()} onChange={() => toggle(c)} />
                  <span class="mesh-sync-main">
                    <span class="mesh-sync-name">{SYNC_LABEL[c]}</span>
                    <span class="mesh-sync-meta">{SYNC_META[c]}</span>
                  </span>
                  <span class="toggle-box" />
                </label>
                {/* Only with a peer to sync with, and login sync on: nothing new while the mesh is off. */}
                <Show when={c === "logins" && meshOn() && stored()?.sync.logins}>
                  <label class="toggle toggle-switch mesh-sync-row mesh-sync-sub">
                    <input
                      type="checkbox"
                      checked={subscriptionsOn()}
                      disabled={!stored() || saving() || !!stored()?.loginKindsPinned}
                      onChange={toggleSubscriptions}
                    />
                    <span class="mesh-sync-main">
                      <span class="mesh-sync-name">Sync subscriptions to this host</span>
                      <span class="mesh-sync-meta">
                        <Show
                          when={!stored()?.loginKindsPinned}
                          fallback="Set by SOVA_SYNC_LOGIN_KINDS on this host."
                        >
                          <Show
                            when={subscriptionsOn()}
                            fallback="Only API keys come and go. Sign-ins already here stay, but nothing refreshes or shares them, so a copy from another host can go stale."
                          >
                            Sign-ins like Claude Code and ChatGPT move with the API keys.
                          </Show>
                        </Show>
                      </span>
                    </span>
                    <span class="toggle-box" />
                  </label>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </fieldset>

      <div class="field settings-field">
        <label class="field-label" for="mesh-front-door">
          Front door
        </label>
        <input
          id="mesh-front-door"
          class="input input-mono"
          autocomplete="off"
          spellcheck={false}
          placeholder="https://sova.tail1234.ts.net"
          value={frontDoor()}
          disabled={!stored()}
          aria-describedby="mesh-front-door-hint"
          onInput={(e) => setFrontDoor(e.currentTarget.value)}
          onBlur={commitFrontDoor}
          onKeyDown={(e) => onEnter(e, commitFrontDoor)}
        />
        <span class="field-hint" id="mesh-front-door-hint">
          One address that reaches whichever host is up. Leave it empty if you open each host by its own address.
        </span>
      </div>
    </div>
  );
}
