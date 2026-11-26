import { createResource, createSignal, Show } from "solid-js";
import type { StorageWebSettings } from "../../shared/protocol";
import { getWebSettings, putWebSettings } from "../lib/api";
import { toast } from "../lib/ui-state";
import { ChatsFolderRow } from "./ChatsFolderSetting";
import { Toggle } from "./form";

/** What an older server, or a settings answer without `storage`, reads as: both on. */
const STORAGE_DEFAULTS: StorageWebSettings = { chatHomes: true, autoCompress: true };

/**
 * Settings → General's **Chats · this computer**: the folder chats are kept in and its move (ChatsFolderSetting.tsx,
 * §app.chat-homes/move-folder), where new chats are kept (§app.chat-homes/new-chats) and whether
 * old archived chats are compressed (§app.session-list/archive-compression). Both on by default; saved at once.
 * Off, Chat homes makes new chats as before; chats that already have a home stay listed either way.
 */
export function ChatStorageSection() {
  const [settings, { mutate }] = createResource(async () => (await getWebSettings()).storage ?? STORAGE_DEFAULTS);
  const [saving, setSaving] = createSignal(false);
  const change = (key: keyof StorageWebSettings) => (on: boolean, el: HTMLInputElement) => {
    const now = settings();
    if (saving() || !now) {
      el.checked = !on;
      return;
    }
    setSaving(true);
    putWebSettings({ storage: { ...now, [key]: on } })
      .then((next) => mutate(next.storage ?? { ...now, [key]: on }))
      .catch((err: Error) => {
        // Nothing changed: the switch goes back to what the server has.
        el.checked = !on;
        toast(`Couldn't change that. ${err.message}`);
      })
      .finally(() => setSaving(false));
  };
  return (
    <section class="settings-updates settings-chat-storage" aria-labelledby="settings-chat-storage-title">
      <h3 class="settings-type-title" id="settings-chat-storage-title">
        Chats · this computer
      </h3>
      <ChatsFolderRow />
      <Show when={settings.error && !settings()}>
        <p class="field-error">Couldn't read these settings. {(settings.error as Error).message}</p>
      </Show>
      <Show when={settings()}>
        {(s) => (
          <>
            <Toggle
              switch
              class="settings-field"
              label="Chat homes"
              hint="Each new chat keeps its conversation, its helpers' conversations and its records together in a folder of its own. Off, new chats are stored as before. Chats that already have a home stay listed either way."
              checked={s().chatHomes}
              disabled={saving()}
              onChange={change("chatHomes")}
            />
            <Toggle
              switch
              class="settings-field"
              label="Compress old archived chats"
              hint="Archived chats older than 60 days are compressed in the background. They stay in the Archive, marked Compressed, and can still be deleted, but no longer open."
              checked={s().autoCompress}
              disabled={saving()}
              onChange={change("autoCompress")}
            />
          </>
        )}
      </Show>
    </section>
  );
}
