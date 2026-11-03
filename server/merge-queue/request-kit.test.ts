// Run: pnpm test server/merge-queue/request-kit.test.ts
// The request skill folder (server/merge-queue/hosts/request-kit.ts, q13/a18) in-process: loading a folder (never
// outside the project), the repo's own template, the brief, the plain default, and the rewrite loop: a failing check
// sends the text back with its reason, a check that can't run refuses (fail closed). Check scripts are stood in by an
// injected runner here; request-kit.integration.test.ts runs real ones, the shipped example kit's included.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { scratchRoot } from "../test-scratch";
// @ts-expect-error: the example kit's plain .mjs check, typed by use here
import { problem } from "../../.sova/playbooks/request/scripts/check.mjs";
import { checkRequestText, DEFAULT_PLAYBOOK, draftRequest, loadRequestKit, plainRequestText, type RequestInput, type RequestKit, repoTemplate, requestBrief, SIGNATURE, signed } from "./hosts/request-kit";

const INPUT: RequestInput = { host: "github", branch: "feat/x", base: "main", chatTitle: "Show the host's checks", note: "Cards follow the host.", checksPassed: ["unit", "integration"], reviewNotes: "ok", specsChanged: ["§app.merge-queue/view: the host group"] };

function project(): string {
  const root = scratchRoot("request-kit");
  mkdirSync(join(root, "kit", "references"), { recursive: true });
  mkdirSync(join(root, "kit", "scripts"), { recursive: true });
  writeFileSync(join(root, "kit", "PLAYBOOK.md"), "# House\nWrite well.\n");
  writeFileSync(join(root, "kit", "references", "style.md"), "Be short.\n");
  writeFileSync(join(root, "kit", "scripts", "check.mjs"), "process.exit(0)\n");
  writeFileSync(join(root, "kit", "scripts", "check-words.mjs"), "process.exit(0)\n");
  writeFileSync(join(root, "kit", "scripts", "helper.mjs"), "// not a check\n");
  return root;
}

describe("loading a request folder", () => {
  test("the playbook, references and check scripts (check*.mjs only, in name order)", () => {
    const root = project();
    const kit = loadRequestKit(root, "kit", "github") as RequestKit;
    assert.ok(!("error" in kit));
    assert.match(kit.playbook, /Write well/);
    assert.deepEqual(kit.references.map((r) => r.name), ["style.md"]);
    assert.deepEqual(kit.checks.map((c) => c.split("/").pop()), ["check-words.mjs", "check.mjs"]);
  });

  test("no folder: the plain default playbook, no checks", () => {
    const kit = loadRequestKit(project(), null, "github") as RequestKit;
    assert.equal(kit.folder, null);
    assert.equal(kit.playbook, DEFAULT_PLAYBOOK);
    assert.deepEqual(kit.checks, []);
  });

  test("a named folder that is missing, outside, or without a playbook is an error, never skipped", () => {
    const root = project();
    assert.match((loadRequestKit(root, "nope", "github") as { error: string }).error, /isn't in the project/);
    assert.match((loadRequestKit(root, "../x", "github") as { error: string }).error, /inside the project/);
    assert.match((loadRequestKit(root, "/etc", "github") as { error: string }).error, /inside the project/);
    const out = scratchRoot("request-kit-out");
    writeFileSync(join(out, "PLAYBOOK.md"), "x");
    symlinkSync(out, join(root, "linked"));
    assert.match((loadRequestKit(root, "linked", "github") as { error: string }).error, /leads outside/);
    mkdirSync(join(root, "empty"));
    assert.match((loadRequestKit(root, "empty", "github") as { error: string }).error, /no PLAYBOOK\.md/);
  });

  test("a reference that links outside the folder is not read", () => {
    const root = project();
    const secret = join(scratchRoot("request-kit-secret"), "s.md");
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, join(root, "kit", "references", "leak.md"));
    const kit = loadRequestKit(root, "kit", "github") as RequestKit;
    assert.ok(!kit.references.some((r) => r.text.includes("SECRET")));
  });
});

describe("the repo's own template", () => {
  test("GitHub's pull_request_template; GitLab's Default (or only) merge request template", () => {
    const root = project();
    assert.equal(repoTemplate(root, "github"), null);
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), "## Ticket\n");
    assert.deepEqual(repoTemplate(root, "github"), { path: ".github/PULL_REQUEST_TEMPLATE.md", text: "## Ticket\n" });
    assert.equal(repoTemplate(root, "gitlab"), null, "GitHub's template isn't GitLab's");
    mkdirSync(join(root, ".gitlab", "merge_request_templates"), { recursive: true });
    writeFileSync(join(root, ".gitlab", "merge_request_templates", "Bug.md"), "## Bug\n");
    assert.equal(repoTemplate(root, "gitlab")?.text, "## Bug\n", "the only template");
    writeFileSync(join(root, ".gitlab", "merge_request_templates", "Default.md"), "## Default\n");
    assert.equal(repoTemplate(root, "gitlab")?.text, "## Default\n");
    const kit = loadRequestKit(root, "kit", "gitlab") as RequestKit;
    assert.match(requestBrief(kit, { ...INPUT, host: "gitlab" }), /The repo's own template \(\.gitlab\/merge_request_templates\/Default\.md\)/);
  });
});

describe("the brief and the plain text", () => {
  test("the brief carries the playbook, references and every fact", () => {
    const kit = loadRequestKit(project(), "kit", "github") as RequestKit;
    const b = requestBrief(kit, INPUT);
    for (const s of ["Write well", "Reference: style.md", "feat/x into main", "a GitHub pull request", "Show the host's checks", "Cards follow the host.", "unit, integration", "§app.merge-queue/view", SIGNATURE]) assert.ok(b.includes(s), s);
    assert.match(requestBrief(kit, { ...INPUT, checksPassed: [] }), /none \(the project has no automated tests\)/);
  });

  test("plain text: the chat's title, the facts, ending Opened by Sova", () => {
    const t = plainRequestText(INPUT);
    assert.equal(t.title, "Show the host's checks");
    assert.match(t.body, /Cards follow the host\./);
    assert.match(t.body, /- unit: passed/);
    assert.match(t.body, /§app\.merge-queue\/view/);
    assert.ok(t.body.trimEnd().endsWith(SIGNATURE));
    assert.match(plainRequestText({ ...INPUT, checksPassed: [] }).body, /No automated tests/);
    assert.equal(plainRequestText({ ...INPUT, chatTitle: "a\nb" }).title, "a b");
  });

  test("signed() adds the signature once", () => {
    assert.equal(signed("x"), `x\n\n${SIGNATURE}\n`);
    assert.equal(signed(`x\n\n${SIGNATURE}\n\n`), `x\n\n${SIGNATURE}\n`);
  });
});

type Run = NonNullable<Parameters<typeof checkRequestText>[3]>["run"];
const runs = (answer: (script: string, input: { title: string; body: string }) => { code: number; stderr?: string; timedOut?: true; failedToStart?: string }) => {
  const seen: { script: string; cwd: string; env: NodeJS.ProcessEnv; input: unknown }[] = [];
  const run: Run = async (script, input, opts) => {
    seen.push({ script, cwd: opts.cwd, env: opts.env, input: JSON.parse(input) });
    const a = answer(script, JSON.parse(input));
    return { stdout: "", stderr: a.stderr ?? "", code: a.code, ...(a.timedOut ? { timedOut: a.timedOut } : {}), ...(a.failedToStart ? { failedToStart: a.failedToStart } : {}) };
  };
  return { run, seen };
};

describe("checking and rewriting", () => {
  test("each check gets the text as JSON, in the folder, with no host sign-in in its environment", async () => {
    const kit = loadRequestKit(project(), "kit", "github") as RequestKit;
    const r = runs(() => ({ code: 0 }));
    const prev = { GH_TOKEN: process.env.GH_TOKEN, GITLAB_TOKEN: process.env.GITLAB_TOKEN };
    process.env.GH_TOKEN = "fake-gh-01";
    process.env.GITLAB_TOKEN = "fake-gl-01";
    try {
      const out = await checkRequestText(kit, { title: "T", body: "B" }, INPUT, { run: r.run });
      assert.deepEqual(out.checks.map((c) => [c.name, c.ok]), [["Sova", true], ["check-words.mjs", true], ["check.mjs", true]]);
    } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    assert.equal(r.seen.length, 2);
    assert.deepEqual(r.seen[0]!.input, { title: "T", body: "B", host: "github", branch: "feat/x", base: "main" });
    assert.equal(r.seen[0]!.cwd, kit.folder);
    const env = r.seen[0]!.env;
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITLAB_TOKEN, undefined);
    assert.notEqual(env.HOME, process.env.HOME, "a throwaway HOME, so no tool finds the sign-in");
  });

  test("Sova's own checks run first: an empty or two-line title never reaches the folder's", async () => {
    const kit = loadRequestKit(project(), "kit", "github") as RequestKit;
    const r = runs(() => ({ code: 0 }));
    const out = await checkRequestText(kit, { title: "a\nb", body: "B" }, INPUT, { run: r.run });
    assert.deepEqual(out.checks, [{ name: "Sova", ok: false, why: "the title must be one line" }]);
    assert.equal(r.seen.length, 0);
  });

  test("a failing check sends the text back with its reason, and the rewrite passes", async () => {
    const kit = loadRequestKit(project(), "kit", "github") as RequestKit;
    const r = runs((script, t) => (script.endsWith("check.mjs") && /\.$/.test(t.title) ? { code: 1, stderr: "the title ends with a period; drop it\n" } : { code: 0 }));
    const briefs: string[] = [];
    const rejections: unknown[] = [];
    const out = await draftRequest({
      kit,
      input: INPUT,
      run: r.run,
      draft: async (brief, rejection) => {
        briefs.push(brief);
        rejections.push(rejection);
        return rejection ? { title: rejection.text.title.replace(/\.$/, ""), body: rejection.text.body } : { title: "Show the host's checks.", body: "Body" };
      },
    });
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.ok && out.title, "Show the host's checks");
    assert.ok(out.ok && out.body.trimEnd().endsWith(SIGNATURE), "signed");
    assert.equal(out.ok && out.attempts, 2);
    assert.equal(rejections[0], null);
    assert.deepEqual((rejections[1] as { failed: unknown }).failed, { name: "check.mjs", ok: false, why: "the title ends with a period; drop it" });
    assert.deepEqual(out.checks.map((c) => c.ok), [true, true, true]);
  });

  test("still failing after the last attempt: refused with the reason", async () => {
    const kit = loadRequestKit(project(), "kit", "github") as RequestKit;
    const r = runs((script) => (script.endsWith("check-words.mjs") ? { code: 1, stderr: "too long" } : { code: 0 }));
    const out = await draftRequest({ kit, input: INPUT, run: r.run, maxAttempts: 2, draft: async () => ({ title: "T", body: "B" }) });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.why, "The request's text failed the check check-words.mjs 2 times: too long");
    assert.equal(out.rejections.length, 2);
    assert.deepEqual(!out.ok && out.text, { title: "T", body: `B\n\n${SIGNATURE}\n` }, "the last text, for the user to edit and publish anyway");
  });

  test("a check that can't run or runs too long refuses at once (fail closed), never retried", async () => {
    const kit = loadRequestKit(project(), "kit", "github") as RequestKit;
    let drafts = 0;
    const draft = async () => (drafts++, { title: "T", body: "B" });
    const slow = await draftRequest({ kit, input: INPUT, run: runs(() => ({ code: 124, timedOut: true })).run, draft, timeoutMs: 1000 });
    assert.equal(!slow.ok && slow.why, "The request folder's check check-words.mjs ran past 1 s");
    const broken = await draftRequest({ kit, input: INPUT, run: runs(() => ({ code: 127, failedToStart: "spawn EACCES" })).run, draft });
    assert.match(!broken.ok ? broken.why : "", /couldn't run: spawn EACCES/);
    assert.equal(drafts, 2);
  });

  test("a drafter that throws is refused with sanitized words", async () => {
    const kit = loadRequestKit(project(), null, "github") as RequestKit;
    const tok = "ghp_" + "FAKE0123456789abcdefFAKE0123";
    const out = await draftRequest({ kit, input: INPUT, draft: async () => { throw new Error(`model failed ${tok}`); } });
    assert.equal(out.ok, false);
    assert.ok(!out.ok && out.why.startsWith("Writing the request's text failed") && !out.why.includes(tok));
  });

  test("no folder and no drafter: the plain text, one attempt", async () => {
    const kit = loadRequestKit(project(), null, "github") as RequestKit;
    const out = await draftRequest({ kit, input: INPUT });
    assert.ok(out.ok);
    assert.equal(out.ok && out.title, "Show the host's checks");
    assert.equal(out.ok && out.attempts, 1);
  });
});

describe("the example kit's check (.sova/playbooks/request)", () => {
  const body = "## Why\nx\n\n## What changes\n- y\n\n## Checks\n- unit: passed\n\nOpened by Sova\n";
  test("passes the house style; names what to fix otherwise", () => {
    assert.equal(problem({ title: "Merge queue: show the host's checks", body }), null);
    assert.match(problem({ title: "x".repeat(73), body }), /keep it to 72/);
    assert.match(problem({ title: "Add x.", body }), /period/);
    assert.match(problem({ title: "WIP: add x", body }), /WIP/);
    assert.match(problem({ title: "add x", body }), /capital/);
    assert.match(problem({ title: "Add x", body: body.replace("## Checks", "## Tests") }), /"## Checks"/);
    assert.match(problem({ title: "Add x", body: body.replace("Opened by Sova", "") }), /Opened by Sova/);
  });
});
