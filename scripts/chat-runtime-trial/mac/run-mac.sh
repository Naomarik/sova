#!/bin/zsh
# The chat-runtime trial on macOS, from a scratch checkout of the commit under test (never the live
# install, never its agent dir). Run it from that checkout, in a login shell:
#   zsh -lc 'cd <scratch checkout> && scripts/chat-runtime-trial/mac/run-mac.sh <checks…> [run.mjs options]'
# for example:
#   run-mac.sh t1 t1b t1d t7 --mode unit     # T26-mac: the server as a launchd stand-in (test.sova-s5-<tag>)
#   run-mac.sh t2 t9 t17 t17c                # the server a plain child; chats on the detached driver
#   run-mac.sh --set                         # the architect's Mac set, group by group (below)
#
# The Mac set (stage5-design, Part B darwin), each group a run of its own (a scratch, a leftover check):
#   t26mac   t1 t1b t1d t7 --mode unit        T26-mac: survival under the launchd stand-in
#   gen      t2 t9
#   workers  t17 t17c t18 t19 t20 t23
#   slash    t21 t21l t21h
#   code     t25 t27 t4 t4fail
#   two      t8
#   noserver tserverless --mode unit          the server booted out for good (launchctl bootout)
# and, beyond the architect's list, the two checks that are the only cover of a darwin path:
#   restart  trestart --mode unit             C1: Apply's restart of an adopted launchd agent (kickstart -k)
#   stop     tstopchats                       5e(b): scripts/stop-chats.ts on detached sessions
# `--set <group…>` runs only those groups. A summary goes to mac-results/<rev>-set-<pid>.txt.
#
# Getting the checkout there (from the Linux worktree; placeholders, nothing machine-specific):
#   git bundle create /tmp/s5-<rev>.bundle <rev>    then copy it to the Mac and, there:
#   git clone -q /path/to/s5-<rev>.bundle <scratch checkout> && git -C <scratch checkout> checkout -q --detach <rev>
#
# What it does:
# - raises the open-file limit (an ssh shell has 256);
# - trusts the checkout's mise.toml (bun 1.4.2) and installs dependencies once;
# - runs run.mjs with a short scratch dir under /private/tmp, in a process group of its own (perl setpgrp:
#   darwin has no setsid or GNU timeout), stopped whole after RUN_MAC_LIMIT_S (default 2700) per run or when
#   this script is stopped: INT first (run.mjs then stops what it started), KILL after 30 s;
# - copies results.json and the logs to ./mac-results/<rev>-<tag>/;
# - checks that nothing is left: no test.sova-s5- launchd label, no process whose PI_CODING_AGENT_DIR is
#   the scratch. Anything left is listed by pid and stopped by that pid only;
# - removes the scratch.
# Exit: run.mjs's code (0 every check passed, 1 a check failed, 2 setup), or 3 when something was left.
set -u
here=${0:A:h:h:h:h}
cd $here || exit 2
[[ -d .git ]] || { print -u2 "run-mac: $here is not a git checkout (t25 clones it)"; exit 2; }
ulimit -n 8192 || { print -u2 "run-mac: cannot raise ulimit -n to 8192"; exit 2; }
mise trust ./mise.toml >/dev/null 2>&1 || true
# The bun shim exists even when it resolves no version (outside a trusted checkout): ask it.
bun --version >/dev/null 2>&1 || { print -u2 "run-mac: bun does not resolve after mise trust (try: mise install; mise which bun)"; exit 2; }
command -v pi >/dev/null || print -u2 "run-mac: warning: no global pi on PATH (pi workers need it)"
[[ -d node_modules ]] || pnpm install --frozen-lockfile || exit 2

rev=$(git rev-parse --short HEAD)

# Stops process group $1 whole: INT (run.mjs's own teardown), KILL after 30 s.
stop_group() {
  /bin/kill -s INT -- -$1 2>/dev/null || return 0
  for _ in {1..30}; do /bin/kill -0 -- -$1 2>/dev/null || return 0; sleep 1; done
  /bin/kill -s KILL -- -$1 2>/dev/null || true
}
# A stop of this script stops the run in progress first.
trap '[[ -n ${pg:-} ]] && stop_group $pg; exit 130' INT TERM HUP

# One run: run.mjs on its own scratch, its results kept, leftovers listed and stopped. Returns run.mjs's
# code, or 3 when something was left.
run_one() {
tag=$$-${RUN_SEQ:-0}
scratch=/private/tmp/sova-t-$tag
results=$here/mac-results/$rev-$tag
mkdir -p $results
print "run-mac: $rev, checks: $*, scratch $scratch"
perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' -- node scripts/chat-runtime-trial/run.mjs "$@" --scratch $scratch --keep > $results/run.log 2>&1 &
pg=$!
( i=0; while (( i < ${RUN_MAC_LIMIT_S:-2700} )); do sleep 1; i=$((i + 1)); /bin/kill -0 -- -$pg 2>/dev/null || exit 0; done
  print -u2 "run-mac: still running after ${RUN_MAC_LIMIT_S:-2700} s; stopping the run"; stop_group $pg ) &
dog=$!
wait $pg
code=$?
kill $dog 2>/dev/null
stop_group $pg
unset pg
cp $scratch/results.json $scratch/*.log $scratch/mock.jsonl $results/ 2>/dev/null
print "run-mac: run.mjs exit $code; $(grep -c '^PASS' $results/run.log) PASS, $(grep -c '^FAIL' $results/run.log) FAIL"
grep '^FAIL' $results/run.log

# Leftovers: our own labels, and processes of this scratch (by pid, from their environment).
left=0
for l in $(launchctl list | awk '$3 ~ /^test\.sova-s5-/ {print $3}'); do
  print "run-mac: LEFT launchd label $l (booting it out)"; left=1
  launchctl bootout gui/$UID/$l 2>/dev/null
done
for p in $(ps -wwEax -o pid=,command= | awk -v s=" PI_CODING_AGENT_DIR=$scratch" 'index($0, s) && $2 !~ /(^|\/)awk$/ {print $1}'); do
  [[ $p == $$ ]] && continue
  print "run-mac: LEFT pid $p: $(ps -o command= -p $p | cut -c1-100) (SIGTERM)"; left=1
  kill $p 2>/dev/null
done
rm -rf $scratch
(( left )) && return 3
return $code
}

typeset -A groups
groups=(
  t26mac   "t1 t1b t1d t7 --mode unit"
  gen      "t2 t9"
  workers  "t17 t17c t18 t19 t20 t23"
  slash    "t21 t21l t21h"
  code     "t25 t27 t4 t4fail"
  two      "t8"
  noserver "tserverless --mode unit"
  restart  "trestart --mode unit"
  stop     "tstopchats"
)
order=(t26mac gen workers slash code two noserver restart stop)

if [[ ${1:-} == --set ]]; then
  shift
  (( $# )) && order=("$@")
  summary=$here/mac-results/$rev-set-$$.txt
  worst=0
  RUN_SEQ=0
  for g in $order; do
    [[ -n ${groups[$g]:-} ]] || { print -u2 "run-mac: no group $g (groups: ${(k)groups})"; exit 2; }
    RUN_SEQ=$((RUN_SEQ + 1))
    run_one ${=groups[$g]}
    gc=$?
    print "$g (${groups[$g]}): exit $gc; $(grep -c '^PASS' $results/run.log) PASS, $(grep -c '^FAIL' $results/run.log) FAIL; $results" >> $summary
    (( gc > worst )) && worst=$gc
  done
  print "run-mac: set done"; cat $summary
  exit $worst
fi

run_one "$@"
exit $?
