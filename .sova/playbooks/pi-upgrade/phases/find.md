# Find the target

Run these from the repository, once, before you start the team:

```sh
for p in pi-coding-agent pi-ai pi-tui pi-mcp; do
  echo "$p: $(npm view "@earendil-works/$p" dist-tags --json)"
done
npm view @earendil-works/pi-coding-agent time --json        # release dates
npm view @earendil-works/pi-coding-agent@<new> dependencies engines --json
(cd ~ && pi --version; command -v pi; npm root -g; npm ls -g --depth=0 @earendil-works/pi-coding-agent)
grep -n '@earendil-works' package.json                      # <old>: what Sova pins
```

- The target is the "Move to" choice: a version, or `latest` (the `latest` dist-tag). Other dist-tags (`legacy-node20`, `next`, `beta`) and prereleases are never a target unless the user named one; name the ones you saw in the report.
- Every package must carry `<new>`. If some don't, the release is half published: say so and stop.
- Say how old `<new>` is. A release under a week old with no urgency is a reason for "later": pnpm refuses a very young release unless excluded, and hotfixes often follow within days.
- An `[Unreleased]` changelog section is never a target; it only informs a "wait for the next one" verdict.

**Nothing to do:** `<old>` already is the target. Say so in two lines, with `<terminal>` (offer to bring the terminal pi level if it isn't), and end the run there. No team, no report.

Otherwise make the research folder: `<W>` is `research/` in this run's folder (the run block names the folder), with `reports/`, `logs/`, `tarballs/`, `x/`, `tools/`, `base/` and `scratch/`. Never `~/.cache`, never `/tmp` (helpers can't see your private temp). Keep it until the upgrade lands or the user says skip.
