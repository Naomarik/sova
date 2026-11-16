# §mesh/tunnel — The Cloudflare tunnels Sova runs
> Part of the Sova design spec · [overview](../design/overview.md)

Under **Cloudflare → Free** and **Cloudflare → Account** (§mesh.public/where-links-open) Sova runs
`cloudflared` itself, on this computer, so a link opens from outside with nothing to set up by
hand: one **share tunnel** carries every `/h/`, `/i/`, `/s/` and `/t/` link to the share listener
(§app.baton/share-listener), and under Free each previewed app gets a **preview tunnel** of its
own (§mesh.public/preview-tunnels). While a new Account address waits for its Verify, a
**candidate tunnel** runs for that check alone (§mesh.tunnel/account). Only the share listener's port and the previewed apps' ports
are ever behind a tunnel, never the Sova app itself. A tunnel runs outside Sova, survives its
restarts, starts only when something is shared and stops when nothing is, and Sova spends no CPU
watching it (§mesh.tunnel/lifetime).

Under Free and Account the share listener fails closed by `Host`. A `Host` that is exactly a running
preview tunnel's goes to that tunnel's previews (§mesh.public/preview-tunnels). Every other request
reaches the share routes only when its `Host` is exactly the share tunnel's current host (Account:
its saved public address's host), a loopback one (`127.0.0.1`, `localhost`, `::1`), or, only while
a candidate's Verify runs, that candidate's host (§mesh.public/where-links-open). Any other
`Host` gets the plain 404: another tunnel's address, an address from before a restart, and every
request while the tunnel's address isn't known yet (a restart before the tunnel is re-adopted
included). A loopback `Host` reaches the routes and nothing more: the share listener never takes a
loopback socket for the operator. `SOVA_SHARE_PUBLIC_URL` and the other routes judge no `Host`.

## §mesh.tunnel/turn-on — One Turn On click before the first public tunnel

- The first public Free tunnel this computer ever opens needs the operator's one-time **Turn On**
  click in Sova's page, in Settings → Public links or on the prompt a share screen shows. The click
  is stored (`consentAt`, written by the server only) and asked never again, whatever the route is
  later.
- Before that click, a link is still made: every mint, an agent's included, answers its link with
  the `quick-turn-on` warning (the link isn't public yet), and no tunnel starts. Each share screen
  and Settings → Public links show the Turn On prompt; with no cloudflared on this computer the same
  prompt offers its Download (§mesh.tunnel/cloudflared).
- Turn On is never agent-triggered: `POST /api/public-links/turn-on` passes only on the person's own
  click in the page (§app.access/your-click); a chat, the Overseer, a script, an extension and a
  mesh peer get 403 and nothing changes. After the click, a mint by anyone may start the tunnel.

## §mesh.tunnel/lifetime — How a tunnel lives, and nothing runs at idle

- **Lazy start.** Nothing runs until a link that needs a tunnel is handed out. The first mint of an
  `/h/`, `/i/`, `/s/` or `/t/` link under Free (after Turn On, with cloudflared found) starts the
  share tunnel and waits up to 20 seconds for its address, so the first share answers a full
  `https://` link; past that it answers its link with the `quick-starting` warning, and open lists
  redraw at the address once it is up. Each new address is checked once from outside before it is
  trusted (`verified`), else it is used, its links carrying the `quick-verifying` warning (the
  address is still coming online; a Free warning never mentions Verify): its state then reads `up`,
  with a reason saying the address didn't answer from outside yet, and `degraded` stays for a tunnel
  that is really down. A Free start refused before Turn On reads `stopped`, reason `turn-on`. An
  Account tunnel starts when the Account route is saved (§mesh.tunnel/account).
- **Re-checked until it answers.** A new trycloudflare name can take minutes to resolve, so a Free
  address not yet verified is checked from outside again by one-off timers 15, 30, 60, 120 and 240
  seconds after its tunnel connected, never more and never an interval. The first pass records it
  verified, ends the series and tells open pages (the links' warning becomes `quick`); stopping the
  tunnel cancels the next check. When Sova restarts before it verified, the series goes on from the
  tunnel's start time (only the checks still ahead of it). Each on-demand check (below) also checks
  an unverified address from outside again, within its one look.
- **Survives Sova's restarts.** Each tunnel runs as its own unit outside Sova's service (a systemd
  user unit, as chats do; a detached session on macOS or without a user manager), so restarting
  Sova, after a landing included, never stops it. When Sova starts it reattaches each recorded
  tunnel and reads its address again: one that still answers keeps its address, and its links keep
  opening. Sova's own shutdown stops no tunnel; `scripts/stop-tunnels.ts` stops them for good.
- **Stops when nothing is shared.** The share tunnel stops once no live `/h/`, `/i/`, `/s/` or `/t/`
  link is left (at a revoke, at the last one's expiry, or at Sova's start), or when the route
  leaves Free and Account. An Account tunnel runs while the route is Account, links or not. A
  preview tunnel stops as §mesh.public/preview-tunnels says. A tunnel is never stopped for being idle
  while a link through it is live: its address would change.
- **Nothing runs at idle.** With no tunnel recorded, the feature runs nothing: no watcher, no timer,
  no socket, no process. With tunnels running it never polls: Sova learns of a tunnel ending from the
  tunnel itself (its process exit, written by its unit's stop hook into one watched folder), and
  checks a tunnel only on demand, when a link is handed out, a page that shows links or their
  address opens (Settings → Public links, the Shares page, a Share sheet, the Previews card), or Sova
  starts, at most once a minute per tunnel and only on loopback, plus a Free address's bounded
  one-off re-checks above, which end at its first pass or after 4 minutes. Never an interval that
  asks a tunnel's state, a `systemctl` on a timer, a kept-open connection to the tunnel or a log
  follower; once every address is verified, nothing is scheduled.
- **When one ends.** A Free tunnel that ends while a link through it is live is started again from
  its end, at most 3 times an hour, then only on demand; never by systemd. Its new address is a new
  one, and the links handed out before it are reported broken (§mesh.public/broken-links). A start
  that fails (no network) is tried again after 30 seconds, 2 minutes and 10 minutes, then left
  until the next demand. An Account tunnel's address never changes, and systemd restarts it with
  no Sova involvement. cloudflared always runs with its updater off.

## §mesh.tunnel/cloudflared — Getting cloudflared

- Sova runs the first `cloudflared` it finds, looked for once per server lifetime: the program
  `SOVA_CLOUDFLARED=<path>` names, if set; else one on `PATH`, then in `/usr/local/bin` and
  `/usr/bin` (macOS: `/opt/homebrew/bin` and `/usr/local/bin`); else the copy Sova downloaded. One
  older than 2024.1.0 is passed over, and if no other is found the prompt says "The cloudflared at
  {path} is version {version}; Sova needs 2024.1.0 or later." `SOVA_CLOUDFLARED=off` (the test
  runner's default) never uses an installed one. With none, Sova never fetches one by itself:
  Settings → Public links and the share screens' prompt offer a one-time **Download**, beside the
  command that installs it with the system's package manager.
- Download fetches the cloudflared version this Sova pins, for this platform (Linux x86-64 and
  arm64, macOS x86-64 and arm64), and checks it against that version's SHA-256, which ships in
  Sova's own code (never one read from the release page); the pinned version is 2026.10.7. On macOS
  it checks two sums: the archive's and the extracted program's. It keeps the copy at
  `<stateRoot>/bin/cloudflared` (the folder mode 0700), with a `cloudflared.json` record beside it;
  a copy that doesn't match is deleted and the download says so. The downloaded copy runs only while
  it is the version this Sova pins and its file hashes to the SHA-256 in Sova's code, never to a
  sum recorded beside it; after a Sova update that changes the pin, Download is offered again. On
  any other platform the option says to install cloudflared yourself.
- The route answers once the file is verified, or with `{ok: false, code, error}`: `code` is one of
  `unsupported`, `network`, `answer`, `checksum`, `broke-off`, `unpack`, `save`, and `error` fills the
  copy deck's `{reason}`. A second click while a download runs joins it.
- Download is never agent-triggered: `POST /api/public-links/cloudflared/download` passes only on
  the person's own click in the page (§app.access/your-click). A mint with no cloudflared downloads
  nothing and starts nothing: it answers its link with the `quick-setup` warning.

## §mesh.tunnel/account — The Account tunnel, from its token

- **Cloudflare → Account** takes the tunnel's public address (`https://share.example.com`), an
  optional preview address (`https://*.example.com`, §mesh.public/preview-address), and the
  connector token the Cloudflare dashboard shows for a tunnel the user made there. Sova runs that
  tunnel (`cloudflared tunnel run`) from the token, with the share tunnel's lifetime
  (§mesh.tunnel/lifetime); it never creates the tunnel or its DNS names.
- The token is a credential: it is stored only in Sova's state folder, mode 0600, and never in
  `public-links.json`, a command line, a chat's context, a setup chat's brief, an answer or a log
  line. `GET /api/public-links` says only whether one is saved. Saving or removing it
  (`PUT`/`DELETE /api/public-links/account-token`) passes only on the person's own click in the page
  (§app.access/your-click); a token that isn't the dashboard token's shape is refused, unsaved.
- Saving the Account route needs its address and a token. When nothing works yet it starts the
  tunnel at once and runs Verify (§mesh.public/front); the state chip shows Verified or the reason.
  From a working route it waits as a candidate (§mesh.public/where-links-open): Verify starts the
  **candidate tunnel** from its token, beside today's tunnel and into the same share port, checks the
  address, and stops it again, pass or fail. On a pass the share tunnel restarts as Account on the
  verified token. The candidate tunnel runs only for the check: it is no preview tunnel and never
  counts toward the 6, systemd never restarts it, and at Sova's start a recorded one with no setup
  pending is stopped. An Account host takes no routed hosts: it is no gateway for other computers
  (§mesh.public/gateway).
- **A token pasted onto a working Account** (the route is Account and its address reads verified),
  or while a candidate waits, doesn't replace the saved one and restarts nothing: it waits in its
  own file, `tunnels/account-token.candidate.env` (mode 0600, kept out of every answer and redacted
  as the saved one is), and saving the Account route with it waits as a candidate even at the same
  address. Only a passing Verify makes it the saved token (renamed over it in one step); Cancel, or a
  route chosen outright that isn't Account, discards it. Otherwise (no Account, or one unverified or
  broken) a pasted token applies at once and a running Account tunnel restarts on it. Removing the
  token removes both.
- The dashboard points at exactly the share port (`sharePort`, 4802 by default), so the Account
  tunnel forwards there and nowhere else: a port that is taken is the listener failure
  (§mesh.public/listener-failure), never another port. Free's own tunnel takes any free port when
  that one is taken.
- **Only the share listener behind it.** An Account tunnel's routes live in the dashboard, so after
  it connects, and at each on-demand check (§mesh.tunnel/lifetime), Sova reads cloudflared's
  `/config` once, on loopback. Every ingress service must be `http://127.0.0.1:<share port>` or
  `http://localhost:<share port>`, or a fixed `http_status:<code>`. Any other stops the tunnel,
  marked failed: "This tunnel sends visitors somewhere other than Sova's share links. In the
  Cloudflare dashboard, point its public hostname at http://127.0.0.1:{port}." Routes not readable
  yet are looked at again 3, 10 and 30 seconds after it connects, each a one-off look, never an
  interval; meanwhile the tunnel reads `degraded`, "Checking this tunnel's routes." Still unread
  after the last look, it is stopped and fails: "Sova couldn't read this tunnel's routes, so it
  stopped it. In the Cloudflare dashboard, point its public hostname at http://127.0.0.1:{port},
  then save the Account option again."

## §mesh.tunnel/setup-chat — Set Up With a Chat

- Every option's setup help that has steps to run on this computer (Cloudflare Account, Tailscale
  Funnel, Your own web server) offers **Set Up With a Chat**. It opens a new chat seeded with that
  option's setup prompt, and the page shows it. Its folder is `<stateRoot>/public-links-setup/<option>/`
  (`account`, `funnel`, `web-server`), whose `AGENTS.md` brief is written again on each start. Without
  a model in the request, the chat starts on this computer's default profile (§chat.profiles/default).
- The chat runs each step only with the user's approval. It never writes a Sova setting and never
  asks for or handles the Cloudflare token. It ends by telling the user to save the address (and,
  for Account, paste the token) in Settings → Public links and press Verify: the user saves and
  verifies, never the chat.
- Until the new option is saved, links keep opening where they open now.
