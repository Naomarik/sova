# §mesh/public — Public links through a gateway
> Part of the Sova design spec · [overview](../design/overview.md)

People outside the tailnet open hand-off links (`/h/`) and owner-page links (`/i/`) on a public
address. One host, usually the VPS, can be the **public gateway**: its share listener
(§app.baton/share-listener) sits on `127.0.0.1` behind a **front** outside Sova that terminates TLS
for one hostname. Any other host can send its links **through** that gateway: it registers the
SHA-256 of each live token with the gateway over the tailnet, and the gateway forwards a request
for one of those hashes to the host's share **ingress**, which admits only its gateway. The host
that minted a token stays the only authority on it; the gateway never sees a token it didn't mint.
Sova shows the front's configuration and checks it; it never writes or runs it. The wire shapes
live in `shared/public-links.ts`, never in `shared/protocol.ts`, so the mesh fingerprint
(§mesh.peers/hello) is unchanged.

## §mesh.public/setting — The Public links setting and where links point

- `<stateRoot>/public-links.json`, mode 0600, written atomically, separate from `peers.json`, so it
  works with the mesh off: `{version: 1, route: "off" | "self" | {via: {nodeId}}, gateway?:
  {publicUrl, front: "vhost" | "caddy" | "funnel" | "cloudflared", sharePort, acceptFrom: "all" |
  <StableID>[]}, ingressPort?, lastKnownUrl?, verifiedAt?}`. A missing file is `off`. It is parsed
  strictly: an unknown key, a wrong type, a `route: "self"` without a `gateway`, a gateway missing
  a key, an `acceptFrom` naming a node twice, or a URL not written as its bare `https` origin (no
  path, query, login or trailing slash, nothing the URL parser would rewrite) rejects the whole
  file, which then reads as off, with a warning once per version of the file that never quotes it.
  `via.nodeId` is the gateway peer's StableID, so renaming the peer changes nothing. The gateway
  block is kept while the route is not `self`, so switching back restores it. The share and
  ingress ports default to 4802.
- `lastKnownUrl` (the via gateway's address as last learnt) and `verifiedAt` (the last Verify that
  passed) are written only by the server. A saved change of the gateway's address, or any route
  but `self`, drops `verifiedAt`: a Verify vouches for one address.
- Main listener only (a request from the peer listener, or carrying `X-Forwarded-Host`, gets the
  plain 404): `GET /api/public-links` → `{file, share, pinnedByEnv, front?, routed?, gateways}`;
  `PUT /api/public-links` with any of `route`, `gateway`, `ingressPort` (16 KB at most; a gateway
  may leave out `sharePort` and `acceptFrom` for their defaults, and its URL may carry one trailing
  slash) → the same answer, or 400 `{error}` naming the problem, with nothing written; `POST
  /api/public-links/verify` → `{ok, status?, error?}` (§mesh.public/front). `front` is the chosen
  front's guide while this host is the gateway, `routed` its routed hosts (§mesh.public/gateway),
  and `gateways` the peers whose hello advertises a gateway (none while the mesh is off).
- **Binding.** The share listener binds `127.0.0.1:<sharePort>` while this host is the gateway, and
  nothing otherwise. `SOVA_SHARE_HOST` and `SOVA_SHARE_PORT` pin the address; with both set it
  binds there whatever the setting says. A saved change rebinds without a restart, releasing the
  old port first; the same address keeps the socket. A routed host binds its ingress instead
  (§mesh.public/ingress).
- **The effective address**, first match wins: `SOVA_SHARE_PUBLIC_URL` (an `http` or `https` bare
  origin; any other value is ignored with one warning, and the setting decides); this host's own
  gateway address; the via gateway's address (as its info or ack last stated it, else its hello's,
  else `lastKnownUrl`); the bound address; none. Every `/h/` and `/i/` link is built by one helper
  on that address, or is just the path with none. The answer is a `ShareState`: `state` off,
  configured, verified or unreachable; `source` env, setting, gateway or bound; `publicUrl`; `via`
  (the gateway peer's current id); and `warning` with its `warningCode` whenever a link may not
  open from outside.
- **State and warning.** An address of this host's own is `verified` after a Verify of it passed
  (a bound address only by a Verify in this process), `unreachable` after one failed, else
  `configured` with the `unverified` warning. Through a gateway: `unreachable` when it didn't
  answer; `configured` with `not-accepted` when it answers but doesn't accept this host, or with
  `unconfirmed` before it was asked; `verified` once it answered and accepts. With no address the
  state is `off` with the `off` warning. The warning codes are `off`, `unverified`, `unreachable`,
  `unconfirmed`, `not-accepted` and `sleeps`; no server path sets `sleeps` today. Texts:
  §design.copy-deck/public-links.
- `pinnedByEnv` lists the `SOVA_SHARE_*` variables that are set (a refused `SOVA_SHARE_PUBLIC_URL`
  isn't): they win over the setting, and the panel shows their fields as set by the environment.

## §mesh.public/gateway — This host is the gateway

- With `route: "self"`, the share listener serves links minted here and links registered by
  routed hosts (§mesh.public/routing). Its public URL is the setting's, or `SOVA_SHARE_PUBLIC_URL`
  when that pin is valid; the pin never makes a host a gateway by itself.
- Only a gateway advertises itself, in its hello, as an optional field outside the fingerprint:
  `shareGateway: {publicUrl}`. That is discovery only. Another host lists it as a choice when the
  peer answers `up` and the URL is exactly a bare `https` origin.
- `acceptFrom` is `"all"` or a list of StableIDs. `GET /api/peer/share-gateway/info` tells the
  calling peer `{publicUrl, accepting, seq}` (`seq`: the last snapshot stored for it, null when not
  accepting); a host that is no gateway answers 404 `{error: "not-gateway"}`.
- `routed` (in `GET /api/public-links`, only while this host is the gateway): every host that
  registered links here, then every other host `acceptFrom` lists, each `{nodeId, peer, links, up,
  lastPushAt, accepted}`: its peer id (null when no longer in `peers.json`), its live `h` and `i`
  rows, whether its hello answers now, when its last snapshot was stored, and whether
  `acceptFrom` accepts it now.

## §mesh.public/front — The front and Verify

- The front is anything that terminates TLS for the public hostname and forwards it to
  `127.0.0.1:<sharePort>`. For the chosen front Sova generates the steps from the setting: the
  host's web server (an nginx server block, and a note for any other server), Caddy on this host
  (a one-time `setcap` so it can bind 80 and 443, the Caddyfile, then `caddy run`), Tailscale Funnel
  (a one-time `tailscale set --operator`, then `tailscale funnel --bg --https=443`, with a note that
  it is a preview until Funnel is confirmed to pass visitor addresses and live updates), or a
  Cloudflare Tunnel (create and route, `config.yml`, run). Each step says whether it needs root.
  Every snippet sets `X-Forwarded-For` to the one client address the front saw. Sova never runs
  these steps and never writes the front's configuration.
- **Verify** checks the effective address as it is now: it fetches `<address>/api/h/<random
  token>` and passes only on the share app's own answer for an unknown link, 404 with JSON `code:
  "not-found"` and `X-Content-Type-Options: nosniff` (the page shell answers 200 for any token, so
  it can't tell Sova from another server). The address must be `https` with no path, query or
  login, or nothing is fetched; a redirect fails ("the front must forward, not redirect"), and it
  gives up after 8 seconds. A pass writes `verifiedAt`; a failure drops it and the address reads
  `unreachable` until a Verify passes. With no address it answers "No public address is set."

## §mesh.public/registry — Which host minted a token

- **Push.** A routed host sends its gateway its whole live set as a `RegistrySnapshot`, `PUT
  /api/peer/share-gateway/links` `{v: 1, seq, links: {h, exp, kind: "h" | "i" | "x"}[], assets,
  ingressPort}`: every hand-off and owner link not revoked or expired, as the lowercase hex SHA-256
  of its token, and the names in its own share build's `assets/`. It sends on every mint and
  revoke, when it starts routed or its route changes, when the gateway comes up, and every 60
  seconds while a snapshot is still owed. `seq` grows by one per snapshot and is kept in
  `<stateRoot>/share-gateway-outbox.json` (0600) across restarts; the outbox records only that a
  snapshot is owed, and a retry sends the live set as it is then. Past 20,000 links or 512 KB the
  links expiring soonest are left out, with a log line. Every call goes to an address bound to the
  gateway's StableID (a tailnet IP Tailscale lists for that node, or the entry's pinned address in
  address-identity mode), never to a name, and follows no redirect.
- **Validation, all or nothing.** The gateway reads at most 512 KB before parsing. Exactly the
  snapshot's keys; `v` is 1; `seq` a nonnegative safe integer; `ingressPort` 1–65535; at most
  20,000 links and 64 assets; each `h` 64 lowercase hex characters, none twice; `kind` in the enum;
  `exp` in the future and at most 91 days away; asset names match `^[A-Za-z0-9_-][A-Za-z0-9._-]*$`
  with no `..`, none twice. One failure rejects the whole snapshot (`bad-snapshot`), and nothing
  changes.
- **Store.** `<stateRoot>/share-gateway.json` (0600, atomic), keyed by the caller's verified
  StableID, never by anything in the body. A snapshot whose `seq` isn't newer than the stored one
  changes nothing. Otherwise the caller's rows are replaced at once by the accepted ones: a hash
  the gateway minted itself, or one another live host holds, is a collision, dropped and listed; a
  collision never moves a hash. Rows of a peer no longer in `peers.json` or no longer accepted,
  and rows past `exp`, never route, and go at the next commit. A stored file that breaks any rule
  routes nothing and is never overwritten (the push answers 503) until the operator fixes or
  removes it.
- **Ack.** `{ok: true, seq, publicUrl, collisions?}` with the stored `seq` (also for an ignored
  stale snapshot), or `{ok: false, error: "not-gateway" | "not-accepted" | "bad-snapshot"}`.
  Acceptance is judged again after the body arrived.
- **At mint.** A request that mints a link waits at most 3 seconds for the answer to its own
  change. The mint is confirmed only by an ack for a snapshot at least as new as the one that
  carried it, from the gateway still selected, with its hash sent and not among the collisions.
  Otherwise (no answer, a refusal, a collision, the link revoked or left out before the send, the
  route changed) the link is still returned, with the `unconfirmed`, `unreachable` or
  `not-accepted` warning, and the outbox keeps sending. A routed host also asks its gateway's hello
  and info every 60 seconds, so its state doesn't go stale between pushes.

## §mesh.public/ingress — A routed host admits only its gateway

- With `route: {via}` and the gateway listed in `peers.json`, the host binds a share ingress on its
  tailnet addresses (`SOVA_PEER_HOST` when set), never loopback or a wildcard, at `ingressPort`
  (4802 by default). It serves exactly the share listener's paths and `/ws/h`, with the same edge
  (§app.baton/share-listener), and retries every 15 seconds when it can't bind.
- Every request and upgrade must come from the via gateway: its StableID by Tailscale `whois`, and
  in address-identity mode (§mesh.peers/address-identity) also one of its pinned addresses. Anyone
  else gets 403 with the refused marker. A missing, ambiguous or non-matching identity fails
  closed. In address-identity mode a reassigned address is a residual risk: its new holder can't be
  told apart, so remove or re-pair the peer promptly.
- Every connection it admitted, kept-alive and upgraded ones alike, is judged again on a setting
  change and every 2 seconds; one that no longer passes (the gateway removed or changed, its pins
  changed, its address now ambiguous or unmapped) is closed. Leaving the route unbinds it.

## §mesh.public/routing — The gateway routes by token hash

- The share edge (allowed paths, the per-address limit, timeouts, the body cap) runs at the gateway
  before any hop. Then: a token this host minted, live or not, is served in-process; else a hash a
  live, accepted host registered for that route's kind is forwarded to that host's ingress; else
  the request is served in-process, which answers 404 for an unknown token's API and socket (the
  page shell answers 200 for any token). An unknown hash is never asked of any host.
- **Kinds bind routes.** An `h` row serves `/h`, `/api/h` and `/ws/h`; an `i` row serves `/i` and
  `/api/i`; an `x` row never routes.
- A hop dials a literal tailnet address verified to belong to the row's StableID (from Tailscale's
  status, at most 5 seconds old, or the pinned address in address-identity mode), never a name, at
  the row's ingress port. Authorization is judged again after each wait and for as long as a hop
  stays open: a hop whose host no longer holds the hash (setting gone, peer removed or not
  accepted, row withdrawn or expired, port or address moved) is closed, checked on every registry
  commit, setting change and each second. A hop is tried once; a POST is never retried or
  replayed. At most 256 HTTP hops and 256 `/ws/h` hops (4 per link) are open at once.
- A hop's answer passes through without cookies or `x-sova-*` headers and always with
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `nosniff`. The minting host keeps
  its per-token limits, visits and CSP.
- `/ws/h` through a hop: the page's handshake is checked first (400 otherwise); the page is
  accepted only after the host's side opened and the route was judged again (404 otherwise). The
  page's messages keep the 1 KB cap before anything is forwarded; the host's messages to the page
  aren't capped by it. The origin's own closes (1000, 4000, 4410) and statuses (404, 410, 429) pass
  through as they are.
- A hashed `/h/assets/<name>` comes from the gateway's own share build first, else from the first
  live host whose snapshot listed the name, typed by its extension (js, css, woff2, svg, png; any
  other is never fetched), capped at 5 MB while streaming.

## §mesh.public/offline — A known link whose host is down

A registered hash whose host is down, has no verified address, refuses the gateway, answers 502 or
504 or a redirect, or sends no response headers within 15 seconds:

| Request | Answer |
|---|---|
| Page shell `/h/<t>`, `/i/<t>` | 503 static page that names no host and repeats no token; `Retry-After: 60`, `no-store`, `no-referrer`, `nosniff`, the share page's CSP |
| `/api/h/…`, `/api/i/…`, POST included | 503 `{error: "offline", retryAfter: 60}`; the body is dropped, never buffered or replayed |
| `/ws/h` upgrade | 503 |
| A live `/ws/h` hop whose host goes away | Close 4503 |
| An asset whose source fails | 503 |
| An unknown hash | 404, never asked of any host |

A hop that dies after its headers went out is cut, never passed off as a whole answer. The share
page shows "Reconnecting. Your draft is kept." while offline and reconnects, backing off from 5 to
60 seconds; a message refused with 503 stays in the composer with "Not sent. The page is offline;
your message is still here.", never resent on its own. The owner page keeps what it shows and
reads again. Copy: §design.copy-deck/public-links.

## §mesh.public/forwarded-for — The client address

- The gateway's share listener keys its per-address limit on the last `X-Forwarded-For` hop only
  when the connection comes from loopback (its front); from any other address, tailnet included,
  it uses the socket address. A value that isn't an IP literal falls back to the socket address.
  `Forwarded`, `X-Real-IP`, `Tailscale-*` and `x-sova-*` are never read.
- On every hop the gateway first strips every incoming `Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
  `Tailscale-*` and `x-sova-*` header (any case), the hop-by-hop headers and every header named in
  `Connection`, then sets exactly one `X-Forwarded-For` (the client address it computed),
  `X-Forwarded-Proto: https` and `X-Forwarded-Host` from its configured public URL, never from the
  incoming `Host`.
- A routed host's ingress believes `X-Forwarded-For` only on a connection its gate admitted, and
  only a single value; otherwise it keys on the socket address. No other tailnet device can choose
  its own rate-limit key.

## §mesh.public/panel — Settings → Public links

A Settings tab of its own, **Public links**, after Mesh (§app/settings-dialog). It works with the
mesh off. Copy is §design.copy-deck/public-links.

- **Top to bottom:** the title with the state chip (`Off`, `Not verified` warn, `Verified` success,
  `Unreachable` error), the line, then the **Address** row: the effective address in mono and its
  source (`Set by environment ({var})`, `From this setting`, `From {gateway}`, `Bound address`), or
  `None`. Then **Where links open**, radios: `Off`, `This host is the gateway`, and one `Through
  {gateway}` per peer advertising a gateway (a saved gateway no longer advertised keeps its radio),
  each with its hint.
- **This host is the gateway:** Public address, Front (the four front labels), Local port, Accept
  links from (`All hosts` or `These hosts`, a checklist of every peer; a saved StableID with no
  peer shows as its id), the front's steps under "Set up the front once" (each step's label, a
  `Needs root` chip when it does, `Copy Step`, the text in mono, then the guide's notes; while the
  form's front differs from the saved one: "Save Changes to see the step for this setting."),
  **Verify Address**, and **Hosts sending links here** (one read-only row per routed host: its
  name, `{n} links`, `Last push {time}` or `Never pushed`, and `Up` / `Down`, or `Not accepted`
  in its place; none: "No other host sends its links here yet.").
- **Through {gateway}:** the always-on advice, Ingress port, and, while that gateway is the saved
  route, its `unreachable` or `not-accepted` warning as a warn banner.
- **Saving:** every field and the route are staged and written by the dialog's Save Changes
  (§app.settings-dialog/save-bar), which sends only what changed (the whole gateway block when any
  of its fields did). A field an environment variable pins is read-only with the pinned hint, and
  isn't checked. An address that isn't a bare `https` host, a port outside 1–65535, or a Through
  without a gateway shows its error on the field and holds Save. A failed save shows "Couldn't save
  the public links setting." and keeps the saved setting.
- **Verify** acts on the saved address: it is disabled, saying why beside it, until the gateway
  setting and any new address are saved. A pass shows "Verified {time}. {url} reaches this
  gateway."; a failure an error banner, "Couldn't reach {url}.", with the reason (or "It answered
  {status}").
- The Mesh card (§mesh.ui/card) carries a second chip while a route is on, `Public links: gateway`
  or `Public links: through {gateway}`, in the state chip's tone.
