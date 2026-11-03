# Sova claims

Verified at `v0.6.0` (`35ccd439`, the `stable` tag) on 2026-10-22, by reading the code with
`git show v0.6.0:<path>` / `git grep ... v0.6.0`; HEAD (`2aa27857`) re-checked for the same paths.
Working tree: the README rewrite itself, uncommitted. Nothing below was run: these are read, not
driven, unless the row says otherwise. Spec labels were not used as evidence.

| Claim, in reader's words | Evidence (ladder rung: where) | How checked | Status |
|---|---|---|---|
| One-line installer builds the `stable` tag in `~/.local/share/sova` and adds an app-launcher entry | 1: `scripts/install.sh` (`ref=${SOVA_REF:-stable}`, app entry, unchanged v0.6.0→HEAD); `docs/getting-started.md` | Read code | shipped (not run here) |
| `sova open` starts the server and opens `127.0.0.1:4800` unlocked | 1: `scripts/install.sh` launcher (`app \| open)`) | Read code | shipped (not run here) |
| Needs macOS or Linux, Git, Node.js 22.19+ | 1: `scripts/install.sh` (`node_min_major=22`, `node_min_minor=19`, git check) | Read code | shipped |
| Lists every session, terminal ones with no import; a TUI session streams live and is read-only | 1: `server/app.ts` (`/ws/watch`, `sessions/live`) | Read code | shipped |
| Reliable TUI presence needs the sessions extension | 1: `pi-config/extensions/sessions/`; `docs/getting-started.md` | Read code and doc | shipped (limit) |
| Delegate mode routes work to workers; shipped routes use Claude Code models | 1: `pi-config/extensions/mode/README.md` route table, `pi-config/extensions/subagents/` | Read code/README | shipped |
| Workers pane: each worker's transcript and context fill | 1: `src/components/AgentsView.tsx` (`ContextRing`) | Read code | shipped |
| Align records findings, approach, rejected alternatives, open questions, then waits | 1: `pi-config/extensions/mode/align-tool.ts`, README l.126 | Read code/README | shipped |
| Changes viewer shows numbered steps with the agent's reason, read-only | 1: `src/components/ChangesViewer.tsx` (`stepsFromAgent`) | Read code | shipped |
| Needs you list, push to phone, pairing code | 1: `src/App.tsx` "Needs you", `server/push.ts`, `server/push-routes.ts`, `server/auth-devices.ts` | Read code | shipped |
| Phone needs a protected route (tunnel/HTTPS proxy) | 1/3: `docs/getting-started.md` "Connect from another device" | Read doc | shipped (limit) |
| Rewind, regenerate, fork, steer | 1: `server/chat-actions.ts` (`rewind`, `regenerate`), `server/session-fork-routes.ts`, steer in `server/app.ts` | Read code | shipped |
| Several Claude logins with failover | 1: `pi-config/extensions/claude-code/accounts.ts` | Read code | shipped |
| Sandbox per session (bubblewrap / Seatbelt) | 1: `pi-config/extensions/sandbox/backend.ts`, `backends/darwin-seatbelt.ts` | Read code | shipped |
| 18 built-in themes plus your own JSON | 1: `git ls-tree v0.6.0 themes/` (18 `.json`); `docs/customization.md` | Counted files | shipped |
| Local voice input, downloads its model | 1: `src/components/VoiceSetup.tsx` (whisper.cpp, models), Settings → Voice tab | Read code | shipped |
| Read-only share links on an address you set up | 1: `server/share*`; `docs/public-links.md` | Read code/doc | shipped |
| Playbooks and schedules | 1: `server/schedule-routes.ts`, `server/app.ts` playbooks catalog | Read code | shipped |
| Tours of a real interface | 1: `shared/tour.ts` (`record_tour`, `show_tour`), `server/tour-routes.ts` | Read code | shipped |
| Usage page with per-session tokens and costs | 1: `#/usage`, `src/components/CostsTab.tsx` (`UsageSessionRow`) | Read code | shipped |
| Overseer asks before acting on a risky request | 1: `server/overseer-confirm.ts`, `server/overseer-card-tool.ts` | Read code | shipped |
| Mesh and Organizations | 1: `docs/mesh.md`, orgs code | Read doc/code | shipped, marked preview |
| Focus view | HEAD only (`2cd70e47`), not in v0.6.0 | `git grep v0.6.0` found nothing | left out |
| Phone push costs no tokens | old README only | Not checked | left out |
| Remote targets, resource monitor, model rules, memory mode | old README; code present | Not re-checked | left out for length |
