// Run: pnpm test. What a decision sends out (§app.decisions/privacy): every request, whichever feature builds it and
// whichever provider answers, passes the one outgoing path (redactForOutside). Jev is a fake fetch, the fallback model a
// fake runtime; both record the bytes they were handed. A throwaway HOME and agent dir: no real credential file is read.
// Every fake secret is built by concatenation so no scanner takes this file for a leak.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-decide-outgoing-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_JEV_KEY;
after(() => rmSync(root, { recursive: true, force: true }));

const { createDecisionRuntime } = await import("./decide-runtime");
const { decisionDefaults } = await import("./decide-settings");
const { labelRequest } = await import("./message-labeller");
const { cardState, CARD_QUESTIONS } = await import("./attention-signals");
import type { DecisionPurpose, DecisionRequest, Question } from "./decide";
import type { OwnMessage } from "./message-input";

/** Hidden on the way out: each by name, so a failure says which form leaked. */
const SECRETS = {
  email: "jane.doe+work" + "@" + "example.co.uk",
  "second email": "ops" + "@" + "example.org",
  "glpat-": "glpat-" + "FAKEfake0123456789abcd",
  "ghp_": "ghp_" + "FAKEfake0123456789abcdefFAKEfake0123",
  "gho_": "gho_" + "FAKEfake0123456789abcdefFAKEfake0123",
  "sk-": "sk-" + "proj-FAKEfakeFAKEfake1234567890",
  "xoxb-": "xoxb-" + "123456789012-FAKEfakeFAKE",
  AKIA: "AKIA" + "FAKE0123456789AB",
  JWT: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0In0" + "." + "FAKEsig_0123456789",
  "long hex": "d41d8cd9" + "8f00b204e9800998ecf8427e",
  "base64 blob": "dGhpcyBpcyBhIHNl" + "Y3JldCBibG9iIDEyMzQ1Njc4OQ==",
  "unprefixed key": "Zx8Kq2LmP9vR4tYw" + "7NbC3dFh6JsG1aE5",
  "URL password": "hunter2pass",
} satisfies Record<string, string>;
const PASTED = Object.entries(SECRETS)
  .map(([name, v]) => (name === "URL password" ? `https://bob:${v}@git.example.com/repo.git` : `${name} ${v}`))
  .join(", ");

/** Left as is: what the redaction must not eat. */
const ORDINARY = [
  "3302ca6",
  "04aac515e9d3f1b2c4a5e6f7a8b9c0d1e2f3a4b5",
  "550e8400-e29b-41d4-a716-446655440000",
  "server/overseer-redact.ts",
  "src/components/Button2Group",
  "createDecisionRuntime",
  "utf8ToBase64v2",
  "MAX_STATE_CHARS_32000",
  "@acme/some-package@1.0.3",
];
const PROSE = `Fix commit ${ORDINARY[0]} (full ${ORDINARY[1]}) for session ${ORDINARY[2]}: see ${ORDINARY[3]}, ${ORDINARY[4]}, ${ORDINARY[5]}, ${ORDINARY[6]}, ${ORDINARY[7]} and ${ORDINARY[8]}.`;

const KEY = "tsk-fake-" + "k".repeat(60);

/** The answer doesn't matter here (each provider fails after recording what it was handed), only the bytes sent. */
const ask = (rt: { provider: { decide(r: DecisionRequest): Promise<unknown> } }, req: DecisionRequest) => rt.provider.decide(req).catch(() => undefined);

/** A runtime whose Jev records each body, and whose fallback model records each context (Jev down: `jevDown`). */
function capture(jevDown = false) {
  const sent: string[] = [];
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    if (jevDown) throw new TypeError("fetch failed");
    sent.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ detail: "the test reads the request only" }), { status: 529 });
  }) as unknown as typeof globalThis.fetch;
  const runtime = {
    getModel: () => ({ id: "m", reasoning: false }),
    hasConfiguredAuth: () => true,
    completeSimple: async (_m: never, context: unknown) => {
      sent.push(JSON.stringify(context));
      throw new Error("the test reads the request only");
    },
  };
  const rt = createDecisionRuntime({
    settings: () => ({ ...decisionDefaults(), jev: { enabled: true }, fallback: { backend: "pi", model: "prov/model-x", effort: "off" } }),
    key: () => ({ key: KEY, source: "file" }),
    fetch,
    llm: { runtime: async () => runtime as never, denial: () => null },
    callsFile: null,
  });
  return { rt, sent };
}

/** Each secret form absent from every captured request, each ordinary string present. */
function assertClean(sent: string[], ordinary = true) {
  assert.ok(sent.length > 0, "a request went out");
  for (const body of sent) {
    assert.deepEqual(Object.keys(SECRETS).filter((name) => body.includes(SECRETS[name as keyof typeof SECRETS])), [], "these left the machine");
    if (ordinary) assert.deepEqual(ORDINARY.filter((o) => !body.includes(o)), [], "ordinary text was hidden");
  }
}

const ownMessage = (text: string): OwnMessage => ({ id: "m1", sentAt: 1, action: null, text, image: false, previousReply: PROSE, delivered: false }) as unknown as OwnMessage;

describe("what a decision sends out passes the one path (§app.decisions/privacy)", () => {
  test("a message's label: emails and every token form hidden, ordinary text kept", async () => {
    const { rt, sent } = capture();
    await ask(rt, labelRequest("s1", ownMessage(`Use these: ${PASTED}. ${PROSE}`)));
    assertClean(sent);
  });

  test("the turn check: hidden on the way to Jev and to the fallback model", async () => {
    for (const jevDown of [false, true]) {
      const { rt, sent } = capture(jevDown);
      const state = cardState(`Deploy ${SECRETS.email}`, { lastUser: `deploy with ${PASTED}`, assistantLast: `Done. ${PROSE}`, stopReason: "stop" }, { openQuestions: 0, workersRunning: 0, restartPending: false });
      await ask(rt, { purpose: "attention", state, questions: CARD_QUESTIONS, dedupeKey: `t:${jevDown}` });
      assertClean(sent);
    }
  });

  // Every purpose, with the secrets in the state and in the questions (align-triage's carry a document's words).
  const PURPOSES = ["attention", "worker", "tags", "probe", "reconcile", "merge-followup", "align-triage", "worker-report", "message-label"] as const satisfies readonly DecisionPurpose[];
  // A purpose added to DecisionPurpose and not listed here fails the typecheck.
  const everyPurpose: [Exclude<DecisionPurpose, (typeof PURPOSES)[number]>] extends [never] ? true : never = true;
  void everyPurpose;
  for (const purpose of PURPOSES)
    test(`every request: ${purpose}`, async () => {
      const { rt, sent } = capture();
      const questions: Record<string, Question> = {
        q: { type: "choice", instructions: `Which one? ${PASTED}`, options: { a: `the doc says ${SECRETS["glpat-"]}`, b: "the other" } },
      };
      const req: DecisionRequest = { purpose, state: { text: `${PASTED}. ${PROSE}`, nested: [{ deep: SECRETS.JWT }] }, questions, dedupeKey: purpose };
      await ask(rt, req);
      assertClean(sent);
      assert.equal(sent.length, 2, "Jev and the fallback model were both asked");
      const body = JSON.parse(sent[0]!) as { questions: Record<string, { options?: string[] }> };
      assert.deepEqual(Object.keys(body.questions), ["q"], "the question keys stay");
    });

  test("only the redacting runtime builds a provider: no other server module reaches Jev, the chain or the model", () => {
    const here = join(import.meta.dirname, ".");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const rel = p.slice(here.length + 1);
          if (["decide-runtime.ts", "decide-chain.ts", "decide-jev.ts", "decide-llm.ts"].includes(rel)) continue;
          if (/\bcreate(?:JevProvider|DecisionChain|LlmProvider)\b/.test(readFileSync(p, "utf8"))) offenders.push(rel);
        }
      }
    };
    walk(here);
    assert.deepEqual(offenders, []);
  });
});
