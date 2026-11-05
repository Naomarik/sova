import { createEffect, createResource, For, Show } from "solid-js";
import { getMeshSettings } from "../lib/api";
import { meshOn, SYNC_CATEGORIES, type SyncCategory } from "../lib/mesh";
import { meshDraft as draft, meshSaveError, meshSaving as saving, setMeshDraft, setMeshSaved, type MeshDraft } from "../lib/mesh-draft";
import { SYNC_LABEL } from "../lib/mesh-details";
import { Banner } from "./ui";
import { TextField, Toggle } from "./form";
import { FRONT_DOOR_RULE, HOST_LABEL_RULE } from "../../shared/mesh-limits";
import { sentence } from "./WorkerSlotRow";
/** What each category carries between hosts, as the switch's second line. */
const SYNC_META: Record<SyncCategory, string> = {
  settings: "Sova's settings, the model policy and mode defaults.",
  themes: "The themes in your themes folder. Which one this browser wears stays its own.",
  extensions: "Installed extensions and their manifest.",
  logins: "Provider sign-ins and API keys in pi's auth.json, and Claude Code's login. Tailscale and SSH keys never leave their machine.",
};

/**
 * Settings → Mesh: what this host is called, what it keeps in step with its peers, and the front
 * door's address. Every field and switch is staged and written by the dialog's Save Changes
 * (mesh-draft.ts), which sends only what changed; a failed save keeps the edits and says so.
 * Enter in a field does nothing: the footer's Save writes every tab's edits, and a key press in
 * one field shouldn't.
 */
export function MeshSettingsSection() {
  const [stored] = createResource(getMeshSettings);
  /** The settings once loaded. A resource in its error state throws when read, so this never reads it then. */
  const loaded = () => (stored.error ? undefined : stored());
  // setMeshSaved is untracked (settings-draft.ts), so this tracks the loaded settings only.
  createEffect(() => {
    const s = loaded();
    if (s) setMeshSaved(s);
  });

  const edit = (patch: Partial<MeshDraft>) => {
    const d = draft();
    if (!d) return;
    setMeshDraft({ ...d, ...patch });
  };
  /** "api-keys": this host neither takes nor offers subscription sign-ins; only API keys move. */
  const subscriptionsOn = () => draft()?.loginKinds !== "api-keys";

  return (
    <div class="stack mesh-settings">
      <p class="settings-intro">How this host appears to its peers, and what it keeps the same as them. Peers themselves are added on the Mesh page.</p>
      <Show when={stored.error}>
        {(err) => <Banner tone="error" title="Couldn't read the mesh settings." body={`Nothing was changed. ${(err() as Error).message}`} />}
      </Show>
      <TextField
        class="settings-field"
        id="mesh-host-label"
        label="This host's name"
        hint="Shown beside its sessions on every host, and in New Session's Host field."
        rule={draft() ? HOST_LABEL_RULE : undefined}
        autocomplete="off"
        value={draft()?.hostLabel ?? ""}
        disabled={!draft() || saving()}
        onInput={(raw) => edit({ hostLabel: raw })}
      />

      <fieldset class="mesh-settings-sync">
        <legend class="field-label">Keep in sync with peers</legend>
        <ul class="mesh-sync-list">
          <For each={SYNC_CATEGORIES}>
            {(c) => (
              <li>
                <Toggle
                  switch
                  class="mesh-sync-row"
                  label={<span class="mesh-sync-main"><span class="mesh-sync-name">{SYNC_LABEL[c]}</span><span class="mesh-sync-meta">{SYNC_META[c]}</span></span>}
                  checked={!!draft()?.sync[c]}
                  disabled={!draft() || saving()}
                  onChange={(v) => edit({ sync: { ...draft()!.sync, [c]: v } })}
                />
                {/* Only with a peer to sync with, and login sync on: nothing new while the mesh is off. */}
                <Show when={c === "logins" && meshOn() && draft()?.sync.logins}>
                  <Toggle
                    switch
                    class="mesh-sync-row mesh-sync-sub"
                    label={
                      <span class="mesh-sync-main">
                        <span class="mesh-sync-name">Sync subscriptions to this host</span>
                        <span class="mesh-sync-meta">
                          {loaded()?.loginKindsPinned
                            ? "Set by SOVA_SYNC_LOGIN_KINDS on this host."
                            : subscriptionsOn()
                              ? "Sign-ins like Claude Code and ChatGPT move with the API keys."
                              : "Only API keys come and go. Sign-ins already here stay, but nothing refreshes or shares them, so a copy from another host can go stale."}
                        </span>
                      </span>
                    }
                    checked={subscriptionsOn()}
                    disabled={!draft() || saving() || !!loaded()?.loginKindsPinned}
                    onChange={(v) => edit({ loginKinds: v ? "all" : "api-keys" })}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </fieldset>

      <TextField
        class="settings-field"
        inputClass="input-mono"
        id="mesh-front-door"
        label="Front door"
        hint="One address that reaches whichever host is up. Leave it empty if you open each host by its own address."
        rule={FRONT_DOOR_RULE}
        autocomplete="off"
        spellcheck={false}
        placeholder="https://sova.tail1234.ts.net"
        value={draft()?.frontDoor ?? ""}
        disabled={!draft() || saving()}
        onInput={(raw) => edit({ frontDoor: raw })}
      />

      <Show when={meshSaveError()}>
        {(e) => <Banner tone="error" title="Couldn't save the mesh settings." body={`${sentence(e().message)} Your saved settings are unchanged.`} />}
      </Show>
    </div>
  );
}
