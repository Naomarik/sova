# The `deploy` section of `.sova/project.json`

Parsed as strictly as the rest of the definition (Sova's own parser, `project-deploy.mjs check`): an
unknown key, a wrong type, a shell string or an unknown template variable makes the whole file
invalid. It sits outside the definition's approval hash and has its own, the **deploy hash**
(everything in it but timeouts): approving how the project runs locally never approves how it
ships, and a deploy edit never needs the services approved again.

```json
"host": ["PROD_HOST", "SITE_HOST"],
"deploy": {
  "targets": {
    "prod": {
      "about": "The public site on the production VPS.",
      "branch": "main",
      "requires": {"tests": "smoke"},
      "credentials": [
        {"name": "prod-ssh", "kind": "ssh", "check": ["ssh", "-o", "BatchMode=yes", "deploy@${host.PROD_HOST}", "true"]}
      ],
      "plan": [{"id": "dry-run", "run": ["rsync", "-an", "--delete", "dist/", "deploy@${host.PROD_HOST}:/srv/site/"]}],
      "build": [{"id": "bundle", "run": ["npm", "run", "build"]}],
      "steps": [
        {"id": "sync", "run": ["rsync", "-a", "--delete", "dist/", "deploy@${host.PROD_HOST}:/srv/site/"]},
        {"id": "restart", "run": ["ssh", "deploy@${host.PROD_HOST}", "systemctl", "--user", "restart", "site"]}
      ],
      "verify": {"http": "https://${host.SITE_HOST}/health", "expect": 200},
      "rollback": "redeploy-previous"
    }
  }
}
```

## A target (`targets.<name>`, 1 to 10, names lowercase-hyphen)
| key | value |
|---|---|
| `about` | what it is, one sentence ≤ 200 characters, no template |
| `branch` | the branch a commit must be on to ship here; default the main checkout's |
| `requires` | `{tests}`: `smoke` (the definition's `test.smoke`), `full` (the whole suite) or `none`; default `smoke`. Tests need the definition's `test` |
| `credentials` | `[{name, kind, check}]`, each name once. `kind`: `env` (a variable name `A-Z0-9_`, never `SOVA_…`; its value is set on this host, in Sova's `host.json`, and handed to every step, redacted from logs), `ssh` (a key in the operator's ssh setup), `tool-login` (a tool's own login). `check`: an argv whose exit 0 says the credential works; run at plan, never by you |
| `plan` | optional read-only steps run at plan, a dry run that changes nothing |
| `build` | optional steps run before `steps` |
| `steps` | 1 to 30 steps `{id, run, timeout?}`: `run` an argv, run in order in a fresh checkout of the exact commit; `timeout` seconds, default 600, at most 1800 |
| `verify` | optional `{http, expect?, timeout?}`: an `http://` or `https://` URL (a template) that must answer `expect` (default 200) within `timeout` seconds (default 30) after the steps |
| `rollback` | required: `{steps: [...]}` (its own steps), `"redeploy-previous"` (the last verified commit deployed again) or `{none: "<the operator's reason>"}` |

## Templates
A deploy reads `${host.<NAME>}` (each name listed in the top-level `host`), `${commit}` (the full
commit shipped), `${target}`, `${checkout}` (the fresh checkout's path) and `${branch}`; `$$` is a
literal `$`. Nothing else: no ports, slots or data paths. Addresses, users and paths on a target are
always `${host.NAME}`, never literals: the repository may be public.

## What happens later (the operator's, never yours)
1. **Approve**: Sova renders every step with `${host.*}` resolved on this host; the operator ticks
   each one, then Approve Deploy (or Approve & Merge for your branch).
2. **Plan** (`deploy.plan`): in a fresh checkout at the exact commit, Sova checks the commit is on
   the target's branch and pushed, runs the required tests and the credential checks and plan steps,
   and answers a plan good for 15 minutes. Not on the branch, not pushed, or a credential check
   failed: refused for good. Tests failing or not run, or main's tree dirty: refused unless the
   operator types a reason, which the project's feed records.
3. **Run** (`deploy.run`): the operator's only, confirmed: build, steps and verify, as one transient
   unit that outlives a Sova restart, one at a time per target, secrets redacted from its log.
