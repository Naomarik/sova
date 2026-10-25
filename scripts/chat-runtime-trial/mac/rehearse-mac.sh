#!/bin/zsh
# The first restart master → F (scripts/chat-runtime-trial/rehearse.mjs) on macOS: the server as the launchd
# stand-in agent test.sova-s5-rehearsal, never the live install's agent, never its agent dir. Run it from a
# scratch git checkout that holds both commits (a git bundle clone, as run-mac.sh's), in a login shell:
#   zsh -lc 'cd <scratch checkout> && scripts/chat-runtime-trial/mac/rehearse-mac.sh <from rev> <to rev> quiet|busy'
# It runs THIS checkout's rehearse.mjs (its lib and mock), whatever commit it is at.
#
# What it does:
# - prepares a fresh rehearsal dir (single-use, as on Linux; tmp/runner-rehearsal-plan.md §0) under
#   /private/tmp (short socket paths): checkout/ = `git archive <from>`, its dependencies installed and its
#   bundle built; agent/ made by <from>'s own hermetic-agent-dir.mjs; home/ a tripwire HOME with a decoy claude;
#   proj/;
# - runs rehearse.mjs in a process group of its own (perl setpgrp: darwin has no setsid or GNU timeout),
#   stopped whole after REHEARSE_LIMIT_S (default 1500): TERM, then KILL after 15 s;
# - copies the results (rehearsal-<variant>.json, the server, mock and chat logs) to
#   ./mac-results/rehearsal-<to>-<variant>-<pid>/;
# - checks that nothing is left: the stand-in label (booted out), any process whose PI_CODING_AGENT_DIR lies
#   in the rehearsal dir, the mock (stopped by pid);
# - untrusts the rehearsal checkout's mise.toml and removes the dir (REHEARSE_KEEP=1 keeps it).
# Nothing here names the machine. Exit: rehearse.mjs's code (0 every check passed, 1 a check failed, 2 refused
# or setup), or 3 when something was left.
set -u
[[ $# -eq 3 ]] || { print -u2 "usage: rehearse-mac.sh <from rev> <to rev> quiet|busy"; exit 2; }
from=$1 to=$2 variant=$3
[[ $variant == (quiet|busy) ]] || { print -u2 "rehearse-mac: the variant is quiet or busy, not $variant"; exit 2; }
here=${0:A:h:h:h:h}
cd $here || exit 2
[[ -d .git ]] || { print -u2 "rehearse-mac: $here is not a git checkout (rehearse.mjs archives <to> from it)"; exit 2; }
git rev-parse -q --verify "$from^{commit}" >/dev/null && git rev-parse -q --verify "$to^{commit}" >/dev/null || { print -u2 "rehearse-mac: $from or $to is not a commit here"; exit 2; }
ulimit -n 8192 || { print -u2 "rehearse-mac: cannot raise ulimit -n to 8192"; exit 2; }
# mise is not always on a login PATH: its usual install place, then its shims.
command -v mise >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
mise trust ./mise.toml >/dev/null 2>&1 || true
[[ -d node_modules ]] || pnpm install --frozen-lockfile >/dev/null || exit 2

label=test.sova-s5-rehearsal
launchctl print gui/$UID/$label >/dev/null 2>&1 && { print -u2 "rehearse-mac: $label is loaded already"; exit 2; }
torev=$(git rev-parse --short "$to")
R=/private/tmp/sova-rh-$variant-$$
results=$here/mac-results/rehearsal-$torev-$variant-$$
[[ -e $R ]] && { print -u2 "rehearse-mac: $R exists"; exit 2; }
mkdir -p $R/checkout $R/home $R/proj $results

left=0
sweep() {
  if launchctl print gui/$UID/$label >/dev/null 2>&1; then
    print "rehearse-mac: LEFT launchd label $label (booting it out)"; left=1
    launchctl bootout gui/$UID/$label 2>/dev/null
  fi
  for p in $(ps -wwEax -o pid=,command= | awk -v s=" PI_CODING_AGENT_DIR=$R/" 'index($0, s) && $2 !~ /(^|\/)awk$/ {print $1}') \
           $(ps -wwax -o pid=,command= | awk -v s="$R/" '/mock-llm\.mjs/ && index($0, s) && $2 !~ /(^|\/)awk$/ {print $1}'); do
    [[ $p == $$ ]] && continue
    print "rehearse-mac: LEFT pid $p: $(ps -o command= -p $p | cut -c1-100) (SIGTERM)"; left=1
    kill $p 2>/dev/null
  done
}
finish() {
  cp $R/rehearsal-*.json $R/server.log $R/mock.jsonl $R/decoy-claude-calls.log $R/fake-claude-calls.log $R/prep.log $results/ 2>/dev/null
  [[ -d $R/agent/sova/chats/logs ]] && cp -R $R/agent/sova/chats/logs $results/chat-logs 2>/dev/null
  sweep
  if [[ ${REHEARSE_KEEP:-0} == 1 ]]; then print "rehearse-mac: kept $R"
  else
    mise trust --untrust $R/checkout/mise.toml >/dev/null 2>&1
    chmod -R u+w $R 2>/dev/null; rm -rf $R
  fi
}

# ── the rehearsal dir, from <from> ───────────────────────────────────────────────────────────────────
print "rehearse-mac: $variant, $from → $torev, dir $R, results $results"
(
  set -e
  git archive --format=tar $from | tar -x -C $R/checkout
  print $from > $R/checkout/.rehearsal-rev
  cd $R/checkout
  mise trust ./mise.toml
  pnpm install --frozen-lockfile
  node_modules/.bin/vite build
  node_modules/.bin/vite build --mode share
  HERMETIC_AGENT_DIR=$R/agent node scripts/hermetic-agent-dir.mjs
  # The tripwire HOME: decoys a leak would read or write, and a claude that logs any call and fails.
  mkdir -p $R/home/.pi/agent/extensions $R/home/.pi/agent/cache $R/home/.claude $R/home/.codex $R/home/.local/bin
  for f in settings models auth topic-outline; do print -r '{"tripwire":true}' > $R/home/.pi/agent/$f.json; done
  print -r '{"claudeAiOauth":{"accessToken":"tripwire","refreshToken":"tripwire","expiresAt":0}}' > $R/home/.claude/.credentials.json
  print -r '{"tripwire":true}' > $R/home/.codex/auth.json
  print -r '{"tripwire":true}' > $R/home/.claude.json
  print -r "#!/bin/sh
echo \"\$\$ \$*\" >> $R/decoy-claude-calls.log
exit 1" > $R/home/.local/bin/claude
  chmod +x $R/home/.local/bin/claude
) > $R/prep.log 2>&1
prep=$?
cd $here
if (( prep )); then
  print -u2 "rehearse-mac: preparing $R failed (exit $prep); tail of prep.log:"; tail -20 $R/prep.log >&2
  finish; exit 2
fi

# ── the run, as a whole group under a watchdog ─────────────────────────────────────────────────────
limit=${REHEARSE_LIMIT_S:-1500}
perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' -- node scripts/chat-runtime-trial/rehearse.mjs --scratch $R --from $from --to $to --variant $variant --repo $here > $results/run.log 2>&1 &
pg=$!
stop_group() {
  /bin/kill -s TERM -- -$pg 2>/dev/null || return 0
  for _ in {1..15}; do /bin/kill -0 -- -$pg 2>/dev/null || return 0; sleep 1; done
  /bin/kill -s KILL -- -$pg 2>/dev/null || true
}
( i=0; while (( i < limit )); do sleep 1; i=$((i + 1)); /bin/kill -0 -- -$pg 2>/dev/null || exit 0; done
  print -u2 "rehearse-mac: still running after $limit s; stopping the run"; stop_group ) &
dog=$!
trap 'kill $dog 2>/dev/null; stop_group; finish' EXIT
trap 'exit 130' INT TERM HUP
wait $pg
code=$?
kill $dog 2>/dev/null
trap - EXIT
stop_group
finish
cat $results/run.log
print "rehearse-mac: rehearse.mjs exit $code; $(grep -c '^PASS' $results/run.log) PASS, $(grep -c '^FAIL' $results/run.log) FAIL; results $results"
(( left )) && exit 3
exit $code
