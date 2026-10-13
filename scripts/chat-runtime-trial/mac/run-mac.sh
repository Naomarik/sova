#!/bin/zsh
# The chat-runtime trial on macOS, from a scratch checkout of the commit under test (never the live
# install, never its agent dir). Run it from that checkout, in a login shell:
#   zsh -lc 'cd <scratch checkout> && scripts/chat-runtime-trial/mac/run-mac.sh <checks…> [run.mjs options]'
# for example:
#   run-mac.sh t1 t1b t1d t7 --mode unit     # T26-mac: the server as a launchd stand-in (test.sova-s5-<tag>)
#   run-mac.sh t2 t9 t17 t17c                # the server a plain child; chats on the detached driver
#
# Getting the checkout there (from the Linux worktree; placeholders, nothing machine-specific):
#   git bundle create /tmp/s5-<rev>.bundle <rev>    then copy it to the Mac and, there:
#   git clone -q /path/to/s5-<rev>.bundle <scratch checkout> && git -C <scratch checkout> checkout -q --detach <rev>
#
# What it does:
# - raises the open-file limit (an ssh shell has 256);
# - trusts the checkout's mise.toml (bun 1.4.2) and installs dependencies once;
# - runs run.mjs with a short scratch dir under /private/tmp;
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
command -v bun >/dev/null || { print -u2 "run-mac: no bun after mise trust (try: mise install)"; exit 2; }
command -v pi >/dev/null || print -u2 "run-mac: warning: no global pi on PATH (pi workers need it)"
[[ -d node_modules ]] || pnpm install --frozen-lockfile || exit 2

rev=$(git rev-parse --short HEAD)
tag=$$
scratch=/private/tmp/sova-t-$tag
results=$here/mac-results/$rev-$tag
mkdir -p $results
print "run-mac: $rev, checks: $*, scratch $scratch"
node scripts/chat-runtime-trial/run.mjs "$@" --scratch $scratch --keep > $results/run.log 2>&1
code=$?
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
(( left )) && exit 3
exit $code
