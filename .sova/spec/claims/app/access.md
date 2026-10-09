# §app/access — Reaching the app

Sova's main listener serves one person on one machine, and it proves that with a per-install
token rather than with the address it was reached on: a request is answered only when it carries
the token (or is that machine's own browser opening the app, §app.access/gate), names a host this
app is reachable at, and comes from a caller that is not another site acting on the person's
behalf.

It listens on `127.0.0.1:4800`, loopback only, unless the server is started with `HOST` or `PORT`
set (`HOST=0.0.0.0` exposes it on every address of the machine on purpose; `PORT=0` takes any free
port). The installed `sova` launcher passes both through to the server, and with no `PORT` set it starts
the server on the port it was installed with (`--port`, default `4800`). The public side of
Sova — the share listener and preview links — is not this claim: it keeps its own tokens and its
own edge (§mesh.public, §app.baton/share-listener).

## §app.access/token — One per-install token

One secret per install, at `<agent dir>/sova/auth-token`: 32 random bytes in base64url at mode
0600, minted on the first start that finds no such file, and never rewritten or rotated while it
exists. Creation is exclusive: two starts racing on one agent dir end up with the one token that
landed first. A file that holds no valid token is never replaced: startup logs the problem once
and keeps serving the static shell; token checks fail closed with a 401 whose error and hint say
`<file> does not hold a Sova token: delete it and restart to mint a new one`. HTTP, unlock and
WebSocket refusals carry that same recovery message. The damaged state is held until restart.
A valid token is compared with a constant-time equality; a request either carries it or is refused. It is never
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
finds its way to the unlock screen (§app.access/unlock); a damaged token file instead names the
problem and the delete-and-restart recovery (§app.access/token).

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
  origin. Only when the real Host is `127.0.0.1`, `localhost` or `[::1]` on this process's port,
  an `X-Forwarded-Host` whose name passes the same host allowlist admits an HTTPS origin with
  the same ts.net hostname, case-insensitive and with trailing dots stripped, regardless of
  either port (including a forwarded host with no port). A ts.net name resolves to this node
  alone, so any port on it is still this app, as with the mesh-known MagicDNS name. This exception
  never admits HTTP or another hostname; direct Host matches and all other origin comparisons
  stay as before. An absent, malformed or unallowed forwarded host changes nothing. The real-Host allowlist is always checked first and the token is still required;
  a different real Host never gains this fallback. A browser page cannot forge the header on a
  simple cross-origin request: no-cors drops non-safelisted headers and Sova never approves a
  CORS preflight.

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

**A browser on this machine is not asked.** Opening the app's own address on the machine Sova runs
on just works: a request that carries **no proxy header at all** (nothing from a front, a relay or
`tailscale serve`), arrives on this process's own port, and is the browser's own **navigation** to
it — `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Site` either `same-origin` (a link inside the app)
**or `none`** (a typed address or a bookmark, which is how a person usually arrives) — headers a
script cannot set, is answered and given the cookie instead of the unlock screen. Every other caller keeps the rules
above unchanged: a request carrying proxy headers (which is how the tailnet reaches this listener,
through loopback), a cross-site request, a page on another port of this host, a foreign Host, and
any caller that sets no fetch metadata at all still needs the token. The rule is a convenience for
the person at the keyboard, never a licence for the network.

Every answer on the main listener, a refusal and the static shell included, carries
`X-Sova-Server: sova`, which a preview link refuses to pass on, so no preview can front a Sova
port (§mesh.public/preview). A request forwarded to a peer (`/peer/<id>/…`) carries none of this
host's credentials — no cookie, no `x-sova-token`, no `Authorization` — and a peer's answer can
set no cookie here.

The **sockets** are checked the same way and for the same reasons: every upgrade on the main
listener — `/ws/chat`, `/ws/watch`, an extension's socket and a peer's — requires the token and
passes the host and cross-site rules before it is dispatched, since neither CORS nor `SameSite`
gates a WebSocket on its own. The peer listener's own upgrades are not asked. The gate's refusal
never reveals the token: an unauthenticated caller learns whether it lacks the token, or that
the install's token file is damaged and needs deletion and a restart.

## §app.access/unlock — The first visit, and the way back in

A browser with no token is shown an unlock screen instead of the app: a heading, a one-line
explanation, a **choice of what is being pasted** — a pairing code or the install's token — a field
and an `Unlock` button. It accepts either, and from then on that browser is never asked again. Every
sentence on that screen has to be true on a machine with **no `sova` command installed**: it names
the pairing code first, the token FILE as the fallback, and the installer's commands only as the
alternative for someone who has that launcher.

- **The link.** `sova open` (and any URL a person copies from it) carries the token in the URL's
  **fragment** — `#t=<token>` — which a browser never sends to the server. The page posts it once
  to `POST /api/auth/unlock`, which sets the cookie and answers; the fragment is then cleared
  from the address bar, and the app is held back until the answer arrives. Unlocking changes
  nothing but the cookie. A token the server refuses leaves the unlock screen showing why.
- **A code.** A device that is already unlocked can mint a short-lived, single-use pairing code
  (§app.access/devices); the new device opens the same screen with `#c=<code>` in the fragment and
  the same route exchanges it for that device's cookie, so the install's token itself never leaves
  the browser that already had it. It is **typed on that screen** as readily as it is opened as a
  link: the form's choice of what is being pasted is what keeps the two secrets apart, since a
  minted token and a minted code are the same shape and neither can be told from the other by
  looking. The screen says where a code comes from, for a person who has only the device in hand.
- **Any state, no storm.** The screen replaces the app whenever the server refuses the browser —
  any request answered `401`, or a socket whose upgrade is refused (which stops reconnecting
  instead of retrying into the refusal). A refusal that asks for a reload reloads the page once,
  so a tab older than the server picks up the current app; a second one shows the unlock screen,
  never another reload. The screen itself makes no request until `Unlock` is pressed, and a
  page unlocked from it reloads so every view starts with the cookie.
- **The way back.** Losing the cookie — a new browser, a private window, the phone — costs one
  paste, never a reset. What the screen names is reachable on the machine Sova runs on: the token
  file, `<agent dir>/sova/auth-token`, read there (mode 0600). `sova token` and `sova open` are
  named only as the alternative for a person who installed through the installer's launcher — never
  as the only way, because a checkout has no such command.
- **One address at a time.** Unlocking one address of this Sova does not unlock another: the cookie
  is scoped to the host it was set for, so `127.0.0.1`, `localhost` and a tailnet name each need
  their own unlock, while two ports of one host share one. The screen says so, and the pairing code
  is the way across — a code is not bound to the address that minted it and works at any address
  this server allows, which is why the access page names the address to open and not merely a link.
- **The phone.** A device reaching the app through `tailscale serve` gets in with a pairing code
  read off a browser that is already unlocked, or with the token its owner copies to it; its host
  name counts as reachable by the rule above.

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
  from `SOVA_TOKEN`, else the target's own token file (`scripts/sova-token.mjs` for Node scripts, which
  `pnpm run auth:token` runs from the checkout, and `$(sova token)` in the docs' curl lines for a
  host that installed the launcher); a rig that starts its own servers pins one token for
  them with `SOVA_TOKEN`, or reads each server's file.
- **`sova token` and `sova open`** are the installed launcher's: `token` prints the token from the
  agent dir (`$PI_CODING_AGENT_DIR`, else the one the install used), and `open` opens
  `http://127.0.0.1:<PORT, else the install's port>/#t=<token>` in the browser; neither starts the
  server, and before the server ever minted a token both say to start it once and exit nonzero.
  Plain `sova` serves on that same port. With no browser opener (`open` on macOS, `xdg-open`),
  `open` says to paste the token from `sova token` into the page and exits nonzero.
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

## §app.access/devices — Bring a device in with a code

A person who can already use the app can bring a second device in without ever seeing the install's
token: an already-unlocked browser mints a **pairing code**, and the new device trades it for its
own cookie. The code is a secret in its own right and is treated as one.

- **Minting.** `POST /api/auth/pair` mints a code: 32 random bytes in base64url, valid for five
  minutes and usable exactly once. Codes live in `<state root>/auth-codes.json`, written at 0600
  like every other store, and an unreadable store lists none of them rather than guessing.
- **Exchanging.** The code is typed on the unlock screen's pairing-code field, or presented in the
  fragment of the unlock URL (`#c=<code>`, which a browser never sends to the server) and posted
  once to `POST /api/auth/unlock` — the same route a token uses. A good code sets the cookie and is
  consumed; a bad, spent or expired one is refused
  with the same 401 a bad token gets, and a spent code is never accepted twice.
- **Every address a device can use.** The answer names each of them, as its own link: the origin
  the minting page is served from, and the tailnet's own HTTPS address — this host's serve URL when
  it has one, else `https://<its MagicDNS name>:8443` — with its port. Never a bare IP address, and
  never http for the tailnet one. A code is exchanged at whichever of those origins the other
  device opens, so one code serves every link; an address this server cannot know is simply absent,
  and a page with no reachable-from-elsewhere link says so rather than offering a loopback one to a
  phone that cannot open it.
- **The phone's way in is the tailnet link.** The page leads with the address another device can
  reach — the tailnet HTTPS one — and renders it as a **QR** the phone scans, drawn in the page
  itself from a vendored encoder (no external service, no image request), with a copy control
  beside every other address. The QR carries a live single-use code, so the page keeps saying the
  link is private.
- **Who may mint.** Only a browser the gate already trusts: the route is behind the gate like every
  other, and it is **local-only** — a call carrying `c.env.meshPeer` (the peer listener) or a
  relayed one is refused, so a paired peer cannot mint itself the owner's credential.
- **Where it is reached.** The app's own home surface carries the control, which opens the access
  page; that page shows the code, the exact URL to open on the other device, and a copy control.
  It is the only entry point — Settings has no access tab. Nothing here is written to a log, and
  the code and the token never appear in a session file or a tool result.
- **The token, in full, only where it is needed.** The same page may show the install's token
  behind a second, deliberate step — for the case where the exchange route itself is what is broken
  — and never by default.
