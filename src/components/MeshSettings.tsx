import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { fetchMesh, getMeshSettings, putMeshSettings } from "../lib/api";
import { meshOn, setMeshState, SYNC_CATEGORIES, type SyncCategory } from "../lib/mesh";
import {
  acceptMeshSave,
  discardMeshDraft,
  meshChanges,
  meshDirty,
  meshDraft as draft,
  meshDraftIssue,
  meshSaved,
  setMeshDraft,
  setMeshSaved,
  type MeshDraft,
} from "../lib/mesh-draft";
import { announce } from "../lib/ui-state";
import { SYNC_LABEL } from "../lib/mesh-details";
import { SaveBar } from "./SaveBar";
import { Banner } from "./ui";
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
 * door's address. Every field and switch is staged and written by Save Changes, which sends only
 * what changed; a failed save keeps the edits and says so.
 */
export function MeshSettingsSection() {
  const [stored, { mutate }] = createResource(getMeshSettings);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
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
    setError(null);
    setMeshDraft({ ...d, ...patch });
  };
  const issue = () => {
    const d = draft();
    return d ? meshDraftIssue(d) : null;
  };
  const canSave = () => !saving() && meshDirty() && issue() === null;

  const save = async () => {
    const d = draft();
    const s = meshSaved();
    if (!d || !s || !canSave()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await putMeshSettings(meshChanges(d, s));
      mutate(next);
      acceptMeshSave(next);
      announce("Mesh settings saved.");
      // The name shows on the card, in New Session and on the Mesh page: they read the mesh state.
      void fetchMesh().then(setMeshState, () => {});
    } catch (err) {
      setError((err as Error).message.replace(/\.$/, ""));
    } finally {
      setSaving(false);
    }
  };
  /** Enter in a field saves, like a form's submit. */
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    }
  };
  /** "api-keys": this host neither takes nor offers subscription sign-ins; only API keys move. */
  const subscriptionsOn = () => draft()?.loginKinds !== "api-keys";

  return (
    <div class="stack mesh-settings">
      <p class="settings-intro">How this host appears to its peers, and what it keeps the same as them. Peers themselves are added on the Mesh page.</p>
      <Show when={stored.error}>
        {(err) => <Banner tone="error" title="Couldn't read the mesh settings." body={`Nothing was changed. ${(err() as Error).message}`} />}
      </Show>
      <div class="field settings-field">
        <label class="field-label" for="mesh-host-label">
          This host's name
        </label>
        <input
          id="mesh-host-label"
          class="input"
          autocomplete="off"
          value={draft()?.hostLabel ?? ""}
          disabled={!draft() || saving()}
          aria-invalid={issue() ? "true" : undefined}
          aria-describedby="mesh-host-label-hint"
          onInput={(e) => edit({ hostLabel: e.currentTarget.value })}
          onKeyDown={onEnter}
        />
        <span class={issue() ? "field-error" : "field-hint"} id="mesh-host-label-hint">
          {issue() ?? "Shown beside its sessions on every host, and in New Session's Host field."}
        </span>
      </div>

      <fieldset class="mesh-settings-sync">
        <legend class="field-label">Keep in sync with peers</legend>
        <ul class="mesh-sync-list">
          <For each={SYNC_CATEGORIES}>
            {(c) => (
              <li>
                <label class="toggle toggle-switch mesh-sync-row">
                  <input
                    type="checkbox"
                    checked={!!draft()?.sync[c]}
                    disabled={!draft() || saving()}
                    onChange={(e) => edit({ sync: { ...draft()!.sync, [c]: e.currentTarget.checked } })}
                  />
                  <span class="mesh-sync-main">
                    <span class="mesh-sync-name">{SYNC_LABEL[c]}</span>
                    <span class="mesh-sync-meta">{SYNC_META[c]}</span>
                  </span>
                  <span class="toggle-box" />
                </label>
                {/* Only with a peer to sync with, and login sync on: nothing new while the mesh is off. */}
                <Show when={c === "logins" && meshOn() && draft()?.sync.logins}>
                  <label class="toggle toggle-switch mesh-sync-row mesh-sync-sub">
                    <input
                      type="checkbox"
                      checked={subscriptionsOn()}
                      disabled={!draft() || saving() || !!loaded()?.loginKindsPinned}
                      onChange={(e) => edit({ loginKinds: e.currentTarget.checked ? "all" : "api-keys" })}
                    />
                    <span class="mesh-sync-main">
                      <span class="mesh-sync-name">Sync subscriptions to this host</span>
                      <span class="mesh-sync-meta">
                        <Show
                          when={!loaded()?.loginKindsPinned}
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
          value={draft()?.frontDoor ?? ""}
          disabled={!draft() || saving()}
          aria-describedby="mesh-front-door-hint"
          onInput={(e) => edit({ frontDoor: e.currentTarget.value })}
          onKeyDown={onEnter}
        />
        <span class="field-hint" id="mesh-front-door-hint">
          One address that reaches whichever host is up. Leave it empty if you open each host by its own address.
        </span>
      </div>

      <Show when={draft()}>
        <Show when={error()}>
          {(msg) => <Banner tone="error" title="Couldn't save the mesh settings." body={`${sentence(msg())} Your saved settings are unchanged.`} />}
        </Show>
        <SaveBar
          dirty={meshDirty()}
          saving={saving()}
          canSave={issue() === null}
          onSave={() => void save()}
          onDiscard={() => {
            discardMeshDraft();
            setError(null);
          }}
        />
      </Show>
    </div>
  );
}
