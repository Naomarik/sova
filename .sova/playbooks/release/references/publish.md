# Release: publish

Step 5, and only after the user's explicit word to publish (PLAYBOOK.md step 4). Run from the release worktree; tags live in the repository's shared `.git`, so the main checkout sees them too. `"${sha}"` is the release commit, which the live server reports as its head.

## The atomic push
1. **Re-check before tagging.** `git fetch origin`. `git rev-parse origin/master` must be an ancestor of `"${sha}"` (`git merge-base --is-ancestor origin/master "${sha}"`), and `git -C ~/webapps/sova rev-parse master` must still be `"${sha}"`. If either fails, master moved: stop and tell the user.
2. **Read `stable` on GitHub**: `old=$(git ls-remote origin refs/tags/stable | awk '{print $1}')`. This is the tag object's id (not the `^{}` commit line), the value the lease below compares.
3. **Tag locally.**
   ```sh
   git tag -a vX.Y.Z "${sha}" -m "Sova vX.Y.Z"
   git tag -fa stable "${sha}" -m "stable: vX.Y.Z"
   ```
   `-f` only replaces a local `stable` left by an earlier release or fetch; it moves nothing on GitHub.
4. **Push all three in one atomic push.** Either every ref updates or none does; master is pushed as a fast-forward (no force), and only `stable` may be forced, only from the value read in 2.
   - First release that creates `stable` (`$old` is empty; v0.2.0):
     ```sh
     git push --atomic --force-with-lease=refs/tags/stable: origin "${sha}:refs/heads/master" refs/tags/vX.Y.Z refs/tags/stable
     ```
     The empty lease requires that `stable` doesn't exist on GitHub; if it appeared since 2, the push is refused.
   - Every later release (`stable` moves from the previous release):
     ```sh
     git push --atomic "--force-with-lease=refs/tags/stable:${old}" origin "${sha}:refs/heads/master" refs/tags/vX.Y.Z refs/tags/stable
     ```
   A refusal ("stale info", "atomic push failed", "non-fast-forward") changed nothing on GitHub: read `stable` and master again and tell the user; never retry with a broader force.
5. **Check `stable` on GitHub before anything else reads it**: `git ls-remote origin 'refs/tags/stable^{}' 'refs/tags/vX.Y.Z^{}' refs/heads/master` prints `"${sha}"` three times. Not three times: stop, deploy nothing, tell the user. Then tell the merge captain the release is published, and ask the user to resume the Merge round.

## The GitHub release page
The notes are the release's `CHANGELOG.md` entry, without its heading:
```sh
awk '/^## vX\.Y\.Z /{f=1; next} /^## /{f=0} f' CHANGELOG.md > ~/.cache/sova-release-notes-vX.Y.Z.md
gh release create vX.Y.Z --verify-tag --title "Sova vX.Y.Z" --notes-file ~/.cache/sova-release-notes-vX.Y.Z.md --latest
```
`--verify-tag` refuses if the tag isn't on GitHub. Check it: `gh release view vX.Y.Z` shows it as Latest.

## The site
Deploy the site only after the `ls-remote` check, so the landing never shows a release or an install command whose tag GitHub doesn't have.
- **Where it is hosted.** `site/README.md`, "Deploy: Cloudflare Pages", records the address (https://sova.naomarik.com/), the Cloudflare Pages settings and how it deploys: by hand with wrangler from a build of `"${sha}"`, since the Pages project is not connected to Git. Follow it, with `SOVA_SITE_URL` set to that address so `og:image` is absolute. Its steps add the hero video to the export before the build (`node site/scripts/screens/add-video.mjs <export>`, source `$SOVA_SITE_VIDEO_DIR`, default the main checkout's `site/public/video`): videos are gitignored, so the archive has none. If it refuses (a video is missing), don't publish; run `pnpm run screens:video` in the main checkout or point the variable at the files. Anything it doesn't record yet (the Pages project's name, while it still shows a placeholder), ask the user, then record it there (no account IDs or tokens: the repository is public) in a commit of its own on master after the release.
- **Check the live page.** `curl -fsSL <address>/ | grep -c '/stable/scripts/install.sh'` and `grep -c '/releases/tag/vX.Y.Z'` are each at least 1, and `/docs/install/` shows the `stable` command.

## Optional outside checks (the user decides)
Nothing automated gates `stable`; the user decides whether a release is good. Offer these, run only those the user picks, and report what each showed:
- **A clean install from the public command**, after GitHub's cache of the raw script expires (raw.githubusercontent.com serves with a 5-minute max-age; or append `?nocache=<n>` to the URL). In fresh containers (Debian, Fedora, and Alpine with `apk add bash`), with git, curl, unzip and Node ≥ 22.19 installed:
  `curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash -s -- --no-service --no-app-entry`, then start `sova` and `curl -s 127.0.0.1:4800/api/health`: its `head` is `"${sha}"`. Never against the real home of this machine. A Mac needs a fresh user account or a VM.
- **The live landing page** shows `vX.Y.Z` in its pill, linking to the release page, and the `stable` install command.
- **An existing install updates**: on a machine that installed `vPREV` by the public command, re-running it says "installed stable (<short sha>)".

Then report: the tags and their commit, the release page, the site deploy and its check, which outside checks ran and their results, and that the Merge round may resume.
