// Run: pnpm test:int -- server/harness/pi/sign-in.integration.test.ts. pi's own openai-codex login behind
// Settings → Accounts (§app.openai-login, quirk P37's browser half): the browser route listens on
// localhost:1455 while it waits; a pasted address that isn't the page's keeps it waiting; cancel and
// the 15-minute end abort pi's login and leave the port free, with nothing saved. No network: the
// browser route reaches OpenAI only to exchange a code, which these tests never give it.
// When something else holds 1455 (the Codex CLI), pi waits on the paste alone and the port checks are skipped.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { OpenAiAccountInfo, OpenAiLoginFlow } from "../../../shared/protocol";
import { OpenAiLoginService } from "../../openai-login";
import { piProviderSignIn } from "./sign-in";

const dir = mkdtempSync(join(tmpdir(), "sova-pi-sign-in-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const authPath = join(dir, "auth.json");
const paths = { claudeCreds: join(dir, "claude.json"), piAuth: authPath, codexAuth: join(dir, "codex.json") };

const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});

const saved = () => existsSync(authPath) && JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"] !== undefined;

function service(flowMs?: number) {
  return new OpenAiLoginService({
    signIn: piProviderSignIn(() => authPath),
    paths: () => paths,
    meshSharesLogins: () => false,
    apiKeysOnly: () => false,
    ...(flowMs ? { timeouts: { flow: flowMs } } : {}),
  });
}

describe("pi's OpenAI sign-in, the browser route", () => {
  test("waits on localhost:1455 with a link carrying its state; a wrong address keeps it waiting; cancel frees the port", async () => {
    const free = await portFree(1455);
    const svc = service();
    const started = await svc.start({ method: "browser" });
    const flow = started.body as Extract<OpenAiLoginFlow, { state: "browser" }>;
    assert.equal(flow.state, "browser", JSON.stringify(started.body));
    const link = new URL(flow.url);
    assert.equal(link.host, "auth.openai.com");
    assert.ok(link.searchParams.get("state"));
    if (free) assert.equal(await portFree(1455), false, "pi listens on localhost:1455 while it waits");
    const wrong = await svc.answer({ text: `http://localhost:1455/auth/callback?code=x&state=not-${link.searchParams.get("state")}` });
    assert.equal((wrong.body as OpenAiLoginFlow).state, "browser");
    assert.match((wrong.body as { error?: string }).error ?? "", /another sign-in/);
    const cancelled = await svc.cancel();
    assert.equal((cancelled.body as OpenAiAccountInfo).flow, null);
    if (free) assert.equal(await portFree(1455), true, "localhost:1455 is free once cancel answered");
    assert.equal(saved(), false);
  });

  test("left alone it ends itself and frees the port", async () => {
    const free = await portFree(1455);
    const svc = service(300);
    const started = await svc.start({ method: "browser" });
    assert.equal((started.body as OpenAiLoginFlow).state, "browser");
    await svc.settled();
    assert.equal(svc.flowState()?.state, "expired");
    if (free) assert.equal(await portFree(1455), true, "localhost:1455 is free after the timeout");
    assert.equal(saved(), false);
  });
});
