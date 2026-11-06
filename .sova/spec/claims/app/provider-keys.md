# §app/provider-keys — Provider keys in Settings → Accounts
> Part of the Sova design spec · [overview](../design/overview.md)

Settings → Accounts has one tab per provider: **Claude**, **OpenAI**, **Ollama Cloud**,
**DeepSeek**, **Z.ai** and **Other provider**. Each tab answers one question: can Sova's chats
use this provider here, and with which key or sign-in. The Claude tab keeps the Claude logins
(§app.claude-logins/accounts-tab) and the OpenAI tab the ChatGPT subscription sign-in
(§app.openai-login/section), unchanged, each with a pay-as-you-go API key below them
(§app.provider-keys/pay-as-you-go). The other four are key tabs (§app.provider-keys/key-tab).

A key lives where pi keeps it, pi's `auth.json` in the agent dir, as the provider's API key, so
every chat, worker and the TUI use it, and the mesh shares it with the computers that get logins
(§mesh.sync/logins). A key is checked before it is saved (§app.provider-keys/check-before-save),
read back only in a browser on this computer (§app.provider-keys/show-copy), and removed
everywhere it went (§app.provider-keys/remove). Only the person's own clicks in the page save,
show or remove one (§app.provider-keys/your-click).

## §app.provider-keys/tabs — The provider tabs

- Accounts opens a row of provider tabs above its panel, in the order Claude, OpenAI, Ollama
  Cloud, DeepSeek, Z.ai, Other provider. Each tab carries its status mark: the status chip's tone
  (§app.provider-keys/key-tab) as a small dot, and for Claude and OpenAI their sign-ins' standing;
  the tab's accessible name says it in words ("DeepSeek: Connected").
- On a phone (the folded sheet) the tabs are one row that scrolls sideways under a swipe, never
  wrapping, each with its status mark; the open tab scrolls into view.
- Accounts opens on the provider tab last open in this browser (Claude the first time).
- `#/settings/accounts/<provider>` (`claude`, `openai`, `ollama-cloud`, `deepseek`, `zai`,
  `other`) opens Settings at Accounts on that tab, as `#/settings/<tab>` does
  (§app.settings-dialog/outreach). The Mesh page's Claude login line opens the Claude tab.

## §app.provider-keys/key-tab — A key tab

Ollama Cloud, DeepSeek and Z.ai each show, top to bottom:

- **Status chip:** **Connected** (the last check accepted the key), **No key**, **Key refused**
  (the provider refused it at the last check) or **Not checked yet** (saved, but the provider
  couldn't be reached).
- **Key field:** a masked field showing only the key's last 4 characters (`••••••••a1b2`), with
  **Replace** and **Remove**; with no key, an empty field to paste into, with **Save**. Then
  **Show** and **Copy** (§app.provider-keys/show-copy).
- **Last checked:** when the key was last checked and what came of it ("Checked 2 minutes ago:
  accepted"), with **Test**, which checks it again now (§app.provider-keys/check-before-save). A
  tab whose key in use was never checked checks it once when it opens.
- **Ollama Cloud: one reading.** One round checks the key and the model list together and writes
  one record: the tab's Test, Settings → Models' Check Now (§app.model-levels/settings-line), the
  server's daily check and a successful save all run it, and both screens show the same time and
  outcome.
- **Mesh:** one muted line that the key is shared with the computers in your mesh that get
  logins, with a link to Settings → Mesh; while the mesh is off it isn't shown.
- **Provider off:** when the provider is switched off in Settings → Models, a line says so with an
  **Open Models** link. Nothing here ever turns it on.
- **Environment key** (`DEEPSEEK_API_KEY`, `ZAI_API_KEY`, and for the pay-as-you-go rows
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`): the tab names the
  key's source, **Saved here**, **Environment** or **None**. Status and Test check whichever key
  is in use; a saved key wins over the environment's. The environment's key is never shown,
  copied or removed: Show, Copy and Remove act only on a saved key.

## §app.provider-keys/check-before-save — A key is checked before it is saved

- A pasted key (Save or Replace) is checked with the provider before anything is written, by a
  free call that spends nothing: its model list or its account's balance, never a model.
- **Refused:** the key is never saved. The key already saved stays, here and on the mesh
  computers; the field keeps the paste so it can be corrected, and the chip reads **Key
  refused** with the provider's reason.
- **Provider unreachable:** the key is saved, and the chip reads **Not checked yet** until a Test
  or the next check reaches the provider.
- **Accepted:** saved, the chip reads **Connected**.
- **Never taken:** a pasted key starting with `!` (a command pi would run) is refused before any
  check. A key never saves over or removes a sign-in (pi OAuth) held under the same provider id:
  "{Provider} holds a sign-in of another kind here. Sign it out first."
- **A command key** already stored (written into `auth.json` by hand) is shown as a command key:
  never revealed, copied or checked ("A command key isn't checked.").
- Test checks the saved (or environment) key the same way and changes nothing but the status.

## §app.provider-keys/show-copy — Show and Copy only on this computer

- **Show** reveals the full key in the field, with **Copy**. It hides again after 30 seconds, on
  **Hide**, on switching to another provider tab, or on closing Settings.
- Show and Copy work only in a browser on this computer: the page's own request on the main
  listener from a loopback address. A phone, another computer, a mesh peer, a request relayed
  through the front door or a linked computer (whatever address it arrives from), a share link, a
  chat, the Overseer or a script never gets a key back.
- A key sent back is never logged, and its answer is `Cache-Control: no-store`.
- Anywhere else, Show and Copy are replaced by one muted line: "Keys can only be read back on this
  computer." Pasting, replacing, Test and Remove still work there.

## §app.provider-keys/remove — Remove removes it everywhere

- **Remove** asks inline first, saying the key is removed from this computer and from every mesh
  computer that shares logins ("Remove the DeepSeek key here and on your mesh computers?"), with
  **Remove Key** and **Cancel**.
- Removing it is a logout of that key in pi's `auth.json`, so it spreads through the mesh like any
  logout (§mesh.sync/logins). That provider's models leave the model menu, unless an environment
  key still serves it.

## §app.provider-keys/pay-as-you-go — Claude and OpenAI API keys

- Below the subscription sign-ins, which stay as they are, the Claude tab has an **Anthropic API
  key** (pi's `anthropic` provider) and the OpenAI tab an **OpenAI API key** (pi's `openai`), each
  labelled as billed per token, apart from the subscription.
- Each is a key row as on a key tab (§app.provider-keys/key-tab: status chip, masked field, Save,
  Replace, Remove, Show, Copy, last checked, mesh line, provider off), checked before saving by a
  free model-list call (§app.provider-keys/check-before-save).

## §app.provider-keys/other — Other provider

- The **Other provider** tab has a picker of every pi provider that takes an API key and has no
  tab of its own (OpenRouter among them); picking one shows its key row.
- That row has Save, Replace, Show, Copy and Remove only: no Test, no usage. A saved key's status
  reads **Saved, not checked**; with none, **No key**.

## §app.provider-keys/effects — What a save or a removal changes at once

- Saving, replacing or removing a key reaches the model menu at once: the provider's models join
  or leave it without a restart, and the usage reading for that provider is refreshed.

## §app.provider-keys/your-click — Only your own clicks in the page

- Saving, replacing and removing a key pass only on the page's own request, by the same test as
  §app.access/your-click: a chat's key, the Overseer, a token script, an extension's key or a mesh
  peer is refused with where to do it ("A chat can't change an API key. Ask the user to do it in
  Settings → Accounts. Nothing changed."), and nothing changes. Showing and copying pass only on
  the page's own request direct from this computer (§app.provider-keys/show-copy).
- **Test** is open to any caller: it changes only the status. The keys list (each provider's last
  4 characters, source and status, never a key) is readable by a mesh peer at the `sessions`
  level.
- None of them has a commands-catalogue entry or any other road for an agent; Settings stays an
  opted-out area (§app.commands/opted-out).
