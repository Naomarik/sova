#!/bin/sh
# A fresh snapshot of one commit for a trial run (CHAT_TRIAL_ROOT): the commit's tree exported with
# git archive, node_modules linked to this checkout's. A trial never boots a tree others are editing.
#   scripts/chat-runtime-trial/snapshot.sh <rev> <dir>   (dir must not exist)
#   CHAT_TRIAL_ROOT=<dir> node <dir>/scripts/chat-runtime-trial/run.mjs …
set -eu
rev=$1
dir=$2
here=$(cd "$(dirname "$0")/../.." && pwd)
[ -e "$dir" ] && { echo "snapshot: $dir exists" >&2; exit 2; }
mkdir -p "$dir"
git -C "$here" archive "$rev" | tar -x -C "$dir"
ln -s "$here/node_modules" "$dir/node_modules"
git -C "$here" rev-parse "$rev" > "$dir/.trial-rev"
echo "$dir"
