// What `verbs/onboard` starts (§app.project-runtime/onboard): the shipped Project verbs playbook as the
// first prompt with the run's why, its title, the model (asked, else claude-code opus medium, else the
// openai-codex fallback when only that is offered), and the host's refusals in their order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listPlaybooks } from "../playbooks";
import { ONBOARD_FALLBACK, ONBOARD_MODEL, ONBOARD_PLAYBOOK_ID, onboardInvalid, onboardModel, onboardStartFrom, type OnboardFacts } from "./onboard";
import { linkedPlaybook } from "../../shared/playbooks";

const PLAYBOOK = { title: "Project verbs", dir: "/x/playbooks/project-verbs", body: "# Project verbs\n" };
const facts = (over: Partial<OnboardFacts> = {}): OnboardFacts => ({ name: "Motors", root: "/w/motors", remote: null, rootExists: true, playbook: PLAYBOOK, ...over });

test("the model: asked wins (medium unless given); else claude-code opus medium; the fallback only when offers are known and lack opus", () => {
  assert.deepEqual(onboardModel({ model: "zai/glm-5.3" }, null), { model: "zai/glm-5.3", thinking: "medium" });
  assert.deepEqual(onboardModel({ model: "zai/glm-5.3", thinking: "high" }, []), { model: "zai/glm-5.3", thinking: "high" });
  assert.deepEqual(onboardModel({}, null), ONBOARD_MODEL);
  assert.deepEqual(ONBOARD_MODEL, { model: "claude-code-cli/opus", thinking: "medium" });
  assert.deepEqual(onboardModel({}, ["claude-code-cli/opus", ONBOARD_FALLBACK.model]), ONBOARD_MODEL);
  assert.deepEqual(onboardModel({}, ["anthropic/claude-sonnet-5", ONBOARD_FALLBACK.model]), { model: "openai-codex/gpt-6-astra", thinking: "medium" });
  // Neither offered: keep the default, so the session's open says what it can't take.
  assert.deepEqual(onboardModel({ model: "  " }, ["zai/glm-5.3"]), ONBOARD_MODEL);
});

test("refusals: a remote folder, then a missing one, then no playbook", () => {
  assert.equal(onboardInvalid(facts()), null);
  assert.equal(onboardInvalid(facts({ remote: "vps", rootExists: false, playbook: null })), "Motors's folder is on vps: the playbook runs only on a local folder.");
  assert.equal(onboardInvalid(facts({ rootExists: false, playbook: null })), "Motors's folder /w/motors is missing on this host.");
  assert.equal(onboardInvalid(facts({ playbook: null })), 'No playbook "project-verbs" is listed for Motors.');
  const refused = onboardStartFrom(facts({ playbook: null }), { why: "first time" }, null);
  assert.equal(refused.prompt, "");
  assert.match(refused.invalid ?? "", /No playbook/);
});

test("the first prompt is the playbook's turn plus the why; the title names the project", () => {
  const s = onboardStartFrom(facts(), { why: "  bb.edn gained a worker  " }, null);
  assert.equal(s.invalid, undefined);
  assert.equal(s.title, "Project verbs: Motors");
  assert.ok(s.prompt.startsWith("Playbook: Project verbs — /x/playbooks/project-verbs\n"));
  assert.ok(s.prompt.endsWith("\n---\n\nbb.edn gained a worker\n"));
  assert.ok(!onboardStartFrom(facts(), { why: " " }, null).prompt.includes("---"));
});

test("the shipped catalog lists project-verbs for any folder, with its PLAYBOOK.md body", async () => {
  const cat = await listPlaybooks(fileURLToPath(new URL("../../", import.meta.url)), { userDir: "/nonexistent-user-playbooks" });
  const p = linkedPlaybook(cat.playbooks, ONBOARD_PLAYBOOK_ID, "sova");
  assert.ok(p, "listed");
  assert.equal(p.source, "sova");
  assert.equal(p.title, "Project verbs");
  assert.match(p.body, /At most 6 conform runs/);
});
