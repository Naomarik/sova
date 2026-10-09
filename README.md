<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/sova-mark-dark.svg">
    <img src="docs/brand/sova-mark-light.svg" alt="" width="72" height="72">
  </picture>
</p>

# sova

**Every agent session, one calm workspace. On your desk, or folded in your pocket.**

Sova gives your [pi](https://pi.dev) coding agent one browser interface for all of its sessions:
the ones you start here, the ones running in your terminal, and the subagents they hand work to.
The same workspace fits a desktop, an unfolded foldable, and a folded phone, so you can follow and
review the work from wherever you are.

It runs pi itself on your machine, through pi's SDK, and uses the sessions you already have.
Read the tool calls, review every change, and answer the session that needs you, without digging
through terminal scrollback. Your existing setup stays yours.

## Get started

Runs on macOS or Linux. Requires bash, Git, Node.js ≥22.19, pnpm (without pnpm, the installer
runs it through npx), curl, and unzip or python3. The installer downloads the Bun version Sova is
tested on into its own folder.

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/master/scripts/install.sh | bash
```

Until the first release is tagged, this installs the `master` branch; running it again updates to
master's latest commit.

Then run `sova`, and `sova open` to open **http://127.0.0.1:4800** already unlocked. Uses your
existing pi provider login.
[First-time login or command not found?](docs/getting-started.md) ·
[Run a checkout as a service, on Bun or Node](docs/running-as-a-service.md)

## More work, less window switching

- **Hand the work to subagents, and follow every one.** In Delegate mode the agent orchestrates: it
  sends planning, investigation, routine changes, and complex changes each to the model you routed
  it to, with a fallback. A subagent profile keeps those routes under one name, set in Settings →
  Subagents. The shipped routes use Claude Code models, so install the `claude` CLI or pick your
  own. Workers open in a side pane, each with its own transcript and how full its context is, and
  come back as idle entries after a server restart. More on
  [Delegate](pi-config/extensions/mode/README.md) and [workers](pi-config/extensions/subagents/README.md).
- **Agree on the plan before anything gets built.** With align on, the agent records each agreement
  as an alignment: findings, approach, rejected alternatives, and open questions with its
  recommendations. An experimental adversarial review (Settings → Experimental) has a fresh,
  read-only reviewer check the plan and the finished diff.
- **Work in worktrees. Review changes as steps.** A session tracks the git worktrees it works in;
  ask it to create, attach, detach, or merge one, and each merge lands as a card. The changes viewer
  shows what a session or worktree changed, read-only, as numbered steps, each with the agent's
  why when it wrote one. [More on worktrees](pi-config/extensions/worktrees/README.md).
- **Know which session needs you.** The sidebar's Needs you list shows the sessions waiting on you,
  and the same list can reach your phone as a push notification, which costs no tokens. The
  Overseer starts, prompts, or tidies sessions when you ask, confirming first when a request is
  risky.
- **Check in from your phone.** Add Sova to your phone's home screen, bring the phone in by
  scanning a one-use pairing QR, and get a push when a session needs you. Sessions already in pi's
  terminal are listed as they are and stream live, with no import.
  [Terminal presence and phone access](docs/getting-started.md#terminal-and-phone-access) need setup.
- **Change direction without starting over.** Rewind to a message, regenerate a reply, fork from an
  assistant reply, steer a running web chat, and switch models mid-session.
- **And more.** Several [Claude logins](pi-config/extensions/claude-code/README.md) with failover on
  a usage limit; a [sandbox](pi-config/extensions/sandbox/README.md) per session; playbooks and
  schedules; read-only [share links](docs/public-links.md) to a session, on an address you set up;
  session tools on your SSH, AWS SSM, Docker, or Incus
  [targets](pi-config/extensions/remote/README.md); a usage page and a resource monitor
  that charges load to the session that caused it; model rules (which models this machine and its
  subagents may use, and how many requests each provider runs at once); and local voice input (set
  up in Settings → Voice).
- **Beyond one machine (preview).** The [mesh](docs/mesh.md) lists and drives sessions on every Sova
  host on your tailnet from any one page; every host in a mesh must be reachable by the same
  devices. Organizations ask the people you work with through their own links, and keep what they
  decide.

Single-user and loopback by default; every browser unlocks once, per address it uses, with the
install's token — read from the token file `~/.pi/agent/sova/auth-token` on the machine Sova runs
on, printed by `pnpm run auth:token` in a checkout, and by `sova token` and `sova open` where the
installer's launcher is installed. A second device — a phone — comes in with a one-use **pairing
code** from **Access** on the app's home page, with the link it must open shown as a QR to scan.
Protect access before exposing it beyond your machine. Model requests go to your configured provider; tools and extensions may also
use the network.

## Make it yours

[Setup and safe access](docs/getting-started.md) ·
[Themes, models, and optional extensions](docs/customization.md) ·
[Run as a service, on Bun or Node](docs/running-as-a-service.md) ·
[Development](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE) · [NOTICE](NOTICE).
Bundled fonts include their own licenses in [public/fonts/](public/fonts/);
[pi-config](pi-config/LICENSE) is licensed separately.
