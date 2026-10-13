#!/bin/zsh
# The trial's hermetic server on macOS, left up for the real-model browser drive (the Linux steps:
# stage 5's browser-drive.md; run.mjs `serve`): chats on the detached driver, a scratch agent dir, the fake
# claude first on PATH, no usage poll or price fetch. Never the live install or its agent dir. Run it from a
# scratch checkout of the commit under test, in a login shell, with ONE provider's credential on stdin
# (an auth.json fragment such as {"zai":{…}}; it is never read from the Mac's own ~/.pi):
#   <credential json> | zsh -lc 'cd <scratch checkout> && scripts/chat-runtime-trial/mac/drive-mac.sh <port> <model>'
# e.g. port 4879, model zai/glm-5.3. It prints run.mjs's "serve: open http://127.0.0.1:<port>/#t=<token>";
# reach the port from the browser's machine through an ssh tunnel (ssh -L <port>:127.0.0.1:<port>).
#
# - the credential goes to a 0600 temp file, copied into the scratch agent dir by run.mjs (--auth); both
#   copies are deleted when this script ends, however it ends;
# - run.mjs serve runs in a process group of its own (perl setpgrp), stopped whole after DRIVE_LIMIT_S
#   (default 5400) or on TERM/INT/HUP to this script: INT first (run.mjs then stops the server and every
#   chat process it started), KILL after 30 s;
# - afterwards: any process whose PI_CODING_AGENT_DIR lies in the scratch, or the mock logging there, is
#   listed and stopped by pid; what run.mjs leaves in the scratch (its results.json and server logs; it
#   removes the agent dir itself) is kept as ./mac-results/drive-<pid>/, never the credential, and the
#   scratch is removed from /private/tmp.
# Exit: 0, 2 setup, 3 something was left, 130 stopped by a signal (the usual end: kill -TERM <this pid>).
set -u
[[ $# -eq 2 ]] || { print -u2 "usage: <credential json> | drive-mac.sh <port> <provider/model>"; exit 2; }
port=$1 model=$2
here=${0:A:h:h:h:h}
cd $here || exit 2
ulimit -n 8192 || { print -u2 "drive-mac: cannot raise ulimit -n to 8192"; exit 2; }
command -v mise >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
mise trust ./mise.toml >/dev/null 2>&1 || true
[[ -d node_modules ]] || pnpm install --frozen-lockfile >/dev/null || exit 2
[[ -f dist/index.html ]] || { node_modules/.bin/vite build && node_modules/.bin/vite build --mode share; } >/dev/null 2>&1 || { print -u2 "drive-mac: the web build failed"; exit 2; }

S=/private/tmp/sova-drive-$$
results=$here/mac-results/drive-$$
A=$(mktemp /private/tmp/sova-drive-auth.XXXXXX) || exit 2
chmod 600 $A
cat > $A
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const k=Object.keys(a); if(k.length!==1) throw new Error("one provider expected, got "+k.length)' $A || { rm -f $A; exit 2; }

left=0
finish() {
  rm -f $A $S/agent/auth.json
  for p in $(ps -wwEax -o pid=,command= | awk -v s=" PI_CODING_AGENT_DIR=$S/" 'index($0, s) && $2 !~ /(^|\/)awk$/ {print $1}') \
           $(ps -wwax -o pid=,command= | awk -v s="$S/" '/mock-llm\.mjs/ && index($0, s) && $2 !~ /(^|\/)awk$/ {print $1}'); do
    [[ $p == $$ ]] && continue
    print "drive-mac: LEFT pid $p: $(ps -o command= -p $p | cut -c1-100) (SIGTERM)"; left=1
    kill $p 2>/dev/null
  done
  if [[ -d $S ]]; then
    mkdir -p $results
    cp -R $S/. $results/ 2>/dev/null
    rm -f $results/agent/auth.json
    chmod -R u+w $S 2>/dev/null; rm -rf $S
  fi
  print "drive-mac: ended; results $results"
}

limit=${DRIVE_LIMIT_S:-5400}
perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' -- node scripts/chat-runtime-trial/run.mjs serve --mode child --driver detached --model $model --auth $A --port $port --scratch $S &
pg=$!
stop_group() {
  /bin/kill -s INT -- -$pg 2>/dev/null || return 0
  for _ in {1..30}; do /bin/kill -0 -- -$pg 2>/dev/null || return 0; sleep 1; done
  /bin/kill -s KILL -- -$pg 2>/dev/null || true
}
( i=0; while (( i < limit )); do sleep 1; i=$((i + 1)); /bin/kill -0 -- -$pg 2>/dev/null || exit 0; done
  print -u2 "drive-mac: still running after $limit s; stopping it"; stop_group ) &
dog=$!
trap 'kill $dog 2>/dev/null; stop_group; finish' EXIT
trap 'exit 130' INT TERM HUP
wait $pg
kill $dog 2>/dev/null
trap - EXIT
stop_group
finish
(( left )) && exit 3
exit 0
