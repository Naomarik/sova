import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFINITION_KEYS, DefinitionError, deployStepsOf, exitOf, isVerb, parseDefinition } from "./project-contract";

// The deploy section (§app.project-services/deploy): targets of argv steps, addresses as ${host.NAME},
// credentials by name only, parsed as strictly as the rest of the definition.

const BASE = {
  version: 1,
  host: ["PROD_HOST", "SITE_HOST"],
  services: { web: { cmd: ["node", "server.js"], ports: { http: { base: 4100 } } } },
  test: { run: ["node", "--test"], smoke: ["test/smoke.test.js"] },
};
const TARGET = {
  about: "The public site on the production VPS.",
  branch: "main",
  requires: { tests: "smoke" },
  credentials: [
    { name: "prod-ssh", kind: "ssh", check: ["ssh", "-o", "BatchMode=yes", "deploy@${host.PROD_HOST}", "true"] },
    { name: "CF_API_TOKEN", kind: "env", check: ["node", ".sova/bin/cf-check.mjs"] },
  ],
  plan: [{ id: "dry", run: ["rsync", "-an", "--delete", "dist/", "deploy@${host.PROD_HOST}:/srv/site/"] }],
  build: [{ id: "bundle", run: ["npm", "run", "build"] }],
  steps: [
    { id: "sync", run: ["rsync", "-a", "--delete", "dist/", "deploy@${host.PROD_HOST}:/srv/site/"], timeout: 900 },
    { id: "restart", run: ["ssh", "deploy@${host.PROD_HOST}", "systemctl", "--user", "restart", "site"] },
  ],
  verify: { http: "https://${host.SITE_HOST}/health" },
  rollback: "redeploy-previous",
};
const withDeploy = (deploy: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ ...BASE, ...extra, deploy });
const refused = (deploy: unknown, re: RegExp, extra: Record<string, unknown> = {}) =>
  assert.throws(
    () => parseDefinition(withDeploy(deploy, extra)),
    (e: unknown) => e instanceof DefinitionError && re.test(e.message),
    `expected ${re}`,
  );

test("a target parses with its defaults: steps in order, credentials by name, verify expects 200, timeouts 600 s", () => {
  const def = parseDefinition(withDeploy({ targets: { prod: TARGET } }));
  const t = def.deploy!.targets[0]!;
  assert.equal(t.name, "prod");
  assert.deepEqual(t.steps.map((s) => [s.id, s.timeout]), [["sync", 900], ["restart", 600]]);
  assert.deepEqual(t.credentials.map((c) => [c.name, c.kind]), [["prod-ssh", "ssh"], ["CF_API_TOKEN", "env"]]);
  assert.deepEqual(t.verify, { http: "https://${host.SITE_HOST}/health", expect: 200, timeout: 30 });
  assert.equal(t.rollback, "redeploy-previous");
  assert.deepEqual(t.requires, { tests: "smoke" });
  // Every step in the order it runs: credential checks, plan, build, steps (rollback's last).
  assert.deepEqual(deployStepsOf(t).map((s) => s.key), ["credentials.prod-ssh", "credentials.CF_API_TOKEN", "plan.dry", "build.bundle", "steps.sync", "steps.restart"]);
});

test("rollback is steps, redeploy-previous or none with a reason; a target must say which", () => {
  const steps = parseDefinition(withDeploy({ targets: { prod: { ...TARGET, rollback: { steps: [{ id: "back", run: ["./bin/rollback"] }] } } } })).deploy!.targets[0]!;
  assert.deepEqual(deployStepsOf(steps).at(-1)?.key, "rollback.back");
  const none = parseDefinition(withDeploy({ targets: { prod: { ...TARGET, rollback: { none: "The database migrates forward only." } } } })).deploy!.targets[0]!;
  assert.deepEqual(none.rollback, { none: "The database migrates forward only." });
  const { rollback: _r, ...noRollback } = TARGET;
  refused({ targets: { prod: noRollback } }, /rollback: say how it is undone/);
  refused({ targets: { prod: { ...TARGET, rollback: { none: "" } } } }, /rollback\.none: must be the reason/);
  refused({ targets: { prod: { ...TARGET, rollback: "undo" } } }, /rollback: must be an object/);
  refused({ targets: { prod: { ...TARGET, rollback: { steps: [] } } } }, /rollback\.steps: must be a list of steps \{id, run\}, at least one/);
});

test("no shell strings, no unknown keys, no unknown variables: a deploy reads only ${host.*} and its own four", () => {
  refused({ targets: { prod: { ...TARGET, steps: [{ id: "sync", run: "rsync -a dist/ prod:/srv" }] } } }, /steps\[0\]\.run: must be an argv/);
  refused({ targets: { prod: { ...TARGET, steps: [] } } }, /steps: must be a list of steps \{id, run\}, at least one/);
  refused({ targets: { prod: { ...TARGET, shell: "x" } } }, /prod\.shell: unknown key/);
  refused({ targets: { prod: { ...TARGET, steps: [{ id: "sync", run: ["rsync", "${host.NOT_DECLARED}"] }] } } }, /unknown template variable \$\{host\.NOT_DECLARED\}/);
  refused({ targets: { prod: { ...TARGET, steps: [{ id: "sync", run: ["rsync", "${ports.web.http}"] }] } } }, /unknown template variable \$\{ports\.web\.http\}/);
  refused({ targets: { prod: { ...TARGET, verify: { http: "${host.PROD_HOST}" } } } }, /verify\.http: must be an http/);
  // The four a deploy has of its own, and $$ for a literal $.
  const ok = parseDefinition(withDeploy({ targets: { prod: { ...TARGET, steps: [{ id: "tag", run: ["git", "tag", "deploy-${target}-${commit}", "--", "${checkout}", "${branch}", "$$HOME"] }] } } }));
  assert.equal(ok.deploy!.targets[0]!.steps[0]!.run[2], "deploy-${target}-${commit}");
});

test("credentials: an env credential is a variable name Sova never sets; each once; kinds closed; check an argv", () => {
  const cred = (c: unknown) => ({ targets: { prod: { ...TARGET, credentials: [c] } } });
  refused(cred({ name: "cf-token", kind: "env", check: ["true"] }), /an env credential is a variable name/);
  refused(cred({ name: "SOVA_SLOT", kind: "env", check: ["true"] }), /never one Sova sets/);
  refused(cred({ name: "x", kind: "vault", check: ["true"] }), /kind: must be one of env, ssh, tool-login/);
  refused(cred({ name: "x", kind: "ssh" }), /check: must be an argv/);
  refused({ targets: { prod: { ...TARGET, credentials: [TARGET.credentials[0], TARGET.credentials[0]] } } }, /each credential once/);
});

test("tests: a target that requires tests needs the definition's test command; about is a plain sentence; branch a plain name", () => {
  const { test: _t, ...noTest } = BASE;
  assert.throws(() => parseDefinition(JSON.stringify({ ...noTest, deploy: { targets: { prod: TARGET } } })), /requires smoke tests, and the definition declares no test command/);
  assert.ok(parseDefinition(JSON.stringify({ ...noTest, deploy: { targets: { prod: { ...TARGET, requires: { tests: "none" } } } } })).deploy);
  refused({ targets: { prod: { ...TARGET, about: "Ships to ${host.PROD_HOST}" } } }, /about: must say what the target is/);
  refused({ targets: { prod: { ...TARGET, branch: "../main" } } }, /branch: must be a plain branch name/);
  refused({ targets: {} }, /declare at least one target/);
  refused({ targets: { Prod: TARGET } }, /a name is lowercase/);
});

test("the deploy keys are pinned in DEFINITION_KEYS, and the deploy verbs exist with their exit classes", () => {
  assert.deepEqual([...DEFINITION_KEYS.deploy], ["targets"]);
  assert.ok(DEFINITION_KEYS.target.includes("credentials"));
  for (const v of ["deploy.check", "deploy.plan", "deploy.run", "deploy.status", "deploy.logs", "deploy.rollback", "deploy.request"]) assert.ok(isVerb(v), v);
  assert.equal(isVerb("deploy"), false, "the bare name is no verb");
  assert.equal(exitOf({ error: { code: "deploy-refused" } }), 2);
  assert.equal(exitOf({ error: { code: "needs-override" } }), 2);
  assert.equal(exitOf({ error: { code: "deploy-failed" } }), 1);
  assert.equal(exitOf({ error: { code: "verify-failed" } }), 1);
});
