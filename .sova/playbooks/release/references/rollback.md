# Release: rolling back

Only on the user's word, each time. A rollback moves `stable` back to the previous numbered release. The bad release's numbered tag and its release page stay: numbered tags never move, and anyone who pinned it keeps it.

1. **The target.** The previous release, `vPREV` (`git tag --list 'v[0-9]*' --sort=-v:refname`, the one before the bad `vX.Y.Z`). Its commit: `prev=$(git rev-parse 'vPREV^{commit}')`.
2. **Move `stable` back**, leased on the value GitHub has now:
   ```sh
   cur=$(git ls-remote origin refs/tags/stable | awk '{print $1}')
   git tag -fa stable "${prev}" -m "stable: vPREV (rolled back from vX.Y.Z)"
   git push "--force-with-lease=refs/tags/stable:${cur}" origin refs/tags/stable
   git ls-remote origin 'refs/tags/stable^{}'    # prints ${prev}
   ```
   Nothing else is pushed: master keeps the bad release's commit and the fix lands on top of it, as a new release.
3. **The release pages.** `gh release edit vX.Y.Z --latest=false`, and mark `vPREV`'s page Latest if it has one (`gh release edit vPREV --latest`; v0.1.0 has none). Add a line at the top of the bad release's notes saying it was withdrawn and why.
4. **The site.** Its pill names `vX.Y.Z` while `stable` is `vPREV`: tell the user, and redeploy the site from `vPREV`'s tree if it has one (v0.1.0 has no site), or leave it until the fix release.
5. **What a re-run installs.** The installer's default is `stable` in every commit, so a re-run of the public command after step 2 rebuilds `vPREV` from a fresh clone (GitHub may serve the cached script for up to 5 minutes, which changes nothing: the script reads `stable` when it runs). v0.1.0's own installer defaults to `v0.1.0` itself, so rolling back to v0.1.0 installs v0.1.0 either way.
6. **Stored data.** Rolling the code back doesn't roll back what the newer release wrote: settings, sessions and state under `~/.pi/agent/sova/` that `vX.Y.Z` changed may not read the same on `vPREV`. Before rolling back, read `vX.Y.Z`'s notes and its stored-format changes; say in the withdrawn notes what a user who goes back should expect, and whether to back up `~/.pi/agent/sova/` first.
7. If the user wants it, run the clean-install check from `references/publish.md` against `stable` again.
