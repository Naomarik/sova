# §mesh/public — Public links through a gateway
> Part of the Sova design spec · [overview](../design/overview.md)

People outside the tailnet open hand-off links (`/h/`), owner-page links (`/i/`) and session share
links (`/s/`, §app/session-share) on a public address. One host, usually the VPS, can be the **public gateway**: its share listener
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
  <StableID>[], previewUrl?}, ingressPort?, lastKnownUrl?, verifiedAt?}`. A missing file is `off`. It is parsed
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
- Main listener only (a request from the peer listener, or carrying `X-Sova-Relayed`, which
  another host's `/peer/<id>/` proxy sets on everything it relays, gets the plain 404; a generic
  reverse proxy in front of the main listener, such as `tailscale serve`, Caddy or nginx, is
  served even though it sets `X-Forwarded-Host`): `GET /api/public-links` → `{file, share, pinnedByEnv, front?, routed?, gateways}`;
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
  else `lastKnownUrl`); the bound address; none. Every `/h/`, `/i/` and `/s/` link is built by one
  helper on that address, or is just the path with none. The answer is a `ShareState`: `state` off,
  configured, verified or unreachable; `source` env, setting, gateway or bound; `publicUrl`; `via`
  (the gateway peer's current id); `warning` with its `warningCode` whenever a link may not
  open from outside; and `listener` while the share port won't open (§mesh.public/listener-failure).
- **State and warning.** An address of this host's own is `verified` after a Verify of it passed
  (a bound address only by a Verify in this process), `unreachable` after one failed, else
  `configured` with the `unverified` warning. Through a gateway: `unreachable` when it didn't
  answer; `configured` with `not-accepted` when it answers but doesn't accept this host, or with
  `unconfirmed` before it was asked; `verified` once it answered and accepts. With no address the
  state is `off` with the `off` warning. The warning codes are `off`, `unverified`, `unreachable`,
  `unconfirmed`, `not-accepted` and `sleeps`; no server path sets `sleeps` today. Texts:
  §design.copy-deck/public-links.
- `pinnedByEnv` lists the `SOVA_SHARE_*` variables that are set (a refused `SOVA_SHARE_PUBLIC_URL`
  isn't; `SOVA_SHARE_PREVIEW_URL` too, §mesh.public/preview-address): they win over the setting, and the panel shows their fields as set by the environment.

## §mesh.public/via-answer — Routing through a gateway answers with it

A `PUT /api/public-links` that routes this host through a gateway waits up to 3 seconds for the
gateway's first answer to its hello and info before it replies. The reply then carries the
gateway's address and state (`verified` when it accepts) rather than `off` with "Turn on public
links". When nothing answers in time, it replies with the state as it stands.

## §mesh.public/gateway — This host is the gateway

- With `route: "self"`, the share listener serves links minted here and links registered by
  routed hosts (§mesh.public/routing). Its public URL is the setting's, or `SOVA_SHARE_PUBLIC_URL`
  when that pin is valid; the pin never makes a host a gateway by itself.
- Only a gateway advertises itself, in its hello, as an optional field outside the fingerprint:
  `shareGateway: {publicUrl}`. That is discovery only. Another host lists it as a choice when the
  peer answers `up` and the URL is exactly a bare `https` origin.
- `acceptFrom` is `"all"` or a list of StableIDs. `GET /api/peer/share-gateway/info` tells the
  calling peer `{publicUrl, accepting, seq}` (`seq`: the last snapshot stored for it, null when not
  accepting); a host that is no gateway answers 404 `{error: "not-gateway"}`. Asked with
  `?kinds=1`, the answer adds `kinds`, the link kinds this gateway accepts and routes (`h`, `i`,
  `s`, `x`, `p`), and asked also with `preview=1` it adds `previewUrl` when a preview address is
  set (§mesh.public/preview-address); without it the answer keeps exactly the three keys, since an older routed host parses
  it strictly.
- `routed` (in `GET /api/public-links`, only while this host is the gateway): every host that
  registered links here, then every other host `acceptFrom` lists, each `{nodeId, peer, links, up,
  lastPushAt, accepted}`: its peer id (null when no longer in `peers.json`), its live `h`, `i`
  and `s` rows, whether its hello answers now, when its last snapshot was stored, and whether
  `acceptFrom` accepts it now.

## §mesh.public/front — The front and Verify

- The front is anything that terminates TLS for the public hostname and forwards it to
  `127.0.0.1:<sharePort>`. For the chosen front Sova generates the steps from the setting: the
  host's web server (an nginx server block with its certificate lines at certbot's paths, a note
  to get that certificate before adding the block, `certbot certonly --nginx -d <host>`, or to use
  another certificate's paths, and a note for any other server), Caddy on this host (a one-time
  `setcap` so it can bind 80 and 443, the Caddyfile, then `caddy run`), Tailscale Funnel (a
  one-time `tailscale set --operator`, then `tailscale funnel --bg --https=443`, with a note that
  it is a preview until Funnel is confirmed to pass visitor addresses and live updates), or a
  Cloudflare Tunnel (create and route, `config.yml`, run). Each step says whether it needs root.
  The nginx and Caddy snippets set `X-Forwarded-For` to the one client address the front saw;
  Funnel sets its own, which its preview note covers. A tunnel's `config.yml` can't set a header,
  so the Cloudflare Tunnel guide carries a preview note instead: it relies on the tunnel's `X-Forwarded-For` ending with the visitor's
  address, which isn't confirmed yet, and until it is, every visitor may share one rate limit.
  Sova never runs these steps and never writes the front's configuration.
- **Verify** checks the effective address as it is now: it fetches `<address>/api/h/<random
  token>` and passes only on the share app's own answer for an unknown link, 404 with JSON `code:
  "not-found"` and `X-Content-Type-Options: nosniff` (the page shell answers 200 for any token, so
  it can't tell Sova from another server). The address must be `https` with no path, query or
  login, or nothing is fetched; a redirect fails ("the front must forward, not redirect"), and it
  gives up after 8 seconds. With a preview address it also checks a random preview host
  (§mesh.public/preview-address). A pass writes `verifiedAt`; a failure drops it and the address reads
  `unreachable` until a Verify passes. With no address it answers "No public address is set."

## §mesh.public/front-cdn — A web server behind a CDN

- The existing web server's guide also covers a CDN or proxy that terminates TLS for the public
  hostname in front of that server, such as Cloudflare's proxy. The server then listens on the
  port the CDN connects to, not 443 with a certificate of its own. Without more, X-Forwarded-For
  would carry the CDN's address. So the note says to restore the visitor's address first with
  nginx's realip module: `set_real_ip_from` for each of the CDN's published ranges, and
  `real_ip_header` for its client-address header (`CF-Connecting-IP` for Cloudflare). The note also
  says never to forward that header unchecked, because anyone who reaches the server directly can
  set it.
- The Caddy guide carries the same case as a note: behind a CDN, `{remote_host}` is the CDN's
  address, so add a global `servers` block with `trusted_proxies static` and the CDN's published
  ranges and `client_ip_headers` with its client-address header (`CF-Connecting-IP` for
  Cloudflare), and forward `{client_ip}` in place of `{remote_host}`.

## §mesh.public/registry — Which host minted a token

- **Push.** A routed host sends its gateway its whole live set as a `RegistrySnapshot`, `PUT
  /api/peer/share-gateway/links` `{v: 1, seq, links: {h, exp, kind: "h" | "i" | "s" | "x" | "p"}[],
  assets, ingressPort}`: every hand-off, owner and session share link not revoked or expired, as
  the lowercase hex SHA-256 of its token, and the names in its own share build's `assets/`.
  Session links (`s`) go only to a gateway target whose own info listed `s` in `kinds`: an older
  gateway rejects a snapshot with an unknown kind whole, which would block that update and every
  new h and i link in it. The statement binds to that exact target (route generation and peer
  entry): a changed entry or route, an info call the gateway doesn't answer, an info that says it
  is no gateway, or a `bad-snapshot` refusal of a snapshot with `s` rows drops it, and the h/i
  set is sent again at once without them. The gateway coming back up drops nothing: it is asked
  again at once, and the statement in effect (so the preview address too) stays until an answer
  replaces it, which a restarted gateway's info does. It is judged again right before a snapshot
  with `s` rows goes out. Preview links (`p`,
  §mesh.public/preview) follow the same rule with `p`: a gateway that doesn't list it gets no `p`
  row, and a preview mint through it is refused as `gateway-old`. Until the target
  states `s`, a session link mint carries the `gateway-old` warning; when a later info states
  it, the session rows are sent without waiting for a mint. A mint that makes several links
  (one per recipient) is confirmed only when each of its own hashes was sent and accepted; an
  extension of links' expiry is no mint. It sends on every mint and
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
  (4802 by default). It serves exactly the share listener's paths, `/ws/h` and `/ws/s`, with the same edge
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
- **Kinds bind routes.** An `h` row serves `/h`, `/api/h` (its photo upload and photo reads
  included, §app.baton/images) and `/ws/h`; an `i` row serves `/i` and
  `/api/i`; an `s` row serves `/s`, `/api/s` (its image route included) and `/ws/s`; a `p` row
  serves only its own preview host, every path and websocket on it (§mesh.public/preview-address);
  an `x` row never routes. A socket's kind comes from its path.
- A hop dials a literal tailnet address verified to belong to the row's StableID (from Tailscale's
  status, at most 5 seconds old, or the pinned address in address-identity mode), never a name, at
  the row's ingress port. Authorization is judged again after each wait and for as long as a hop
  stays open: a hop whose host no longer holds the hash (setting gone, peer removed or not
  accepted, row withdrawn or expired, port or address moved) is closed, checked on every registry
  commit, setting change and each second. One exception: a `/ws/h` or `/ws/s` hop whose own host
  withdrew the row first waits up to 3 s for that host's own close (§mesh.public/withdrawn-hop). A
  hop is tried once; a POST is never retried or replayed. At most 256 HTTP hops and 256 socket hops
  (`/ws/h` and `/ws/s` together, 4 per link) are open at once.
- A hop's answer passes through without cookies or `x-sova-*` headers and always with
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `nosniff`. A `p` hop is the
  exception: its answer (redirects, 502s and cookies included) passes as the minting host sent it,
  minus hop-by-hop and `x-sova-*` headers, with a preview's limits (§mesh.public/preview-limits),
  and its websocket is passed through raw. A hopped `h` photo read is capped at 10 MB while
  streaming, as a session share's image is. The minting host keeps
  its per-token limits, visits and CSP.
- `/ws/h` and `/ws/s` through a hop: the page's handshake is checked first (400 otherwise); the page is
  accepted only after the host's side opened and the route was judged again (404 otherwise). The
  page's messages keep the 1 KB cap before anything is forwarded; the host's messages to the page
  aren't capped by it. The origin's own closes (1000, 4000, 4410) and statuses (404, 410, 429) pass
  through as they are.
- A hashed `/h/assets/<name>` comes from the gateway's own share build first, else from the first
  live host whose snapshot listed the name, typed by its extension (js, css, woff2, svg, png; any
  other is never fetched), capped at 5 MB while streaming.

## §mesh.public/withdrawn-hop — A link its own host withdrew

- The gateway may see a hash leave the registry while its host stays live and accepted, because
  that host's newer snapshot no longer lists it (revoked or expired). Open `/ws/h` hops on that
  hash (and `/ws/s` hops alike) are then not cut at once. The gateway stops passing on the page's messages, and waits up to
  3 seconds for the host's own close. That close passes through as it is: after a revoke, 4410
  gone, so the page says the link is no longer active, not that it is reconnecting. Only when no
  close comes in time does the gateway close the page's socket with 4503.
- A hop that loses its route any other way closes at once, as before. Other ways include the
  gateway setting going away, the peer being removed or no longer accepted, or the row moving to
  another port or host.

## §mesh.public/offline — A known link whose host is down

A registered hash whose host is down, has no verified address, refuses the gateway, answers 502 or
504 or a redirect, or sends no response headers within 15 seconds:

| Request | Answer |
|---|---|
| Page shell `/h/<t>`, `/i/<t>`, `/s/<t>` | 503 static page that names no host and repeats no token; `Retry-After: 60`, `no-store`, `no-referrer`, `nosniff`, the share page's CSP |
| `/api/h/…`, `/api/i/…`, `/api/s/…`, POST included | 503 `{error: "offline", retryAfter: 60}`; the body is dropped, never buffered or replayed |
| `/ws/h` or `/ws/s` upgrade | 503 |
| A live `/ws/h` or `/ws/s` hop whose host goes away | Close 4503 |
| An asset whose source fails | 503 |
| An unknown hash | 404, never asked of any host |
| A preview host (`p`) | As above for its host being down; its own answers are §mesh.public/preview-offline |

A hop that dies after its headers went out is cut, never passed off as a whole answer. The share
page shows "Reconnecting. Your draft is kept." while offline and reconnects, backing off from 5 to
60 seconds; a message refused with 503 stays in the composer with "Not sent. The page is offline;
your message is still here.", never resent on its own. The owner page keeps what it shows and
reads again. Copy: §design.copy-deck/public-links.

## §mesh.public/forwarded-for — The client address

- The gateway's share listener keys its per-address limit on the last `X-Forwarded-For` hop only
  when the connection comes from loopback (its front); from any other address, tailnet included,
  it uses the socket address. A value that isn't an IP literal falls back to the socket address.
  `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`, `Tailscale-*` and `x-sova-*` are
  never read.
- On every hop the gateway first strips every incoming `Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
  `CF-Connecting-IP`, `True-Client-IP`, `Tailscale-*` and `x-sova-*` header (any case), the
  hop-by-hop headers and every header named in
  `Connection`, then sets exactly one `X-Forwarded-For` (the client address it computed),
  `X-Forwarded-Proto: https` and `X-Forwarded-Host` from its configured public URL, never from the
  incoming `Host`. A preview hop also sets `x-sova-preview: <label>` from the preview host it
  matched; the minting host then sends the app none of these (§mesh.public/preview-proxy), except
  its own `X-Forwarded-For` (that client address) and `X-Forwarded-Proto` when its **Send the
  visitor's address to preview apps** switch is on (§mesh.public/visitor-log).
- A routed host's ingress believes `X-Forwarded-For` only on a connection its gate admitted, and
  only a single value; otherwise it keys on the socket address. No other tailnet device can choose
  its own rate-limit key.

## §mesh.public/panel — Settings → Public links

A Settings tab of its own, **Public links**, after Mesh (§app/settings-dialog). It works with the
mesh off. Copy is §design.copy-deck/public-links.

- **Top to bottom:** the title with the state chip (`Off`, `Not verified` warn, `Verified` success,
  `Unreachable` error, or `Not listening` error while the share port won't open,
  §mesh.public/listener-failure), the line, then the **Address** row: the effective address in mono and its
  source (`Set by environment ({var})`, `From this setting`, `From {gateway}`, `Bound address`), or
  `None`. Then **Where links open**, radios: `Off`, `This host is the gateway`, and one `Through
  {gateway}` per peer advertising a gateway (a saved gateway no longer advertised keeps its radio),
  each with its hint. Then **Visitor logging**, whatever the route: two checkboxes, **Log
  visitors** and **Send the visitor's address to preview apps**, each with its hint
  (§mesh.public/visitor-log). The route's own fields follow.
- **This host is the gateway:** Public address, Preview address (optional, `https://*.<domain>`,
  §mesh.public/preview-address), Front (the four front labels), Local port, Accept
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

## §mesh.public/listener-failure — A share port that won't open

- When this host should bind its share listener (it is the gateway, or `SOVA_SHARE_HOST` and
  `SOVA_SHARE_PORT` are both set) and can't, the share state carries `listener: {host, port,
  reason}` beside its other fields, which stay as they were: the port is taken, the host doesn't
  allow it, the address isn't one of this host's, `SOVA_SHARE_PORT` isn't a port number (`port` is
  then null), or any other error opening it. `reason` is one sentence naming the cause. A later bind that succeeds, or a setting
  that binds nothing, clears it; the server log still says so either way.
- A `PUT /api/public-links` answers after the rebind it caused settles, so its answer carries the
  bind as it came out.
- In Settings → Public links the state chip reads `Not listening` (error) in place of the others,
  the Mesh card's Public links chip (while a route is on) takes the error tone, and an error banner under the Address row
  says "The share port isn't open." with the reason. Copy: §design.copy-deck/public-links.

## §mesh.public/preview — Preview links

- A **preview link** (registry kind `p`) publishes one web app running on a loopback port of the
  host that minted it, at the root of an origin of its own: `<label>.<zone>`, where `<zone>` is
  the preview address (§mesh.public/preview-address) and `<label>` is the link's secret, 52
  lowercase base32 characters (32 random bytes, 256 bits). Every route, redirect, cookie, fetch,
  websocket and deep-link reload of the app works through it as it does on `localhost`, and two
  previews are two separate sites.
- `<stateRoot>/preview-links.json` (0600, written atomically, parsed strictly: a file that breaks a
  rule serves no preview and is never overwritten) keeps, per link, `{id, hash, orgId, projectId,
  port, createdAt, expiresAt, revokedAt?, createdBy, siblingOf?, sentTo?}`, where `hash` is the
  SHA-256 of the label and `createdBy` is `operator` or `session:<id>` (the project overseer's
  conversation, §app.project-overseer/previews). A **sibling** (`siblingOf`, `sentTo`) is a person's
  own link to another preview, made when it is sent to them (§app.outreach/links): same project and
  port, expiring with it; its label is never stored, and the send carries its link once.
- **What else a preview has** is kept beside it, in `<stateRoot>/preview-kept.json` (0600, written
  atomically, host-local, never synced or committed), per preview id: its link, its target (`port`,
  or `static` with the folder Sova serves, §mesh.public/preview-serve), the coding session and
  branch it shows, and its purpose, each only when known. It is read tolerantly: a file that
  can't be read keeps no link and serves no folder, and every preview still opens. The link is a
  secret kept for the operator: the project overseer never sees it, and names a preview by its id
  (§app.project-overseer/previews). A preview made before this file existed has no kept link, only
  its hash: its link was shown once, when it was made, and is never guessed. A sibling has no entry
  of its own: it shows its original's target, session and purpose.
- **Mint** (`POST /api/previews {orgId, projectId, port | folder, sessionId?, purpose?, days?}`,
  main listener only, like the other local acts): exactly one of `port` and `folder`. `port` must
  be an integer 1–65535, not 4800, 4801, 4802 or 4810, and not a port this Sova process binds, its
  settings name (main, peer, share, ingress) or it serves a folder preview on. A `folder` is
  served by Sova itself (§mesh.public/preview-serve) and needs `sessionId`, the coding session of
  the project whose worktree holds it. `purpose` is one line, at most 200 characters. `days` is 1
  by default and at most 30. With no preview address it is refused with a named reason, and no
  link is made: `no-address` (none set here or on the gateway) or `gateway-old` (the via gateway
  doesn't list kind `p`: "{gateway} needs updating before it can carry preview links."). The
  answer carries the link, and the link is kept.
- The app is always dialed at `127.0.0.1:<port>`, then `[::1]:<port>` when nothing listens there,
  and never at any other address.
- **Turn Off** (`POST /api/previews/<id>/off`) revokes it, and every sibling of it: from then on its origin answers 410,
  and every open HTTP connection and websocket through it is closed at once. The same happens
  when it expires. **Extend** (`POST /api/previews/<id>/extend {days}`) moves its expiry to `days`
  from now (at most 30; a sibling's, never past its original's). `GET /api/previews?orgId&projectId`
  lists a project's previews (every project's without them) with each one's port, target, expiry,
  state and whether something listens on its port now (`running`; for a folder, whether Sova
  serves it now), its kept link (`url`, null when none is kept), purpose, coding session and branch
  (a recorded one, else the one matched by its worktree, §app.project-overseer/previews), with the
  preview address's state; a sibling carries `siblingOf`, `sentTo` and `sentToName`, and the lists
  name it on its original's **Sent to** line, or as "sent to {name}" on a row of its own when its
  original isn't listed (§mesh.public/preview-card).
- A routed host sends each live preview's hash as a `p` row (§mesh.public/registry) only to a
  gateway target whose own info listed `p`; its gateway routes the preview host to its ingress
  (§mesh.public/routing).

## §mesh.public/preview-proxy — What the app sees and what the visitor gets

- Toward the app, the minting host sends the request as a browser on this computer would: `Host:
  localhost:<port>`; an `Origin` equal to the preview's public origin becomes
  `http://localhost:<port>`, and so does the origin part of a `Referer` on it. Every
  `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `CF-*`, `True-Client-IP`, `Tailscale-*` and
  `x-sova-*` header and the hop-by-hop ones are removed, and none is added, except the
  `X-Forwarded-For` and `X-Forwarded-Proto` the host's **Send the visitor's address to preview
  apps** switch adds (§mesh.public/visitor-log). Cookies (less the proxy's own `__Host-sova-pv`),
  bodies, methods and the raw path and query pass through as they came.
- Toward the visitor: an absolute `Location` or `Access-Control-Allow-Origin` on
  `http(s)://localhost|127.0.0.1|[::1]:<port>` is rewritten to the public origin; each
  `Set-Cookie` loses only its `Domain=` attribute, so cookies stay on the preview's own host;
  `Cache-Control` becomes `private` (a `public` or `s-maxage` is dropped, and `private` is added
  when neither `private` nor `no-store` is there) so no CDN keeps an app response past Turn Off;
  and `Referrer-Policy: same-origin` is added when the app sent none; while the host logs visitors,
  a page load that came without the proxy's `__Host-sova-pv` cookie also gets that cookie
  (§mesh.public/visitor-log). Response bodies are never read or rewritten, and both directions
  stream.
- A websocket upgrade is passed through byte for byte after the same request headers, so its
  subprotocols, extensions and frames (any size) are the app's own.
- An app response carrying any `x-sova-*` header is never passed on (it is a Sova port under
  another number): the visitor gets the 502 not-running answer.

## §mesh.public/preview-limits — A preview's own limits

The share host's limits (§app.baton/share-listener) stay as they are. A preview host has its own:
1,200 requests a minute per client address per preview (429), request bodies streamed with a
25 MB cap (413 before anything is sent when declared larger, else the connection is cut), 60
seconds for the app's response headers (504), and at most 64 HTTP requests and 16 websockets
open per preview and 256 of each across all previews (503).

## §mesh.public/preview-offline — What a preview visitor sees

Static answers that name no host, port or token; the app's own CSP is never replaced.

| Case | Answer |
|---|---|
| Nothing listens on the port (both loopbacks refuse) | A navigation: 502 page "This preview isn't running right now. It will open here once the app is started again.", reloading itself every 10 seconds, `Retry-After: 10`, `no-store`. Any other request: 502 text. A websocket: 502 |
| The minting host is down or its hop fails | The offline 503 (§mesh.public/offline) |
| Turned off or expired | 410 "This preview link is no longer active." with `Clear-Site-Data: "cache", "storage"`, `no-store` |
| Unknown label | 404 "This preview link isn't active." (JSON `{error, code: "preview-not-found"}` for a request that isn't a navigation), `no-store`, `nosniff` |

A gateway remembers, in memory, the `p` hashes a live host withdrew from its snapshot until they
would have expired, and answers them 410 too.

## §mesh.public/preview-address — The preview address

- The gateway's setting gains an optional `previewUrl`, written `https://*.<host>`: one wildcard
  label over a host of at least two labels, with no path. `SOVA_SHARE_PREVIEW_URL` pins it (an
  `http` or `https` address of that shape; any other value is ignored with one warning) and
  appears in `pinnedByEnv`. A routed host takes it from its gateway's info, which carries
  `previewUrl` only when asked with `?kinds=1&preview=1` (an older routed host parses the info
  strictly).
- The share listener splits by `Host` before its path allowlist: a `Host` that is exactly
  `<label>.<zone>` of the preview address, with a well-formed label, goes to the preview, whose
  raw request target passes byte for byte; any other `Host` keeps the share host's allowlist, so
  `/h/`, `/i/`, `/s/` and `/api/*` are never reached on a preview host and no preview is reached
  on the share host. A routed host's ingress takes the preview only from a `x-sova-preview:
  <label>` header its admitted gateway set after stripping every incoming `x-sova-*`, never from
  the `Host`.
- The front guide, when a preview address is set, adds the wildcard name to the front's server
  (nginx `server_name <share host> *.<zone>;`, a Caddy site for `*.<zone>`, a tunnel ingress rule
  for it) and notes: a one-level wildcard catches every undefined subdomain of the domain, while
  explicit DNS records (like the share host's) still win; a CDN's free certificate covers one
  wildcard level; never issue a certificate per preview name (Certificate Transparency logs
  publish every name, and so every token); update the gateway before adding the wildcard DNS
  record.
- **Verify** also fetches `<scheme>://<random label>.<zone>/` and passes it only on the preview
  404 (`code: "preview-not-found"`, `nosniff`); its result is `preview` beside the share check.

## §mesh.public/preview-card — Previews on the project page

- The project page has a **Previews** card: one row per active preview, where a person's own link
  (a sibling, §mesh.public/preview) is not a row of its own but a recipient of its original's row.
  The row's title is its purpose, else "Preview of port {n}" or "Preview of {folder}" ("the
  worktree" for the worktree itself). Under it, on one line that wraps only when it must: its
  coding session's title (a link to that session) · its branch in mono, cut to one line with the
  whole name on hover · what it serves ("app on port {n}" or "static files") · "Matched by the
  app's folder" when the session was matched now by the listener's worktree rather than recorded
  (§app.project-overseer/previews) · a state chip, `Serving` (success) when the app answers on its
  port or Sova serves its folder, else `Nothing on port {n}` or `Folder not served` (warn) · who
  made it ("Made by you", or "Made by the overseer", a link to that conversation) · "Expires in
  {time}", each part only when known. Then **Copy Link** ("Link copied.") when a link is kept or
  this page just minted it, else, for an original only, the line "Link shown only when it was
  made."; and **Turn Off** (a second click confirms: "Turn Off Preview?", or "Turn Off All {n}
  Links?" counting the preview and its listed recipients when it has any; its tooltip says it
  turns off the preview and every link sent from it; done: "Preview turned off.").
- A row with active siblings has a **Sent to** line under it: each recipient's name (else "a
  person"; its tooltip says who sent it, "Sent by you" or "Sent by the overseer") with its own small **Turn Off** (tooltip "Turns off only {name}'s link."; a second
  click confirms: "Turn Off {name}'s Link?"; done: "{name}'s link turned off."), which turns off
  only that person's link. A sibling whose original is not listed (turned off, expired or gone)
  keeps a row of its own, with "sent to {name}" among its parts, no Copy Link and no "Link shown
  only when it was made." line. Turned-off and expired previews are not listed. Below 480px each
  row stacks its lines above its buttons, which share the row's width, and a long title or folder
  wraps instead of widening the page.
- Then a **New Preview** button, which opens the form in place: Port, Expires (1, 7 or 30 days),
  an optional Purpose (at most 200 characters, sent only when not blank), the warning "Anyone with
  this link can use the app on port {n} as if they were on this computer, including its logins,
  admin pages and anything it can change.", **Create Preview** and **Cancel** (closes it). A
  refused mint shows its reason on the form; a made one closes it. With no preview address the
  card says so and how to set it, and offers no New Preview.
- The Shares page lists this host's live previews the same way, one row per original with the
  project, port, expiry and Turn Off, its recipients on a **Sent to** line each with its own Turn
  Off, and a sibling whose original is not listed on a row of its own. A preview with recorded
  visits (§mesh.public/visitor-log) gets a **Visits** disclosure under its row, and a recipient
  with visits one beside their name.

## §mesh.public/preview-serve — A preview of a folder, served by Sova

- A preview's target may be a **folder** instead of a port: a folder inside the worktree of one of
  the project's coding sessions on this host (§app.project-overseer/coding-worktrees), judged at
  its real path, with no part of it below the worktree starting with a dot. Sova serves it itself
  on `127.0.0.1:<port>`, a free port it picks at the mint and records as the preview's `port`
  (§mesh.public/preview), and the preview dials that port like any other. Sova never starts,
  stops or restarts a program for a preview: a port preview shows what a coding session already
  serves, and whoever runs that app starts it again when it stops ("Nothing on port {n}").
- **Files only, inside the folder.** It answers only `GET` and `HEAD` (any other method: 405). The
  path is judged raw and after decoding, segment by segment: a segment that starts with `.` (a
  dot-file or dot-folder, `.git` and `.sova` included, `.` and `..`), an encoded `/` or `\`, a
  backslash or a NUL answers 404; so does a path whose real path (every symlink resolved) is
  outside the folder or passes through such a segment, anything that isn't a regular file, and
  everything while the folder itself is missing. A
  folder is never listed: it serves the folder's `index.html` when there is one (a folder asked
  for without its trailing slash is redirected to it first, so relative links work), else 404.
- **Its answers.** `Content-Type` by the file's extension (the web's page, script, style, data,
  image, font, audio, video, wasm and pdf types; any other `application/octet-stream`),
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache` (a 404 `no-store`), no `Server`
  header, and never an `x-sova-*` header. A 404 is plain text, "Not Found", naming no path.
- **While it is active, and only then.** Turn Off closes its listener at once; an expired one's
  closes within a minute. At startup Sova binds each active folder preview again on its recorded
  port; when that port is taken it serves nothing there and logs it (never the link). The preview
  proxy dials a folder preview's port (a person's sibling of it too, §app.outreach/links) only while
  Sova itself serves that folder on it, so another
  program that took the port is never shown: the visitor gets the not-running page
  (§mesh.public/preview-offline).

## §mesh.public/visitor-log — Who opened this host's links, with their address

- **Two host-wide switches, both off by default**, in `<stateRoot>/visitor-logging.json`
  `{version: 1, logVisitors, forwardIp}` (0600, written atomically, host-local, never synced or
  committed). A missing file, or one that isn't exactly that shape, reads as both off. `GET` and
  `PUT /api/visitor-logging {logVisitors, forwardIp}` answer on the main listener only, like the
  public links setting. Settings → Public links shows them as two checkboxes after the route,
  staged and written by Save Changes like its other fields: **Log visitors** ("Records each
  visitor's IP address, browser, language and pages opened on this host's links.") and **Send the
  visitor's address to preview apps** ("Preview apps get X-Forwarded-For."). Off means nothing
  below is written and no address is sent.
- **Log visitors** covers every link this host minted: hand-off (`/h/`), owner (`/i/`), session
  share (`/s/`) and preview links. Each time the visit log records or continues a visit
  (§app.baton/visits), Sova appends a line to `<stateRoot>/visitor-identity.jsonl` (0600,
  host-local, never synced or committed) `{id, at, ip, ua, lang?, referer?, path?}`: `id` the
  visit's id in its visit log, `ip` the client address as the share edge computed it
  (§mesh.public/forwarded-for), `ua` the raw user agent (at most 512 characters), `lang` the
  `Accept-Language`. A `/h/`, `/i/` or `/s/` visit gets one line per address and user agent (each
  run of Sova); a preview visit one line per page load (at most 200 a visit each run), with its
  path (no query) and, when the page came from another site, that `Referer`'s origin only (a path
  can carry someone's token). A host under the preview zone is never another site. Never written there or anywhere: the token, the preview
  label, any hash of either, `Host`, cookies or `Authorization`; a value that would carry the
  preview's own origin is left out. The identity never goes into an org's `visits.jsonl`.
- **Preview visits.** While Log visitors is on, a page load (a navigation, as the preview's own
  pages judge it) through the minting host's proxy is recorded in
  `<stateRoot>/preview-visits.jsonl` (0600, host-local) by the rules of §app.baton/visits, its
  lines carrying `via: "preview"` and `previewId`. The tab is the proxy's own first-party cookie
  `__Host-sova-pv` (22 base64url characters, `Path=/; Secure; HttpOnly; SameSite=Lax`, no
  expiry), set on a navigation that came without one; the app never sees that cookie, on HTTP or
  a websocket, whatever the switch. A sibling's visits are its own preview id's, so they name the
  person it was sent to.
- **Retention.** At startup and once a day, lines of `visitor-identity.jsonl` and
  `preview-visits.jsonl` older than 120 days are dropped (the file is rewritten atomically).
- **Send the visitor's address to preview apps:** after its strip (§mesh.public/preview-proxy),
  the minting host's proxy sends the app exactly one `X-Forwarded-For: <client address>` and
  `X-Forwarded-Proto: https`, on HTTP and websocket upgrades, never `X-Forwarded-Host`.
- **Who reads it.** Only the operator, on the Shares page (§app.session-share/shares-page): each
  visit there shows its address, browser (the raw user agent on hover), language and, for a
  preview, its pages. It never reaches the project overseer's tools, a peer other than through
  that page's own read, or a model prompt.
