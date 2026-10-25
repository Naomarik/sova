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
# Through a file, not a pipe: sh has no pipefail, and a failing archive must stop here (GNU tar and bsdtar alike).
git -C "$here" archive -o "$dir.tar" "$rev"
tar -x -f "$dir.tar" -C "$dir"
rm -f "$dir.tar"
ln -s "$here/node_modules" "$dir/node_modules"
git -C "$here" rev-parse "$rev" > "$dir/.trial-rev"
echo "$here" > "$dir/.trial-repo"
echo "$dir"
