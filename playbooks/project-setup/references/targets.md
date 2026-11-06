# Deploy targets, by kind

A deploy target is where a commit goes to be used: a server, a platform, a registry, a store. Find
out which kinds this project has from its files (`investigate.md`) and the user's answers; never pick
one because it is common. A project may have none (a library published only by a release, a tool
only its author runs), several (staging and production, an API and its docs site), or a release that
*is* the ship (a package registry, an app store): then it is a release `after` step, not a deploy
target. Ask which, when it isn't plain.

Every shape below follows the same rules (`definition.md`, `deploy`): argv only; every address, user,
path, account, project or bucket name a `${host.NAME}` listed in the top-level `host`; credentials by
name and kind with a read-only `check`; a `verify` URL where the target serves one; a `rollback` the
user confirmed. Each target's steps run in a fresh checkout of the exact commit, so anything the
build needs (dependencies, a gitignored config the user agrees to copy, node_modules) is a `build`
step. A shell pipeline (ssh with a remote script, a health poll) goes in a `.sova/bin/` script whose
text the user reads and lands. You never run any of it: you draw it, and `deploy.check` proves it
offline.

## A VPS or a bare server, over ssh (+ systemd)

Clues: `deploy/` or `.deploy/` folders, `*.service` units, a web server's config (`Caddyfile`, …), a `deploy.sh`
using `ssh`/`rsync`/`scp`, Capistrano (`Capfile`), Kamal (`config/deploy.yml`), Ansible.
- Credentials: `{kind: "ssh", check: ["ssh", "-o", "BatchMode=yes", "${host.PROD_SSH}", "true"]}`
  (with `PROD_SSH` like `deploy@<host>` set on this host, never in the repo).
- Build: the artifact in the fresh checkout (a jar, a binary, a `dist/`, a container image).
- Steps: upload to a staging path, then switch atomically and restart in **one** ssh session (boxes
  often rate-limit ssh): a `.sova/bin/deploy-<target>` script with subcommands (`build`, `upload`,
  `switch`, `rollback`), each a step.
- Plan: `rsync -an --delete …` (a dry run), or the script's `check` subcommand that only reads.
- Verify: the public health URL, `https://${host.SITE_HOST}/health`.
- Rollback: keep the previous artifact on the box (`previous.jar`, `releases/<n>`) and a `rollback`
  step that switches back, or `redeploy-previous`.
- Ask: which unit and user it runs as, whether anything must be checked before a restart (jobs in
  flight, a migration), what must never happen there (no restart in business hours, never touch the
  shared database).

## Containers and registries

Clues: `Dockerfile`/`Containerfile`, a CI job that runs `docker build`/`docker push`, a `compose`
file used in production, Kamal, a registry name in scripts.
- Build: `["docker", "build", "-t", "${host.IMAGE}:${commit}", "."]` (or `podman`, `buildah`, `ko`,
  `jib`, `nix build .#image`).
- Steps: push the image, then tell the runtime to use it (an ssh `docker compose pull && up -d`
  through a script, a platform CLI, a Kubernetes rollout below).
- Credentials: `tool-login` (`docker login` / the registry CLI's own store) with a read-only check
  such as `["docker", "manifest", "inspect", "${host.IMAGE}:latest"]`, or `env` for a token the CLI
  reads.
- Rollback: redeploy the previous tag (`redeploy-previous`), never a moving `latest` alone.

## Kubernetes

Clues: `k8s/`, `kubernetes/`, `manifests/`, `Chart.yaml` (Helm), `kustomization.yaml`, `skaffold.yaml`,
Argo/Flux files (then the deploy is a git change the cluster pulls: ask).
- Credentials: `tool-login` for the kube context, check `["kubectl", "--context", "${host.KUBE_CONTEXT}", "auth", "can-i", "patch", "deployment", "-n", "${host.KUBE_NS}"]`.
- Plan: `kubectl diff -k …` / `helm diff upgrade …` (read-only).
- Steps: `helm upgrade --install … --set image.tag=${commit} --wait`, or `kubectl apply -k …`
  then `kubectl rollout status …`.
- Rollback: `helm rollback <release>` / `kubectl rollout undo …` as its own steps, or redeploy.
- GitOps (Argo CD, Flux): the deploy is a commit to another repository or a tag the controller
  follows; ask whether Sova should do that step at all.

## Platforms (PaaS)

| Clue | Platform | Step shape | Credential (kind · read-only check) | Rollback |
|---|---|---|---|---|
| `fly.toml` | Fly.io | `["fly", "deploy", "--remote-only", "--app", "${host.FLY_APP}"]` | tool-login · `["fly", "auth", "whoami"]` | `fly releases` + redeploy the previous image, or `redeploy-previous` |
| `render.yaml` | Render | a deploy hook URL as an `env` credential, called by a script; or `render deploys create` | env · a script that checks the variable is set | redeploy-previous |
| `vercel.json`, Next.js | Vercel | `["vercel", "deploy", "--prod", "--yes"]` (prebuilt: `vercel build` then `deploy --prebuilt`) | tool-login · `["vercel", "whoami"]` | `vercel rollback` steps, or redeploy |
| `netlify.toml` | Netlify | `["netlify", "deploy", "--prod", "--dir", "dist"]` | tool-login · `["netlify", "status"]` | redeploy-previous |
| `wrangler.toml` | Cloudflare Workers / Pages | `["wrangler", "deploy"]` / `["wrangler", "pages", "deploy", "dist", "--project-name", "${host.CF_PAGES_PROJECT}"]` | tool-login · `["wrangler", "whoami"]` | redeploy-previous (or `wrangler rollback`) |
| `firebase.json` | Firebase | `["firebase", "deploy", "--only", "hosting", "--project", "${host.FIREBASE_PROJECT}"]` | tool-login · `["firebase", "projects:list"]` | redeploy-previous |
| `app.yaml` | Google App Engine / Cloud Run | `["gcloud", "app", "deploy", "--quiet", "--project", "${host.GCP_PROJECT}"]` / `gcloud run deploy …` | tool-login · `["gcloud", "projects", "describe", "${host.GCP_PROJECT}"]` (never a check that prints a token) | traffic back to the previous revision as steps |
| `Procfile`, `app.json` | Heroku / Dokku | `["git", "push", "${host.HEROKU_REMOTE}", "HEAD:main"]` is a push to a deploy remote: the user must agree to it as a deploy step (it is the operator's run, not yours) | ssh or tool-login · `["heroku", "auth:whoami"]` | `heroku rollback` steps |
| `railway.json` | Railway | `["railway", "up", "--detach"]` | tool-login · `["railway", "whoami"]` | redeploy-previous |
| `serverless.yml`, `template.yaml`, `cdk.json`, `Pulumi.yaml`, `*.tf` | AWS Lambda / SAM / CDK / Pulumi / Terraform | `sls deploy`, `sam deploy`, `cdk deploy --require-approval never`, `pulumi up --yes`, `terraform apply -auto-approve` (plan: `terraform plan`, `cdk diff`, `pulumi preview`) | tool-login or env · `["aws", "sts", "get-caller-identity"]` | redeploy-previous, or the user's own undo; infrastructure often can't be: `{none: "<their reason>"}` |

A platform that deploys on its own from a git push (Vercel, Netlify, Render, Cloudflare Pages connected
to the repository) already ships every commit pushed to its branch: then the queue's push **is** the
deploy. Say so in the drawing, and ask whether to declare a target at all (often: none, or one that
only verifies).

## Static hosts and object storage

Clues: a site build (`dist/`, `public/`, `_site/`, `site/`), `CNAME` (GitHub Pages), an `s3 sync` in a
script, a `gh-pages` branch.
- S3 / R2 / GCS / Azure Blob: `["aws", "s3", "sync", "dist/", "s3://${host.SITE_BUCKET}/", "--delete"]`,
  then a CDN invalidation step; plan `["aws", "s3", "sync", "dist/", "s3://${host.SITE_BUCKET}/", "--delete", "--dryrun"]`.
- GitHub Pages from a branch: a push to `gh-pages` is the operator's deploy step (the user agrees);
  from Actions it ships itself when the queue pushes.
- rsync to a web root: as the VPS shape.
- Verify the site's home page; rollback `redeploy-previous`.

## Packages and registries (usually release steps, not targets)

npm (`npm publish`), PyPI (`twine upload` / `uv publish`), crates.io (`cargo publish`), RubyGems
(`gem push`), Maven Central, NuGet (`dotnet nuget push`), Hex (`mix hex.publish`), Go modules (the
tag itself), Homebrew taps, container registries, GitHub release assets (GoReleaser). A version is
published once and never replaced, so it follows Publish: an `after` step of the release playbook,
with its exact command as the user gives it, its credential named, never run by you.

## App stores and desktop installers (release steps, held)

iOS App Store / TestFlight (fastlane, `xcodebuild archive` + `altool`/`notarytool`, EAS submit),
Google Play (fastlane supply, EAS submit, Gradle Play Publisher), Mac notarisation, Windows signing,
Snap Store, Flathub, Microsoft Store, electron-builder, Tauri. Building and signing need the user's
machine, certificates and accounts; review happens on the store's side and takes days. Make them
`after` steps (an `artifact: true` build step reporting the built file, then a `held: true`
submission step for the user's own hands), never deploy targets and never a landing check.

## Questions per target (`questions.md`, "Deploy")

The target's name and one-sentence about; its branch and whether only releases ship there; the exact
commands as the user runs them today (offer each candidate quoted); what the build needs; a host
variable name for every address/user/path/account; each credential's name, kind and read-only check;
the verify URL and status; the rollback (their reason if none); the tests a plan requires; optional
read-only plan steps; and **what must never happen there**.
