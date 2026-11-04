# §chat/kill-guard — Mis-written kills refused on macOS

On macOS, before an agent's `bash` command runs, Sova reads the kill and kill-by-name commands in
it (`kill`, `pkill`, `killall`, and a `pgrep` whose output a kill acts on) and refuses the forms
that reach far more processes than the agent meant: nothing of the command runs, and the tool's
reply says why and gives the correct form. It catches an agent's mistake on the user's own machine;
it is not a boundary against an agent that means harm (§chat.kill-guard/limits).

It applies to every agent chat that has `bash`: a pi chat and a Claude Code chat alike (a Claude
Code chat's `bash` is pi's, §app/claude-code-provider), sandboxed or not, and to every worker, team
member, coordinator, monitor and hidden chat (§app.chat-processes/workers). The special chats (the
Overseer, a project overseer, a project assistant, a baton) have no `bash`. It checks the agent's
`bash` tool and nothing else. Sova's composer has no `!` command: a message starting with `!` goes to
the agent like any other, and a command the agent runs for it is checked. pi's own terminal interface,
outside Sova, doesn't load the guard, for its `!` (pi's `user_bash` event) or its agent. Sova never rewrites a command; it runs it as
written or refuses it whole.

On Linux and every other platform the check never runs and nothing changes: there, `pkill` and
`pgrep` read options wherever they stand.

## §chat.kill-guard/refusal — What is refused, and the reply

The check runs only on macOS, where `pkill` and `pgrep` stop reading options at the first pattern,
so every argument after it is one more pattern. `killall` is refused for an option after a name too,
because its manual shows options first and doesn't say what happens to a later one. The guard refuses:

- **An option after the pattern.** `pkill` or `pgrep` (or `killall`) with any `-…` argument after
  its first pattern, as in `pkill -f "bun --watch src/server/main.ts" -P 1`, where `-P` and `1` are
  two more patterns and `1` matches nearly every process. A `pgrep` is refused for this even when
  nothing kills what it lists.
- **Kill everything.** Any `kill` with `-1` among its arguments (`kill -1`, `kill -9 -1`,
  `kill -s KILL -1`, `kill -- -1`); a pattern of one or two characters, or an empty one (after
  `^`, `$`, `.*` are stripped, and for each top-level alternative of a regex, so `a|some-marker` counts);
  `pkill` with no pattern (only `-u`, `-P`, `-t`…) and no `-F`
  pidfile; `killall -u` or `-t` with no name; `-v`, which inverts the match.
- **A broad name.** A pattern that is just a common program name with nothing more specific
  (§chat.kill-guard/broad-names), or an alternation holding one at its top level (`node|bun`,
  `(node|bun)`; `app-(node|bun)` is one specific pattern), for `pkill`, `killall` and a `pgrep` feeding a kill, as in
  `pgrep -lf node | xargs kill` or `killall "Google Chrome"`; and a `grep` picking the PIDs by a
  broad name in a command that also runs `ps` and a kill (`ps aux | grep node | awk … | xargs kill`).
- **A pattern Sova can't see.** A pattern that comes only from a variable or a command
  (`pkill -f "$P"`), and a command holding a kill that Sova can't read (an unclosed quote).

A `pgrep` counts as feeding a kill when the same command holds any `kill`, `pkill` or `killall`,
however the PIDs reach it (a pipe, `xargs`, `$( )`, a variable, a loop). A bare `pgrep node` that
only lists is allowed. A longer pattern that names something specific is allowed:
`pkill -f 'bun --watch src/server/main.ts'`, `pkill -f 'vite --port 5317'`, a unique marker,
`pkill -P 1 -f 'x'` with the options first, `kill 1234`, `lsof -ti :5173 | xargs kill`.

What it reads: the command split on `;`, `&`, `&&`, `||`, `|`, `( )` and newlines, and the commands
inside `$( )`, backticks, `<( )`, and the literal script of `sh -c`, `bash -c`, `zsh -c` and `eval`.
It skips leading `NAME=value` assignments, shell keywords (`if`, `then`, `do`, `{`…) and the
wrappers `sudo`, `doas`, `env`, `nice`, `nohup`, `time`, `timeout`, `command`, `builtin`, `exec`, `stdbuf` and
`xargs` with their options, and matches the command by basename (`/usr/bin/pkill` is `pkill`).
Heredoc bodies, inside a `$( )` too (a commit message written with `$(cat <<'EOF' …)`), and comments
are not read as commands; a redirection's target is not an argument.

The reply is the tool's own result in the transcript, an error, with no separate notice to the
user. It reads `Sova refused this bash command before it ran; nothing ran.`, the command part at
fault and the reason (`on macOS, pkill reads every argument after the first pattern as another
pattern…`; `killall takes its options before the name, and what it does with one after the name isn't
documented, so Sova refuses it`; `a PID of -1 signals every process you own…`; `` `node` is a name this broad: it would
also kill the user's own apps… ``), then the fix: put every option before the pattern or name, match
something specific (a script path, a port, a unique marker), or kill by PID
(`lsof -ti :PORT | xargs kill`, `kill $(cat app.pid)`), and `project_verbs down` for a project's
services.

## §chat.kill-guard/broad-names — The broad names

One table in the code holds them, each matched case-insensitively against the whole pattern after
`^`, `$`, `.*`, `\b`, a one-letter class (`[n]ode`), a directory (`/usr/local/bin/node`) and a
version suffix (`python3.12`) are stripped:

- runtimes: `node`, `nodejs`, `bun`, `deno`, `python`, `python3`, `ruby`, `java`, `perl`, `php`,
  `go`, `cargo`;
- package managers and dev servers: `npm`, `npx`, `pnpm`, `yarn`, `vite`, `tsc`, `esbuild`,
  `webpack`, `next`, `jest`, `vitest`, `make`;
- shells and terminals: `sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`, `tmux`, `screen`, `ssh`,
  `sshd`, `login`, `sudo`, `Terminal`, `iTerm`, `iTerm2`;
- browsers: `chrome`, `Google Chrome`, `Google Chrome Helper`, `Chrome Helper`, `Chromium`,
  `firefox`, `Safari`, `Electron`, `WebKit`, `msedge`, `Microsoft Edge`;
- desktop apps: `Code`, `Code Helper`, `Visual Studio Code`, `Cursor`, `Slack`, `Docker`,
  `Docker Desktop`, `com.docker.backend`, `Finder`, `Dock`, `Mail`, `Messages`, `zoom`, `zoom.us`,
  `Discord`, `Spotify`, `Notes`;
- what Sova itself runs: `claude`, `pi`, `sova`, `git`, `Helper`;
- the system: `launchd`, `WindowServer`, `loginwindow`, `SystemUIServer`, `kernel_task`, `mds`,
  `coreaudiod`.

A pattern with anything more in it (`bun --watch src/server/main.ts`, `node server.js`,
`chrome-devtools-mcp`) is not broad.

## §chat.kill-guard/limits — What it does not cover

- **Indirect commands.** A script file the agent runs (`./stop.sh`, `npm run stop`), a command
  built at run time (`$CMD`, `sh -c "$S"` with a variable script), `ssh host 'pkill …'` (it runs on
  the other machine), a kill in a heredoc fed to a shell (`bash <<EOF`), a PID list written to a
  file and killed by a later command, another program that runs it (`find -exec kill`, `watch`,
  `parallel`), and a kill through another language (`python -c
  "os.kill(…)"`, `node -e "process.kill(…)"`).
- **Other tools.** Only the `bash` tool is checked; a tool that runs a process some other way is
  not.
- **The host's platform decides.** A remote session's commands run on its target but are checked
  by the platform Sova's chat runs on: from a Mac they are checked, even against a Linux target.
- **Words, not meaning.** It reads the command's words with a small shell reader; an odd shape it
  can't follow may slip through, and a harmless pattern that happens to be a broad name is refused.
  A command confined by the macOS sandbox can signal only processes inside its own sandbox
  (§chat/sandbox); the guard is what stands in an unconfined one, and it checks both.
