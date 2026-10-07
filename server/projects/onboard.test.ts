// What `verbs/onboard` starts (§app.project-runtime/onboard): the shipped Project verbs playbook as the
// first prompt with the run's why, its title, the model (asked, else the first of claude-code's current
// Opus and openai-codex gpt-6-astra the host lists, at medium; none: refused), and the host's
// refusals in their order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listPlaybooks } from "../playbooks";
import { NO_ONBOARD_MODEL, ONBOARD_MODELS, ONBOARD_PLAYBOOK_ID, onboardInvalid, onboardModel, onboardStartFrom, type OnboardFacts } from "./onboard";
import { linkedPlaybook } from "../../shared/playbooks";

const PLAYBOOK = { title: "Project verbs", dir: "/x/playbooks/project-verbs", body: "# Project verbs\n", approves: "definition" as const };
const facts = (over: Partial<OnboardFacts> = {}): OnboardFacts => ({ name: "Motors", root: "/w/motors", remote: null, rootExists: true, playbook: PLAYBOOK, ...over });

test("the model: asked wins (medium unless given); else the catalog's current Opus, then gpt-6-astra, when the host lists it, at medium; never an unlisted ref", () => {
  assert.deepEqual(onboardModel({ model: "zai/glm-5.3" }, null), { model: "zai/glm-5.3", thinking: "medium" });
  assert.deepEqual(onboardModel({ model: "zai/glm-5.3", thinking: "high" }, []), { model: "zai/glm-5.3", thinking: "high" });
  // This host's list: Sova's Claude catalog.
  assert.deepEqual(
    onboardModel({}, ["claude-code-cli/claude-sonnet-5-5", "claude-code-cli/claude-opus-5-5", "claude-code-cli/claude-haiku-4-5", "openai-codex/gpt-6-astra"]),
    { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" },
  );
  assert.deepEqual(onboardModel({}, ["anthropic/claude-sonnet-5", "openai-codex/gpt-6-astra"]), { model: "openai-codex/gpt-6-astra", thinking: "medium" });
  // An old alias is no catalog ref: a host listing only it has no Opus to give.
  assert.deepEqual(onboardModel({}, ["claude-code-cli/opus[1m]", "openai-codex/gpt-6-astra"]), { model: "openai-codex/gpt-6-astra", thinking: "medium" });
  // Nothing usable listed, or the list unreadable: no model, never a guess.
  assert.equal(onboardModel({ model: "  " }, ["zai/glm-5.3", "claude-code-cli/claude-sonnet-5-5"]), null);
  assert.equal(onboardModel({}, null), null);
  assert.deepEqual([...ONBOARD_MODELS], ["claude-code-cli/claude-opus-5-5", "openai-codex/gpt-6-astra"]);
  assert.equal(NO_ONBOARD_MODEL, "No model for the Project verbs playbook: this host offers neither Claude Code Opus 5.5 nor openai-codex gpt-6-astra. Pick a model to run it with.");
  const none = onboardStartFrom(facts(), { why: "x" }, ["zai/glm-5.3"]);
  assert.equal(none.invalid, NO_ONBOARD_MODEL);
  assert.equal(none.prompt, "");
});

test("refusals: a remote folder, then a missing one, then no playbook", () => {
  assert.equal(onboardInvalid(facts()), null);
  assert.equal(onboardInvalid(facts({ remote: "vps", rootExists: false, playbook: null })), "Motors's folder is on vps: the playbook runs only on a local folder.");
  assert.equal(onboardInvalid(facts({ rootExists: false, playbook: null })), "Motors's folder /w/motors is missing on this host.");
  assert.equal(onboardInvalid(facts({ playbook: null })), 'No playbook "project-verbs" is listed for Motors.');
  const refused = onboardStartFrom(facts({ playbook: null }), { why: "first time" }, ["claude-code-cli/claude-opus-5-5"]);
  assert.equal(refused.prompt, "");
  assert.match(refused.invalid ?? "", /No playbook/);
});

test("the first prompt is the playbook's turn plus the why; the title names the project", () => {
  const s = onboardStartFrom(facts(), { why: "  bb.edn gained a worker  " }, ["claude-code-cli/claude-opus-5-5"]);
  assert.equal(s.invalid, undefined);
  assert.equal(s.title, "Project verbs: Motors");
  assert.ok(s.prompt.startsWith("Playbook: Project verbs — /x/playbooks/project-verbs\n"));
  assert.ok(s.prompt.endsWith("\n---\n\nbb.edn gained a worker\n"));
  assert.equal(s.model, "claude-code-cli/claude-opus-5-5");
  assert.ok(!onboardStartFrom(facts(), { why: " " }, ["claude-code-cli/claude-opus-5-5"]).prompt.includes("---"));
});

test("the shipped catalog lists project-verbs for any folder, with its PLAYBOOK.md body", async () => {
  const cat = await listPlaybooks(fileURLToPath(new URL("../../", import.meta.url)), { userDir: "/nonexistent-user-playbooks" });
  const p = linkedPlaybook(cat.playbooks, ONBOARD_PLAYBOOK_ID, "sova");
  assert.ok(p, "listed");
  assert.equal(p.source, "sova");
  assert.equal(p.title, "Project verbs");
  assert.match(p.body, /At most 6 conform runs/);
  assert.equal(p.approves, "definition", "a verb playbook: its frontmatter says what its proposal approves");
});

test("a run is keyed by its verb playbook: id, title, what it approves; a playbook without approves: is refused (§app.project-runtime/verb-playbooks)", () => {
  const s = onboardStartFrom(facts(), {}, ["claude-code-cli/claude-opus-5-5"]);
  assert.deepEqual([s.playbookId, s.label, s.approves], ["project-verbs", "Project verbs", "definition"]);
  const deploy = onboardStartFrom(facts({ playbookId: "project-deploy", playbook: { title: "Project deploy", dir: "/x/playbooks/project-deploy", body: "# d\n", approves: "deploy" } }), {}, ["claude-code-cli/claude-opus-5-5"]);
  assert.deepEqual([deploy.playbookId, deploy.label, deploy.approves, deploy.title, deploy.invalid], ["project-deploy", "Project deploy", "deploy", "Project deploy: Motors", undefined]);
  const plain = facts({ playbookId: "tidy", playbook: { title: "Tidy", dir: "/x/playbooks/tidy", body: "# t\n" } });
  assert.equal(onboardInvalid(plain), "tidy is not a verb playbook: its PLAYBOOK.md says no approves:.");
});
