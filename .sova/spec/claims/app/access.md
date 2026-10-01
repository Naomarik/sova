# §app/access — Reaching the app

Sova's main listener serves one person on one machine, and it proves that with a per-install
token rather than with the address it was reached on: a request is answered only when it carries
the token, names a host this app is reachable at, and comes from a caller that is not another
site acting on the person's behalf. The public side of
Sova — the share listener and preview links — is not this claim: it keeps its own tokens and its
own edge (§mesh.public, §app.baton/share-listener).

## §app.access/token — One per-install token

One secret per install, at `<agent dir>/sova/auth-token`: 32 random bytes in base64url at mode
0600, minted on the first start that finds no such file, and never rewritten or rotated while it
exists. Creation is exclusive: two starts racing on one agent dir end up with the one token that
landed first, and a file that holds no token stops the start instead of being replaced. It is
compared with a constant-time equality; a request either carries it or is refused. It is never
written to a log, a reply, a session file or a commit message, and no surface ever prints it
except `sova token`, which exists to be read by its owner.

- **Revocation.** Deleting the file revokes every browser at once: the next start mints a new
  token, and every cookie and header carrying the old one stops being answered.
- **A pinned token.** `SOVA_TOKEN`, when set at start, is the token instead of the file's; it is
  read once and taken out of the server's environment, so nothing the server starts inherits it.
- **What it is not.** There is no account, no password, no per-device secret and no expiry. A
  caller that has the token has everything the person has, which is why it travels nowhere else
  (§app.access/callers).

## §app.access/gate — What the gate answers, and what it never asks

The main listener answers a request when it presents the token as either this install's cookie
or an `x-sova-token: <token>` header, and refuses it otherwise with `401`. The cookie is named
per install, `sova_token_<8 hex>`, so two Sovas on one host name (the live one beside a hermetic
one: cookies ignore ports) never overwrite each other's; it is `HttpOnly`, `SameSite=Strict`,
`Path=/`, kept a year, and `Secure` when the app was reached over https. A request carrying
several cookies of that name is answered if any of them is the token, so a page that plants a
second one cannot lock the person out. No other carrier counts: an `Authorization` bearer is not
the token. The `401` is JSON that tells the reader to reload, so a tab left open across the change
finds its way to the unlock screen (§app.access/unlock).

Independently of the token, and even when it is right, it refuses with `403`:

- a **host** that is not one this app is reachable at, judged from the real `Host` header alone
  (never a forwarded one): `127.0.0.1`, `localhost` or `[::1]` on any port, this machine's own
  hostname, any MagicDNS name (`*.ts.net`, which only Tailscale resolves — so `tailscale serve`
  reaches the app even while the mesh is off and its own name unknown), the front door's and the
  serve URL's names, every address of this machine while the server is bound to all of them (`0.0.0.0`), and
  any name listed in `SOVA_ALLOWED_HOSTS`. A domain name that merely resolves here is refused.
- a **cross-site request**: an `Origin` that is not one of the app's own, or, with no such
  `Origin`, a `Sec-Fetch-Site` of `same-site` or `cross-site`. The app's own origins are matched
  exactly — scheme, host and port, never the host alone: `127.0.0.1`, `localhost` and `[::1]` on
  this server's port, this machine's hostname on it (and each of its addresses while bound to all
  of them), the mesh's own MagicDNS name on any port, a `*.ts.net` page whose origin is exactly
  `https://` and the real `Host` (name and port; another tailnet's page is another site), the front
  door, this host's and each peer's serve URL, and any origin listed in `SOVA_ALLOWED_ORIGINS`. This, not the cookie, is what refuses
  a page on another port of the same machine — the browser counts it as the same site and sends it
  the cookie — and what stops a page the person visits, or a rebound hostname, from acting for
  them; a page behind the front door, whose proxy names this host in `Host`, passes by its own
  origin. A forwarded header is never what admits a request.

Sova makes no demand on a body's content type: the token and the two rules above are the gate.

Never asked for the token, and reachable exactly as before: a call with no socket at all (the
Overseer's own dispatch, schedules, decide loops, tests through `app.request`), and a call on the
peer listener, which is already answered by Tailscale identity (§mesh.peers/listener) — a peer
presents no token and keeps every route it had. Open to a browser without the token, behind the
host rule: the app's static shell and assets (a `GET` or `HEAD` outside `/api`, `/ext`, `/peer`,
`/explain`, `/design` and `/ws`; a link from another site may open the shell as a page, which then
shows the unlock screen, and reach nothing else that way), `GET /api/health`,
because it is how a front and a doctor ask which build runs, and `POST /api/auth/unlock`; nothing
that reads or changes state is open beside them. Everything else on the listener, a route family
added later included, is gated by default. `SOVA_AUTH=off` stops asking for the token, for a test
rig, and only while the server is bound to loopback; the host and cross-site rules hold anyway.

Every answer on the main listener, a refusal and the static shell included, carries
`X-Sova-Server: sova`, which a preview link refuses to pass on, so no preview can front a Sova
port (§mesh.public/preview). A request forwarded to a peer (`/peer/<id>/…`) carries none of this
host's credentials — no cookie, no `x-sova-token`, no `Authorization` — and a peer's answer can
set no cookie here.

The **sockets** are checked the same way and for the same reasons: every upgrade on the main
listener — `/ws/chat`, `/ws/watch`, an extension's socket and a peer's — requires the token and
passes the host and cross-site rules before it is dispatched, since neither CORS nor `SameSite`
gates a WebSocket on its own. The peer listener's own upgrades are not asked. The gate's refusal
never leaks which part failed beyond the status: an unauthenticated caller learns whether it lacks
the token, not what the token is.

## §app.access/unlock — The first visit, and the way back in

A browser with no token is shown an unlock screen instead of the app: a heading, a one-line
explanation, a token field and an `Unlock` button. It takes the token, and from then on that
browser is never asked again.

- **The link.** `sova open` (and any URL a person copies from it) carries the token in the URL's
  **fragment** — `#t=<token>` — which a browser never sends to the server. The page posts it once
  to `POST /api/auth/unlock`, which sets the cookie and answers; the fragment is then cleared
  from the address bar, and the app is held back until the answer arrives. Unlocking changes
  nothing but the cookie. A token the server refuses leaves the unlock screen showing why.
- **Any state, no storm.** The screen replaces the app whenever the server refuses the browser —
  any request answered `401`, or a socket whose upgrade is refused (which stops reconnecting
  instead of retrying into the refusal). A refusal that asks for a reload reloads the page once,
  so a tab older than the server picks up the current app; a second one shows the unlock screen,
  never another reload. The screen itself makes no request until `Unlock` is pressed, and a
  page unlocked from it reloads so every view starts with the cookie.
- **The way back.** `sova token` prints the token for a person who needs it on another device or
  in a script; `sova open` opens the authorized URL. Losing the cookie — a new browser, a private
  window, the phone — costs one paste, never a reset.
- **The phone.** A device reaching the app through `tailscale serve` unlocks once with the token
  its owner copies to it, and its host name counts as reachable by the rule above.

## §app.access/callers — Everything that is not a browser

Every caller keeps working with no new step for the person:

- **A held session's extension tools** that call this server back over loopback get the token
  from the runtime they run in, through the `sova-link-token` flag beside `sova-link` (handed in
  process, never on a command line or in an environment); they send it as `x-sova-token`. A
  runtime without the flag sends none, as before.
- **Extension UIs** served at `/ext` are the same origin as the app and ride the same cookie.
- **Extension backends** never see it: a request proxied to one loses every `sova_token_*`
  cookie, `x-sova-token`, and an `Authorization` that carries the token, while its other cookies
  and headers (an extension's own `Authorization` included) pass through. A backend that calls
  this server back reads the token itself, from `SOVA_TOKEN` if started with it or from the token
  file, as docs/customization.md tells its author.
- **Scripts and documented commands** that talk to the main listener send `x-sova-token`, read
  from `SOVA_TOKEN`, else the target's own token file (`scripts/sova-token.mjs` for Node scripts,
  `$(sova token)` in the docs' curl lines); a rig that starts its own servers pins one token for
  them with `SOVA_TOKEN`, or reads each server's file.
- **`sova token` and `sova open`** are the installed launcher's: `token` prints the token from the
  agent dir (`$PI_CODING_AGENT_DIR`, else the one the install used), and `open` opens
  `http://127.0.0.1:<PORT, else the install's port>/#t=<token>` in the browser; neither starts the
  server, and before the server ever minted a token both say to start it once and exit nonzero.
- **A local development server** that proxies to the app presents its own page as the app: it
  forwards the cookie, names the app's own host, and replaces an `Origin` naming the dev server
  itself (a loopback name, as the browser addressed it) with the app's, on requests and socket
  upgrades alike. Any other `Origin` (a page on another local port) goes through untouched and is
  refused like any cross-site caller.
- **`dev:hermetic`** mints its own token in its own agent dir (when the server has not yet) and
  prints the unlock URL for its first visit, `http://127.0.0.1:<SOVA_PORT, else 4810>/#t=<token>`.
  Building a hermetic agent dir without asking for that URL (a deploy, a test rig) never prints
  the token. A test rig may set `SOVA_AUTH=off` to disable the gate or `SOVA_TOKEN=<token>` to
  pin a known one; neither is honoured by the installed service unless the person sets it.
- **Another host** is never given this token: a request proxied to a peer, or from one, carries
  no cookie from this side.
