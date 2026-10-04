# §mesh/lan — Dial-out hosts and relays
> Part of the Sova design spec · [overview](../design/overview.md)

A Sova host that is not on the tailnet (a **dial-out host**: a laptop, a machine behind NAT) can still
be a peer. It dials OUT, over mutually pinned TLS, to each host it is paired with (a **relay**: a
host on the same local network, or a host on the internet such as a VPS). Nothing listens on the
dial-out host, anywhere. A relay on the internet never runs the public handshake inside Sova: a
separate, unprivileged **accept process** under its own system user owns the public port, checks
the dial-out host's pin there, and hands each verified connection to Sova over a unix socket, and
Sova then runs its own pinned TLS with the dial-out host inside that connection
(§mesh.lan/accept-process), so the accept process only ever carries ciphertext. A dial-out host
dials a public relay only for a pairing marked as one on the internet; every other pairing, on
both sides, stays on local-network addresses. Both hosts then treat each other as peers like any other: each one's requests reach the
other through the other's peer gate and are held to the other's grants (§mesh.peers/grants), so a
new pairing sees nothing until granted more than presence. Unlike a tailnet peer
(§mesh.peers/allowlist, §mesh.peers/listener), a dial-out pairing is named by its key's pin, never by
a Tailscale identity, and its calls never touch the tailnet listener.

## §mesh.lan/identity — Each host's key, and its pin

- A host's identity for these pairings is one ECDSA P-256 key with a self-signed X.509 v3
  certificate that Sova builds itself: subject and issuer `CN=` followed by 16 random hex digits
  (nothing names the device, its user or Sova), a random positive 16-byte serial, valid from
  2000-01-01 to 9999-12-31 (rotation is by re-pairing, so clock skew never matters), and one
  critical extension, basicConstraints CA:FALSE. No library ever verifies the certificate: it only
  carries the key.
- It is kept in `<state root>/lan-identity.json` (mode 0600, written atomically, never synced) and
  made only when the user asks for it on the Mesh page (Make Fingerprint) or adds a pairing. With
  no pairing and no such request, nothing is made, listened on or dialed.
- A host's **pin** is the first 128 bits of the SHA-256 of its key's SubjectPublicKeyInfo, shown as
  8 groups of 4 upper-case hex digits (`ABCD-EF01-…`). Pairing moves pins only, never a secret. A
  pin is typed or pasted in any case, with or without the dashes or spaces; anything that isn't
  exactly 32 hex digits is refused.
- A private key never appears in a log line, an error message, a status or a response.
- An internet relay's accept process has its own key of the same kind (its **outer** key), made
  by that process in its own state directory (mode 0600), which Sova can't read and never holds.
  Sova's own key stays this host's identity: it is the pin the dial-out host pairs with, and the
  accept process never holds it. The outer key is pinned by nobody, and changing it needs no
  re-pairing.

## §mesh.lan/handshake — Both sides pin each other, before any request

- TLS 1.3 only (1.2 and below are refused both ways), and no resumption: the dial-out host never
  offers a session, the relay never resumes one (Node's TLS may still send it a ticket; presenting
  one gets a full handshake), and a connection that reports a reused session yields no pin and is
  dropped.
- The pin compare stays synchronous in the handler that first sees the finished handshake, nothing
  reads the connection before it, and the dialer is never given a session to resume: these keep "no
  byte before the pin" true.
- No certificate chain is trusted on either side. The dial-out host compares the relay's pin as soon
  as its handshake completes, before it writes anything; the relay compares the dial-out host's pin
  as soon as its handshake completes, before it reads anything. A missing certificate, a different
  key (including a certificate the pinned key itself issued to another key), or a TLS-inspecting
  middlebox ends the connection there, with no byte of a request sent or read. Nothing ever falls
  back to an unpinned connection.
- Host names and addresses are never checked, and no SNI is sent: the pin is the identity, the
  address only where to dial.
- Two channels share the relay's port, told apart by ALPN tokens that name nothing (`pa/1` and
  `pq/1`): on the **answer** channel the relay asks and the dial-out host answers; on the **ask**
  channel the dial-out host asks and the relay answers.
- Accepted residuals: the tokens are fixed, so an observer can tell this traffic from HTTPS; and the
  dial-out host's certificate (its stable pin) reaches whatever answers at the relay address before
  the dial-out host has checked that answer, so an impostor there can recognise the host, though it
  gains no access.
- For a pairing with an internet relay, two such handshakes are nested on one connection. The
  **outer** one runs between the dial-out host and the relay's accept process: the dial-out host
  presents its own certificate and offers the channel's token, and doesn't check the accept
  process's certificate; the accept process compares the dial-out host's pin against the pairings
  Sova gave it, before it reads anything. The **inner** one runs inside it, end to end between the
  dial-out host and Sova itself, and is exactly the handshake above (TLS 1.3 only, no resumption,
  both pins compared synchronously before any byte, the same channel token). The dial-out host
  writes nothing of its own until the inner pin matched the relay's, and Sova reads nothing of a
  request until the inner pin matched both a pairing it accepts and the pin the accept process
  vouched for, on the channel it vouched for. So the accept process carries only ciphertext: if it
  is compromised it learns when and from where a pairing connects and can cut connections, and it
  can neither read, change nor inject a request, nor pass for either side.
- A handshake that never completed is never taken for one that did: a connection that reports
  anything but TLS 1.3 with a channel token and a certificate yields no pin, whatever event
  announced it (on Bun, a nested client handshake whose carrier closed still reports itself as
  finished).

## §mesh.lan/pairing — Pairing on the Mesh page

- The Mesh page's Dial-out pairings card shows this host's fingerprint (with Copy Fingerprint), this
  host as a relay (its address and port, where it is reached from, and whether it listens now and for
  how many dial-out hosts), and each pairing: what it is (relay
  or dial-out host), its fingerprint, a relay's address (marked as on the internet for such a
  pairing), and one state for both its connections:
  connected, connecting, reconnecting (with the reason and the seconds to the next try), half
  connected, or not connected (for a dial-out host that never dialed in, said so). Fingerprints and
  addresses wrap, never cut off. A pairing with an internet relay that keeps failing as "timed out"
  also says the network it is on may block the relay's port.
- The relay form's "Reached from" offers "A local network" and "The internet". "The internet" can be
  chosen only while this host's accept process is running; otherwise it is disabled, with why (not
  set up, not running, or an older version that restarts itself). Choosing it says, before saving,
  what it means: the port is open to the whole internet (the accept process, not Sova, answers it),
  whoever controls this host can reach every dial-out host paired with it as far as each one's grant
  to it allows, wherever that host roams; with port 443 it also says that this host's public share
  front may already hold that port. While this host relays on the internet the card also shows the accept process's state and
  its counts, and a warning, kept until Sova restarts, if the accept process ever vouched for a host
  the connection didn't prove.
- Pair a Host takes what the other host is (a relay this host dials, or a dial-out host that dials
  this one), its fingerprint, a name and optional label, a relay's address and port, whether that
  relay is on the internet, and what it may
  see here. On the dial-out host the user adds the relay; on the relay, the dial-out host. Each side
  pastes the other's fingerprint and checks it by eye; this host's own fingerprint is refused. A
  pairing is also a host in Hosts, where its grant is changed like any peer's. Checking "This relay
  is on the internet" says what it means before the pairing is saved: this host keeps a connection
  open to that server from every network it joins, so whoever controls that server can reach this
  host as far as this host's grant to it allows; some networks block the port or inspect TLS, and
  then the relay is unreachable there (the pin never falls back); and a work machine's policy may
  forbid such a connection.
- A pairing is a peer in `peers.json` with a `lan` link: `dial` (this host dials it: address and
  port, and `internet: true` for a relay on the internet, which only a `dial` link may carry) or
  `accept` (it dials this host). Its node id is `lan:` followed by the pin in lower case; a
  tailnet peer may not use that prefix, and a tailnet identity carrying it is refused. A pairing has
  no browser address: it is never a front-door upstream, never a share gateway or routed host, and
  never the target of a resync. Its count of LLM calls in flight isn't shown.
- A pairing keeps the name the user gave it on this host: a rename the pairing sends of itself
  (`/api/peer/label`) is answered as taken but changes nothing here, so a pairing at presence can't
  take the name of a trusted host. Any host name a peer sends loses control characters and bidi
  overrides before it is kept.
- A host whose only peers are pairings runs no tailnet listener and never asks Tailscale for anything.
- A new pairing is granted presence on the host that adds it, unless the form says otherwise. The
  grant is written before the pairing: if it can't be written, nothing is paired, and if the pairing
  then can't be saved, the grant is taken back.
- A pairing's grant fails closed. Unlike a tailnet peer (which keeps `full` with no grants file or no
  entry, §mesh.peers/grants), a pairing with no entry in `mesh-access.json`, or with no such file at
  all, has presence, never `full`; a file that can't be read gives it hello only, as for every peer.
  Clearing a pairing's grant on the Mesh page (`PUT /api/mesh/access` with `grant: null`) leaves it at
  presence, and the page shows presence as what it has.
- The relay listens for dial-out hosts only while it accepts at least one, on the one address and
  port the user gave. For a relay reached from a local network (exposure "LAN", the default), that
  address must be an IP literal that is loopback (127/8, `::1`), private
  (10/8, 172.16/12, 192.168/16, fc00::/7) or link-local (169.254/16, fe80::/10, which may carry a
  zone); an IPv4-mapped IPv6 address is judged and kept as its IPv4 address. Every spelling of "every
  interface" (`0.0.0.0`, `::`, `0::0`, `::ffff:0.0.0.0` and the like) and every public address
  (global IPv6, carrier-grade NAT and tailnet addresses included) is refused, whether it comes from
  the page, `PUT /api/mesh/lan/relay` or a hand edit of `peers.json` (a `peers.json` holding one
  turns the mesh off, as any invalid file does). Saving from the page or the API also refuses an
  address that is not one of this host's interfaces. Sova's own listener refuses to start on any
  other address, and Sova never listens on a public address itself. A misbehaving address on a LAN
  relay is banned for 5 minutes. A private address the network
  forwards from the internet (a port forward, a cloud NAT) is outside what Sova can see: the
  operator's firewall must not do that, unless the relay is an internet one.
- A relay reached from the internet (exposure "internet") gives one IP literal of this host, public
  or private (behind a cloud's one-to-one NAT), never every interface, a multicast or a broadcast
  address. `peers.json` holds such a setting whether or not the accept process runs, so a crashed
  accept process never turns the mesh off. Saving it from the page or the API also needs, at that
  moment, the address to be one of this host's interfaces, `SOVA_RELAY_HANDOFF` to be set, and the
  accept process to be running: connected over its control channel, speaking this protocol, of this
  build, and heard from in the last 30 s; otherwise the save is refused with "the accept process
  isn't running (SUDO.md §5)" and nothing changes. At runtime the internet relay listens only while
  the accept process is running and at least one pairing is accepted; Sova itself never opens a
  public listener, and nothing ever falls back to one, whatever the accept process's state.
- A dial-out host dials a relay only at such an address too: a relay given as a public IP is refused
  when the pairing is saved, and a relay given as a name is dialed only at a loopback, private or
  link-local address the name resolves to (none: the dial fails as "relay address isn't private").
  The one exception is a pairing marked as on the internet: its relay may be any IP literal but
  every interface, a multicast or a broadcast address, or a name dialed at the first such address it
  resolves to. The mark is per pairing, so every other pairing keeps the local-network rule even on a
  host that has an internet pairing.
- Removing the last accepted pairing, or the relay setting, closes the listener. Stopping relaying
  (removing the setting), moving it to another address or port, or switching where it is reached
  from also ends, at once, every live connection of every accepted pairing on both channels, with
  every request and socket inside them, and nothing reconnects until a dial-out host dials the new
  listener. So does losing an internet relay's accept process (its control channel closed or silent
  for 30 s): its connections end at once, and the relay reads as not listening until it is back.
- Removing a pairing, on either side, ends its connections at once, with every request and socket
  in them, and drops its grant.

## §mesh.lan/as-a-peer — A pairing is a peer like any other

- Each side reaches the other the way it reaches any peer, through one dialer: the hello probe and
  status, the session list, `/peer/<id>/` requests and sockets from a browser, details, sync and the
  Claude pool. A relay sends its requests on the answer channel; a dial-out host sends its
  own on the ask channel. A pairing with no live connection reads as down, "not connected".
- Of a pairing's answer that this host parses itself, it reads at most 1 MiB for a hello or details
  probe and 32 MiB for a session list (`SOVA_MESH_LIST_MAX_BYTES` sets another); a longer answer is
  cut there and fails like an unreachable host.
- Every request a pairing makes goes through the receiving host's peer gate exactly as a tailnet
  peer's does: re-checked against `peers.json` on every request, then held to that host's grant to
  it (`denied` when the grant doesn't cover it, §mesh.peers/grants), dispatched with the pairing as
  the caller, and cut when the grant is lowered or the pairing removed. The caller is the pairing of
  the connection, from its pin; nothing inside a request can name another.
- What a host sends a pairing on its own initiative is limited by its grant to it, as for any peer.
- A browser request a host passes to a pairing carries nothing of that host or the browser, whatever
  the grant, as for a restricted peer. The pairing's answer comes back hardened: only the headers a
  page needs (content type, length, disposition and encoding, caching, the date, `Vary` and
  `X-Sova-Mesh`; never a cookie, redirect target, CORS grant, service-worker scope, preload or cache
  wipe), with `Content-Security-Policy: sandbox; default-src 'none'` and
  `X-Content-Type-Options: nosniff`. Only JSON, plain text and raster images (PNG, JPEG, GIF, WebP,
  AVIF, BMP) keep their type; any other body (HTML, SVG, XML, script, PDF, multipart, or none named)
  comes only as an `application/octet-stream` download. A 401 or 407 from the pairing reaches the
  browser as 502, so the page never takes a pairing's answer for its own lock-out.
- A relay never passes one pairing's requests to another host: the peer gate never forwards
  (§mesh.peers/listener).

## §mesh.lan/relay-listener — A relay's listener and its admission limits

- Before any TLS work, each new connection passes admission. It counts per source: an address,
  except that a global IPv6 address counts with its whole /64 (private and link-local IPv6 addresses
  count one by one; an IPv4-mapped address counts as its IPv4 address). Per source: at most 4
  handshakes in progress, at most 10 new connections in any second, and 5 failed handshakes within
  60 s ban that source for 5 minutes; a connection from a banned source is closed before any TLS
  work, and its handshakes in progress are closed when the ban starts. A connection that closes
  before its handshake completes counts as failed.
- A source that completed a paired handshake within the last 24 hours (the last 256 such sources
  are remembered) keeps a reserve: of the 64 connections allowed at once, other sources get at most
  56; it is admitted even while the table of tracked sources is full; and a ban on it lasts 30 s, not
  5 minutes, so another machine failing behind the same NAT can't keep it out.
- At most 4,096 sources are tracked. When the table is full, sources with nothing open and no ban
  and no recent activity are forgotten, then the least recently seen source with nothing open and no
  ban (failures only); only when every tracked source has something open or a ban is a new source
  refused.
- A handshake that hasn't completed in 5 s is closed and counts as failed, as does a pin mismatch.
- The listener records only counts and bans, never what a connection carried.
- An internet relay's listener runs in the accept process, never in Sova, with the same rules at
  internet scale: a ban lasts 15 minutes, up to 16,384 sources are tracked, and at most 64 new
  connections a second from sources that haven't paired recently get to start a handshake (checked
  before any TLS work; recently paired sources are exempt). A pin mismatch there means an unpaired
  certificate: that connection never reaches Sova. Only the accept process may listen on a public
  address; the listener Sova runs itself takes local-network addresses only.

## §mesh.lan/reverse-channel — Requests inside one connection

- On each channel, the side that asks is the HTTP/2 client and the side that answers the HTTP/2
  server, whichever side dialed. Server push is off, and the answering side has no way to open a
  stream: on the answer channel the dial-out host can't make a request, on the ask channel the relay
  can't.
- Every request is an HTTP/2 `CONNECT` stream carrying ordinary HTTP/1.1 or a WebSocket upgrade,
  handed to an HTTP server that never listens on any port. Any other method gets 405, and a CONNECT
  that carries a path, scheme or protocol 400.
- The asking side treats the answering one as hostile: header lists of at most 64 KiB and 128 pairs,
  at most 32 SETTINGS entries, 10 MB of session memory, 10 unanswered pings and 100 concurrent
  streams; a stream not answered within 10 s fails. The answering side caps the asking one the same
  way, and also refuses a session after 10 rejected streams or 100 invalid frames. These hold on both
  runtimes, tested with raw frames from a hostile peer: a request or response whose header list is
  over 64 KiB (Sova measures it itself, because Node passes one through) or over 128 pairs never
  reaches the HTTP server or the caller, a SETTINGS frame with more than 32 entries never takes
  effect, and a SETTINGS flood from a peer that never reads closes the session.
- The HTTP server a stream is handed to never listens, so it has deadlines of its own per stream: the
  request head must arrive within 10 s, a request body within 5 minutes, and a kept-alive stream is
  closed after 30 s idle between requests. A WebSocket stream lives as long as its session.
- Each stream, and each side's HTTP/2 session, runs on a plain stream rather than on the runtime's
  native socket handle. On Node the HTTP/1.1 head is otherwise corrupted inside an HTTP/2 stream,
  and a session on a TLS socket's handle can miss the other side closing.
- WebSockets inside a stream run on the pure-JS WebSocket implementation on both runtimes, with the
  same size cap and handshake timeout as every other socket (§app.server-runtime/quirks).
- Each side pings the other every 30 s; a connection with no answer for 90 s is closed. Ending the
  HTTP/2 session, from either side, ends every stream and WebSocket inside it at once, and the other
  side sees it at once.

## §mesh.lan/dialer — The dial-out host keeps its connections up

- The dial-out host keeps both channels to each relay it dials while that pairing exists, and none
  otherwise. A lost or refused connection is retried after 1 s, doubling to at most 60 s, each wait
  jittered by up to a quarter either way; a connection that stayed up for 30 s resets the wait.
- Each channel's status is one of connecting, connected (once the other side's HTTP/2 settings
  arrived), waiting (with the reason and when the next try is) or stopped. Reasons are fixed phrases
  (refused, timed out, relay's pin didn't match, rejected by the relay, TLS version refused, closed,
  relay address isn't private, accept process refused),
  never raw error text, a pin or an address. A relay that refuses this host's certificate usually
  reads as closed: under TLS 1.3 its refusal arrives after this side finished, and both runtimes
  report it as a reset.
- For a pairing with an internet relay, the dial-out host first completes the outer handshake with
  the relay's accept process, then the inner one with the relay itself over it (§mesh.lan/handshake),
  within the same connect timeout. "Relay's pin didn't match" then means the inner pin, the relay's
  own; a connection that ends after the outer handshake but before the inner one completed (the
  accept process didn't know this host's pin, or the relay refused it) reads as "accept process
  refused".
- Removing a pairing stops its connections at once, with every stream inside, and schedules nothing
  more.

## §mesh.lan/relay-sessions — One live connection per pairing and channel

- A relay holds at most one live connection per accepted pairing on each channel. A newer one
  replaces the older, which is closed, and the replacement is logged with the pairing's label only.
  A connection counts only once the dial-out host has spoken HTTP/2 (its SETTINGS arrived), so one
  dropped right after its handshake (a second pairing on the dial-out host pinned to another relay)
  never displaces a working one.
- Three or more replacements for one pairing within 60 s mean two machines hold that host's key:
  the relay flags the pairing as possibly cloned for 10 minutes (shown on the Mesh page) and logs it.
- Unpairing a host closes its connections at once.

## §mesh.lan/accept-process — The internet relay's separate accept process

- The accept process is its own program (`server/mesh/relay-accept/main.ts`, bundled into one file
  that needs only Node's builtins) and runs as its own system user, never as Sova's, so nothing it
  runs can read Sova's agent directory, signal Sova or reach Sova's loopback port. Sova never starts
  it. It always runs on Node, whatever runtime Sova runs on.
- It knows only what Sova tells it over one **control** connection it opens to Sova's handoff
  socket: the pins of the pairings this host accepts, and where to listen. It keeps them in memory
  only. It listens only while that connection is up and the list holds at least one pin, on exactly
  the address and port Sova named (never every interface); the control connection closing, or Sova
  sending an empty list or no address, closes its listener and ends every connection it carries. It
  then dials the control connection again, every few seconds, and refuses everyone meanwhile. Every
  10 s it tells Sova whether it listens (the port only) and its admission counts.
- For each connection whose outer pin is an accepted pairing's (§mesh.lan/handshake,
  §mesh.lan/relay-listener), it opens a new connection to the handoff socket, writes one header line
  naming that pin and the channel, and from then on only copies bytes both ways. It never parses
  what it carries and never sends Sova a source address.
- Sova's handoff socket is the path in `SOVA_RELAY_HANDOFF` (unset: this host has no internet
  relay). Sova listens on it while the mesh is on, and only if its directory is Sova's own (owned by
  Sova's user and group, not a symlink, and closed to other users and to group writes); the socket is
  made group-readable and -writable after it is bound, a stale socket left at the path is replaced,
  and anything else at the path is left alone and nothing listens. The accept process reaches it
  through that group alone. Sova takes a verified connection from nowhere else: never over TCP, never
  from another path, and never from its own listener for an internet relay.
- Each connection to the handoff socket must start with exactly one header line, at most 256 bytes
  and within 2 s, a JSON object with exactly the keys of one of two kinds (`{"v":1,"kind":"control",
  "build","pin"}` or `{"v":1,"kind":"conn","pin","channel"}`); anything else closes it unread. A newer
  control connection replaces the older one, which counts as losing it. A control connection of
  another build is told so and closed; the accept process then exits, and its service manager starts
  the build that was deployed.
- A **conn** connection is taken only while the control connection is healthy, the relay is an
  internet one, and the pin it names is a pairing this host accepts; at most 16 are in their inner
  handshake at once, at most 2 per pairing, and an inner handshake not finished in 5 s ends it. Sova
  then runs the inner handshake as the relay, with this host's own key, and takes the connection only
  if the pin it proves equals the pin named and the channel the one named. Otherwise it ends the
  connection and logs a warning that the accept process vouched for a host the connection didn't
  prove, so it may be compromised; the Mesh page shows it (§mesh.lan/pairing).
- What the accept process logs is counts, bans and fixed phrases, plus the port it listens on: never
  an address, a pin or a key. Sova logs nothing about a handoff connection but fixed phrases and, for
  an accepted one, the pairing's label.
