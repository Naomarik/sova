# §app/openai-login — Signing in to OpenAI (a ChatGPT subscription) from Settings
> Part of the Sova design spec · [overview](../design/overview.md)

Sova's chats can use OpenAI's models through a ChatGPT subscription: pi's provider `openai-codex`.
Settings → Accounts' OpenAI tab lets the user sign in to it, see who is signed in, and sign out, without a
terminal or `pi /login`. There is one OpenAI sign-in per device, with no list of logins and no
switching. The ChatGPT subscription is the only sign-in offered; the tab's other way in is a
pay-as-you-go OpenAI API key, below it (§app.provider-keys/pay-as-you-go).

The sign-in is pi's own: Sova runs pi's login code for `openai-codex`, which stores it in pi's
`auth.json` in the agent dir (the place `pi /login` uses), under pi's own file lock, and pi renews
it while chats use OpenAI. Sova never renews it itself. The Codex app's own sign-in
(`~/.codex/auth.json`) is a different one: Sova only reads whether that file exists, and never
writes or uses it for chats.

No token or credential of the sign-in reaches the browser. The one string from the sign-in that does is the signed-in
account's email, read on the server from the access token's own claims (§app.insights/usage-refresh,
**Sign-in data**).

## §app.openai-login/section — The OpenAI tab of Settings → Accounts

Settings → Accounts' **OpenAI** tab (§app/provider-keys) starts with the ChatGPT subscription
sign-in; the pay-as-you-go **OpenAI API key** follows it (§app.provider-keys/pay-as-you-go). Its
intro says: "Sova's chats use OpenAI's models through your ChatGPT subscription. Sign in once on
this device; chats pick it up on their next message." While the mesh is on and this device shares
every login (§mesh.sync/logins), the second sentence says where the sign-in goes instead: "Sign in
once here; it's shared with your mesh computers that get logins, and chats pick it up on their next
message." The
sign-in is one row named "ChatGPT subscription". The section reads the sign-in's standing each time
the tab opens and after every sign-in or sign-out:

- **Signed out:** the chip "Not signed in" and **Sign In**. When the Codex app is signed in on this
  computer (its `~/.codex/auth.json` exists), one muted line adds: "The Codex app is signed in here,
  but Sova's chats need their own sign-in."
- **Signed in:** the account's email (when the token names one), the chip "Signed in", and one line
  of facts: the plan once a usage reading has named it, in the Usage page's words ("Plus plan";
  nothing until then, §app.insights/usage-cards), and when the sign-in renews, in the Usage page's
  words for its sign-in line ("Sign-in renews by {time}"). Then **Sign Out**.
- **A sign-in that stopped working:** the chip "Sign in again" and **Sign In**, which replaces it. It
  is read from the Usage page's reading of pi's sign-in: OpenAI refused it (and not merely because
  the access token timed out, which renews by itself), or its renewal has expired. A reading taken
  from the Codex app's sign-in never counts.
- **This device shares API keys only** (§mesh.sync/api-keys-only): one muted line, in place of the
  Codex app's, says "This device shares API keys only, so this sign-in stays on this device."

## §app.openai-login/sign-in — The sign-in panel

**Sign In** opens a panel under the row, "Sign in to OpenAI", like Claude's **Add a login**
(§app.claude-logins/add-remove), and starts pi's sign-in for `openai-codex`, choosing the code
route first. It speaks Sova's own words: no terminal menus, and nothing about a browser window
opening by itself.

- **Starting:** "Starting OpenAI's sign-in…".
- **The code:** a short code, the link to OpenAI's page (as a link, with **Copy Link**), "Open this
  link on any device, sign in, and enter this code." and "We'll finish here once OpenAI accepts the
  code." The panel then waits: nothing to paste.
- **When OpenAI refuses the code route** (the account doesn't have device codes enabled), the panel
  says "OpenAI didn't offer a sign-in code for this account. Sign in through the link instead." and
  offers the browser route: a link labelled "Open OpenAI's sign-in page" (with **Copy Link**, which
  copies its address), "Open this link, sign in, then paste the
  address the page ends on.", a field **Address after signing in** and **Finish Sign-In**. An
  address with no code in it, or from another sign-in, keeps the panel waiting for another, with the
  reason as the field's one sentence under it (§design/forms); once OpenAI rejects the exchange itself the sign-in fails. Only OpenAI's refusal of the
  code route offers the browser route: OpenAI unreachable or failing ends the sign-in as failed. While pi finishes:
  "Signing in…".
- **Done:** "Signed in", the account's email when known, and **Done**; the section shows the new
  sign-in.
- **Left alone for 15 minutes:** "The sign-in was left alone for 15 minutes and ended. Nothing was
  saved.", **Close** and **Try Again**.
- **Failed:** the reason, "Nothing was saved.", **Close** and **Try Again**.

**Cancel** works at every step, closing Settings cancels a sign-in still waiting, and a sign-in
left alone for 15 minutes ends by itself. Each of these stops pi's sign-in and saves nothing; on
the browser route that also frees `localhost:1455`, the port pi's sign-in listens on (the Codex
app's own sign-in uses it too). At most one OpenAI sign-in runs at a time. A failure shows Sova's
own sentence; pi's error text stays in the server's log.

REST, under the settings routes (`no-store`): `GET /api/settings/accounts/openai` (the standing:
`signedIn`, `email?`, `expiresAt?`, `expired?`, `codexAppSignedIn`, `meshSharesLogins`,
`apiKeysOnly`, `flow`; never a token), `POST /api/settings/accounts/openai/login` `{method?:
"code" | "browser"}` (409 while one runs), `GET /api/settings/accounts/openai/login`,
`POST /api/settings/accounts/openai/login/answer` `{text}` (409 when not waiting), `DELETE
/api/settings/accounts/openai/login` (cancel; it answers once pi's sign-in has stopped, the port
free) and `DELETE /api/settings/accounts/openai` (sign out; 409 while a sign-in runs).

## §app.openai-login/sign-out — Signing out

**Sign Out** asks first, then removes the OpenAI sign-in from pi's `auth.json` through pi's own
sign-out. The question says "Sova signs {email} out on this device." or, while the mesh is on,
"Sova signs {email} out here and on the other devices that share sign-ins." (the removal travels
as the sync's sign-out, §mesh.sync/logins), then "Chats on ChatGPT models stop until you sign in
again. The Codex app's sign-in and other providers' stay.", with **Sign Out of OpenAI**. Nothing
else changes.

## §app.openai-login/chats — Chats on the new sign-in

A chat that runs OpenAI's ChatGPT models uses the new sign-in from its next message, with no
restart, and the model menu offers those models once it exists, also without restarting Sova. After
a sign-in Sova asks for a usage refresh, so the Usage page and the sidebar's OpenAI meter
(§app.insights/sidebar-foot) read it soon; the meter is otherwise unchanged. After a sign-out the
models leave the menu the same way.
