# Sova mesh lab

A local Docker lab for the Sova peer mesh. It runs its own Headscale control plane, N Sova hosts
(each with its own tailscaled, agent dir, sessions and copy of this worktree), a host with no
tailscale at all, a stranger tailnet node, a Caddy front door and the mock token server. It also
has the chaos commands and the milestone harnesses (`e2e/m*.test.mjs`).

```sh
scripts/mesh-lab/lab up            # build from the worktree, start, wait until everything is ready
scripts/mesh-lab/lab status
scripts/mesh-lab/lab pair          # a,b,c list each other in peers.json -> mesh on
scripts/mesh-lab/lab e2e m0        # the lab itself;  e2e m1: peers/hello/whois gate/proxy
scripts/mesh-lab/lab destroy       # remove everything the lab created
```

Needs only `docker` (no sudo) and `node`. Run `scripts/mesh-lab/lab help` for every command.

## What runs

| node | container | what | laptop URL (loopback only) |
|---|---|---|---|
| headscale | `sovamesh-headscale` | Headscale v0.29.4, HTTPS on 443 with the lab CA, MagicDNS base domain `mesh.lab`, embedded DERP (the lab's only relay) | not published |
| a, b, c… (up to h) | `sovamesh-a`… | Sova host: tailscaled (TUN mode, `NET_ADMIN` + `/dev/net/tun`), `tailscale serve --http=8443` → Sova `127.0.0.1:4800`, and mesh-core's peer listener on its tailnet IPs `:4801` once paired | `http://127.0.0.1:4891` (a) … `4898` (h) |
| plain | `sovamesh-plain` | Sova with **no tailscale at all** (no binaries, no tun, no socket): the mesh-off host and the non-tailnet caller | `http://127.0.0.1:4899` |
| stranger | `sovamesh-stranger` | a tailnet node without Sova that is in nobody's peers.json (the intruder for refusal tests; has curl) | – |
| frontdoor + caddy | `sovamesh-frontdoor`, `sovamesh-caddy` | a tailnet node, with Caddy sharing its network namespace: `lb_policy first` over the hosts' `:8443` with active health checks | `http://127.0.0.1:4890` |
| mocktoken | `sovamesh-mocktoken` | sync-engineer's rotating-refresh-token mock (`mock-token-server/`); pi's fixed provider names resolve to it inside the hosts | `http://127.0.0.1:4888` (harness endpoints) |

Each host's MagicDNS name is `<id>.mesh.lab`. Its Tailscale StableID (`lab nodeid <id>`) is a
decimal string on Headscale.

### Each Sova host

- **Code**: the image is built from the **working tree** (`git status` included, not HEAD), with
  `pnpm install --frozen-lockfile` and `vite build`. There is no typecheck, so a mid-branch type
  error doesn't block the lab. Every `lab up` rebuilds (cached layers make it fast) and recreates
  the containers whose image changed. The ignore list is `Dockerfile.dockerignore`: `node_modules`,
  `dist`, `.agent`, `.git`, `auth.json`, `.env*`, `*.key`, `*.pem`, `llmkeys`, `.npmrc`. So
  **`*.pem`/`*.key` files in the tree never reach the image.**
- **Agent dir** `/sova/.agent` (volume `sovamesh_<id>-agent`) is built by
  `scripts/hermetic-agent-dir.mjs` at every start. Sessions live there, and a fixture session
  "fixture session on lab host <id>" is seeded on first boot (`--no-seed` turns that off).
- **Auth**: only the `api_key` entries of `<worktree>/.agent/auth.json` (zai, ollama-cloud,
  deepseek) are copied in, once, at 0600. The file is bind-mounted read-only into the container
  and never baked into an image. Later changes, such as login sync, belong to the host; `lab reset`
  re-seeds. `--auth none` or `--auth a` gives the other hosts an empty auth. No subscription login
  ever enters the lab.
- **Home** `/root` (volume): the Claude store simulator uses `/root/.claude-lab`
  (`SOVA_SYNC_CLAUDE_DIR`), never `/root/.claude`.
- **Listeners**: Sova's main listener stays on `127.0.0.1:4800`. The laptop reaches it through a
  socat forwarder on `:4900`, published on `127.0.0.1:489x`, so the laptop browser acts as that
  host's local user. The tailnet reaches it through `tailscale serve :8443`, which is what the front
  door uses. The peer listener is mesh-core's, bound to the tailnet IPs on `:4801`.
- **Privileges**: `NET_ADMIN` and `/dev/net/tun` are for tailscaled and the entrypoint's iptables
  only. Sova itself runs with `net_admin`/`net_raw` dropped from its bounding set (`setpriv`).

### Isolation from the laptop's real tailnet

- Lab nodes log in only to the lab Headscale (`--login-server=https://headscale`, pre-auth key in
  `STATE/secrets/authkey`, 0600).
- Every container resolves through public DNS (1.1.1.1, 9.9.9.9) with no search domain, never
  through the laptop's resolver, which answers the real `*.ts.net` names.
- Every lab container REJECTs `100.64.0.0/10` and `fd7a:115c:a1e0::/48` on `eth0`. So a tailnet
  address the lab tailscaled has no route for can never leave through Docker NAT into the laptop's
  own tailscale0. (`plain` gets `NET_ADMIN` for this rule only; its Sova runs without it.)
- There's no public DERP or STUN (the DERP map is Headscale's embedded relay only), no logtail
  (`--no-logs-no-support`), and no update checks.
- The laptop's tailscaled is never called. Every `tailscale` command in the CLI is a `docker exec`
  into a lab node.

`e2e m0` asserts all of the above.

## Commands

```
lifecycle   up [opts] · build · down · reset [opts] · destroy [--pulled] · status [--json]
chaos       kill|start|stop|restart <node> · partition <node> [--reject] [--full] · restore <node>
            sova-stop|sova-start|sova-restart <node>
access      exec <node> [cmd…] · logs <node> [-f] · ts <node> <args> · hs <args> · curl <node> <args>
            ip|nodeid|url <node>
mesh        pair [a,b,c] [--no-restart] · unpair [a,b,c] · frontdoor [order a,b,c]
            tls-cert <stem> [names…] · e2e <m0|m1|…|all>
```

- `up` options: `--hosts N` (1–8) or `--hosts a,c,d`, `--auth all|none|a,b`, `--no-plain`,
  `--no-stranger`, `--no-frontdoor`, `--no-mock`, `--no-seed`, `--no-build`. The options persist
  in `STATE/lab.json`, and a bare `up` reuses them.
- `down` stops and removes the containers and keeps the volumes. `reset` wipes every lab volume,
  the Headscale DB, the pre-auth key and the CAs, then runs `up`. `destroy` also removes the
  network, the built images (`sovamesh-host:lab`, `sovamesh-plain:lab`) and the state dir.
  `--pulled` also removes the pulled images (headscale, caddy). Build cache is left to
  `docker builder prune`.
- `pair` writes each listed host's `$AGENT/sova/peers.json` in mesh-core's format
  (`server/mesh/peers.ts`): `{version:1, self:{id,label}, peers:[{id,label,nodeId,dnsName:"<id>.mesh.lab",priority}]}`.
  It keeps any `sync` and `frontDoor` keys already in the file, then restarts Sova. `pair a,b` on a
  3-host lab leaves c listing a and b while they no longer list c (the one-sided "refused" case).
  `unpair` deletes the file (mesh off).
- `partition` uses iptables in the node's own netns. The default silently drops the lab subnet,
  which cuts the tailnet, Headscale and the other containers. The node keeps its internet (LLM
  calls still work) and its laptop port, like a laptop on a plane. With silent drops, Headscale
  shows the node Online until its map stream times out (minutes). `--reject` answers with RST/ICMP
  instead, so peers fail fast and the node shows offline after ~15 s. `--full` also cuts the
  internet. `restore` undoes it, and the tailnet heals in ~5–10 s.
- `kill` is `docker kill`. Headscale marks the node offline after ~13 s. Its address blackholes,
  so dials to it wait for their timeout.
- `sova-stop` stops only the Sova process (the node stays on the tailnet). The entrypoint
  supervises Sova and restarts it if it dies, unless `sova-stop` was used.
- `frontdoor order c,a,b` regenerates `STATE/caddy/Caddyfile` and reloads Caddy. The upstreams are
  `<id>.mesh.lab:8443`, with `header_up Host` set to the upstream, because `tailscale serve` routes
  by Host. Each response carries `X-Lab-Upstream`, the host that served it.
- `tls-cert <stem> names…` mints `STATE/tls/<stem>.pem`/`-key.pem` from the lab CA, which every
  node trusts (system store, plus `NODE_EXTRA_CA_CERTS=/run/lab/ca-bundle.pem`, a bundle of the lab
  CA and the mock's CA).

State lives in `~/.cache/sova-mesh/lab` (override it with `LAB_STATE`): `lab.json`, the generated
`compose.json` (JSON is valid compose YAML), `secrets/`, `tls/`, `mock-token/`, `caddy/`.
Everything Docker-side is named `sovamesh*` and labelled `sova.mesh-lab=1`.

## The harness

`lab e2e <m>` runs `node --test e2e/<m>.test.mjs` against the running lab (`lab up` first). Tests
drive the lab through `e2e/lib.mjs`:

- `requireLab()`, `lab(...args)`
- `exec` / `sh` / `execBackground` into a node
- `curlFrom(node, url, {method, body, headers})` → `{status, json, headers, error}`, where
  status 0 means no HTTP answer
- `laptopFetch(node, path)`, `wsFrom(node, url)`
- `localapi(node, "status" | "whois?addr=…")`, `tailnetIp`, `nodeId`, `dockerIp`, `magicName`
- `readAgentFile` / `writeAgentFile`
- `chaos.*`, `waitFor(fn, {timeoutMs})`, `waitTailnetHealth(from, to)`

The harnesses:

- **m0**: the lab itself, as described above: tailnet, MagicDNS, host↔host over serve, whois of an
  incoming connection names the caller, loopback-only Sova, hermetic API-key-only agent dirs,
  per-host sessions, the plain host, isolation, front door + WS, partition and sova-stop.
- **m1** (leaves a,b,c paired): mesh on with the listener on tailnet IPs only; hello; a peer never
  reaches `/api/mesh/*`, `/peer/*` or static files; stranger 403 plus `X-Sova-Mesh: refused` (HTTP
  and WS); plain unreachable; a one-sided unpair shows as `refused`; the `/peer/<id>` proxy (HTTP
  and WS); sova-stop gives down/502, never 4422; a killed container is down; unpair turns the mesh
  off.

- **m4** (restores order and hosts): the first host in the order serves the SPA; Sova stopped on the
  first host fails over to the second in ~1 s and fails back in <1 s; a killed first container fails
  over in ~1.3 s; with the first two down, the third serves; an order change applies at once; a WS
  held through the front door closes when its host dies (never 4422), and a reconnect lands on the
  next host. The stale-tab check itself is frontend's.

Front-door Caddyfile essentials, the template for the real one: `lb_policy first`,
`health_uri /api/health` with 1 s interval/timeout, `lb_try_duration 5s`, `flush_interval -1`,
`header_up Host {upstream_hostport}` (for `tailscale serve` upstreams), and
`transport http { dial_timeout 1s; keepalive off }`. Without the last one, a request written into
a killed host's idle pooled connection hangs (measured 15.5 s before the fix, 1.3 s after).

Times measured on 2026-09-25: a cold `up` takes ~2 min, a rebuild after a code change ~40 s, m0
~17 s, m1 ~40 s and m4 ~30 s.

## Gotchas

- Tailscale forces port 443 when it re-dials control soon after a previous dial. A plain-http
  Headscale on another port therefore strands every node after its first reconnect, which is why
  Headscale serves TLS on 443. The entrypoint also waits for a saved login instead of re-running
  `tailscale up` over it.
- `tailscaled` takes its UDP port from `$PORT` unless `--port` is given, and `PORT` is Sova's
  here, so the entrypoint passes `--port=41641`.
- After a node restarts, peers may need a few seconds to find its new endpoint. Harnesses poll
  with `waitFor`/`waitTailnetHealth` rather than probing once.
- Nodes from before a `reset` of the Headscale DB can't log back in; `lab reset` wipes their
  tailscale state volumes too.
