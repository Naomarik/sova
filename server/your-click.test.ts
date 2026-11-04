// Run: pnpm test -- server/your-click.test.ts
// §app.access/your-click, door by door, over the real routes: a call with the token and no page proof is refused
// with the words that say where to click, the protected state does not change, and a page-shaped call passes.
// Lowering a sandbox is in server/your-click-sandbox.test.ts (it needs the extension); the mode door's real
// approval in server/project-modes-chat.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-your-click-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sova"), { recursive: true });
linkPiConfigExtensions(join(root, "agent"));
await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { disposeAllChats } = await import("./chat-manager");
const { registerProjectIn } = await import("./projects/spaces");
const po = await import("./project-overseer");
const { projectOverseerPaths, readPoSettings } = await import("./project-overseer-store");
const { OVERSEER_SENDER_HEADER, senderSecret } = await import("./overseer-sender");
const { offersTrustFile, runFingerprint, runsApproved } = await import("./session-offers-trust");
const { canonicalRoot, readOffersFile } = await import("./session-offers");
const { clickProofFor, peerClickProven, takeClick } = await import("./mesh/click-proof");
const { trustFile } = await import("./profile-trust");
const { pageHeaders } = await import("./testing/page");
const { notPage } = await import("./page-only");
after(() => disposeAllChats());

const json = { "content-type": "application/json" };
const TOKEN = "x-sova-token";
const SCHEDULE_PEER = "This computer couldn't confirm your click with the one the schedule is on. Try Approve again, or approve it on that computer's page. Nothing was approved.";
const PEER = "Only the user approves this, on the page of the computer it belongs to. Open Sova on that computer. Nothing changed.";

/** Everyone who isn't the page. The token in a header is the real token: having it proves nothing. */
const notTheUser = (): [string, Record<string, string>, Record<string, unknown> | undefined][] => [
  ["the token in a header", { [TOKEN]: pageHeaders().cookie!.split("=")[1]! }, undefined],
  ["the token in a header beside the page's cookie", { [TOKEN]: pageHeaders().cookie!.split("=")[1]!, ...pageHeaders() }, undefined],
  ["a chat's key", { "x-sova-caller": "a-chat-key" }, undefined],
  ["a chat's key beside the page's cookie", { "x-sova-caller": "a-chat-key", ...pageHeaders() }, undefined],
  ["an in-process dispatch (a card's button)", { "x-sova-command": "session.sandbox.set" }, undefined],
  ["no mark at all", {}, undefined],
  ["a wrong cookie", { cookie: `${pageHeaders().cookie!.split("=")[0]}=nope` }, undefined],
];
const peers = (): [string, Record<string, string>, Record<string, unknown> | undefined][] => [
  ["a mesh peer", {}, { meshPeer: { id: "other", nodeId: "n" } }],
  ["a peer relaying a browser", { "X-Sova-Relayed": "1", ...pageHeaders() }, undefined],
];

const call = (method: string, url: string, body: unknown, headers: Record<string, string>, env?: Record<string, unknown>) =>
  app.request(url, { method, headers: { ...json, ...headers }, body: JSON.stringify(body) }, env);

async function refuses(door: () => Response | Promise<Response>, words: RegExp, who: string, peer: boolean | string = false) {
  const r = await door();
  assert.equal(r.status, 403, `${who}: ${await r.clone().text()}`);
  const b = (await r.json()) as { error: string; yourClick?: boolean; peer?: boolean };
  assert.equal(b.yourClick, true, who);
  assert.equal(b.peer, peer ? true : undefined, who);
  if (peer) assert.equal(b.error, peer === true ? PEER : peer, who);
  else assert.match(b.error, words, who);
}

async function project(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".sova", "profiles"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const made = await registerProjectIn("standalone", dir, { name, origin: "folder" });
  return { dir, id: made.project.id };
}

describe("what the page has to show", () => {
  test("nothing shows the page but the install's cookie, on the main listener", () => {
    const ctx = (h: Record<string, string>, env?: unknown) => ({ env, req: { header: (n: string) => h[n] } }) as never;
    assert.equal(notPage(ctx(pageHeaders())), null);
    assert.equal(notPage(ctx({})), "script", "no mark at all is no page");
    assert.equal(notPage(ctx(pageHeaders(), { meshPeer: { id: "x" } })), "local");
    assert.equal(notPage(ctx({ ...pageHeaders(), "x-sova-caller": "k" })), "chat");
    assert.equal(notPage(ctx({ ...pageHeaders(), [TOKEN]: "t" })), "script");
    assert.equal(notPage(ctx({ ...pageHeaders(), [OVERSEER_SENDER_HEADER]: senderSecret() })), "overseer");
  });
});

describe("a project's run buttons", async () => {
  const p = await project("offers");
  writeFileSync(join(p.dir, ".sova", "offers.json"), JSON.stringify({ version: 1, offers: { merge: { when: "When it is time.", title: "Merge?", buttons: [{ label: "Merge", about: "Merges now.", run: "project.worktree.merge" }] } } }));
  const url = `/api/projects/${p.id}/offers/approve`;
  const file = () => readOffersFile(canonicalRoot(p.dir));
  const seen = async () => runFingerprint(file());

  test("refused to everyone but the page, the Overseer too, and nothing is trusted", async () => {
    const fingerprint = await seen();
    assert.ok(fingerprint, "a real fingerprint, so only the door can refuse it");
    await refuses(() => call("POST", url, { fingerprint }, { [OVERSEER_SENDER_HEADER]: senderSecret() }), /Approve Run Buttons on the project page's Offers list/, "the Overseer");
    assert.equal(runsApproved(canonicalRoot(p.dir), file()), false, "the Overseer's call approved nothing");
    for (const [who, headers, env] of notTheUser()) await refuses(() => call("POST", url, { fingerprint }, headers, env), /Approve Run Buttons on the project page's Offers list/, who);
    for (const [who, headers, env] of peers()) await refuses(() => call("POST", url, { fingerprint }, headers, env), /./, who, true);
    assert.equal(existsSync(offersTrustFile()), false, "nothing was trusted");
  });

  test("a page-shaped call gets through the door", async () => {
    assert.ok(await seen(), "the file has run buttons to approve");
    assert.equal(runsApproved(canonicalRoot(p.dir), file()), false);
    const r = await call("POST", url, { fingerprint: await seen() }, pageHeaders());
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(runsApproved(canonicalRoot(p.dir), file()), true);
  });
});

describe("a profile's powers", async () => {
  const p = await project("profiles");
  writeFileSync(join(p.dir, ".sova", "profiles", "mini.json"), JSON.stringify({ id: "mini", label: "Mini", grant: ["sessions.read"], overseerMayStart: false }));
  const body = { cwd: p.dir, id: "mini", grant: ["sessions.read"], overseerMayStart: false };

  test("refused to everyone but the page, the Overseer too, and nothing is approved", async () => {
    const all = [...notTheUser(), ["the Overseer", { [OVERSEER_SENDER_HEADER]: senderSecret() }, undefined] as (typeof notTheUser extends () => (infer T)[] ? T : never)];
    for (const [who, headers, env] of all) await refuses(() => call("POST", "/api/profiles/approve", body, headers, env), /Approve in Settings → Profiles or on the profile picker/, who);
    for (const [who, headers, env] of peers()) await refuses(() => call("POST", "/api/profiles/approve", body, headers, env), /./, who, true);
    assert.equal(existsSync(trustFile()) && readFileSync(trustFile(), "utf8").includes("mini"), false, "nothing was approved");
  });

  test("a page-shaped call approves it", async () => {
    const r = await call("POST", "/api/profiles/approve", body, pageHeaders());
    assert.equal(r.status, 200, await r.clone().text());
    assert.ok(readFileSync(trustFile(), "utf8").includes("mini"));
  });
});

describe("a schedule", () => {
  const body = { cwd: "/nowhere", playbook: "p", pin: "0".repeat(16) };

  test("refused to everyone but the page, the Overseer too, and a peer without a proof", async () => {
    const before = await (await app.request("/api/schedules")).text();
    const all = [...notTheUser(), ["the Overseer", { [OVERSEER_SENDER_HEADER]: senderSecret() }, undefined] as (typeof notTheUser extends () => (infer T)[] ? T : never)];
    for (const [who, headers, env] of all) await refuses(() => call("POST", "/api/schedules/approve", body, headers, env), /Approve in the Playbooks dialog/, who);
    for (const [who, headers, env] of peers()) await refuses(() => call("POST", "/api/schedules/approve", body, headers, env), /./, who, SCHEDULE_PEER);
    await refuses(() => call("POST", "/api/schedules/approve", body, { "X-Sova-Click-Proof": "invented", "X-Forwarded-Host": "h" }, { meshPeer: { id: "other" } }), /./, "a proof nobody minted", SCHEDULE_PEER);
    assert.equal(await (await app.request("/api/schedules")).text(), before);
  });

  test("a page-shaped call gets through the door", async () => {
    const r = await call("POST", "/api/schedules/approve", body, pageHeaders());
    assert.notEqual(r.status, 403, await r.clone().text());
  });
});

describe("a Project Overseer power", async () => {
  const p = await project("powers");
  await po.ensureProjectOverseer(p.id);
  const url = `/api/projects/${p.id}/overseer`;
  const powers = () => readPoSettings(projectOverseerPaths(p.id)).powers;
  const on = { powers: { assistant: { codingStart: true } } };

  test("turning one On is refused to all but the page and the Overseer, by powers or by autonomy, and nothing changes", async () => {
    const before = JSON.stringify(powers());
    for (const body of [on, { powers: { overseer: { deploy: true } } }, { autonomy: "L3" }, { caps: { promptsPerTurn: 2 }, ...on }]) {
      for (const [who, headers, env] of notTheUser()) await refuses(() => call("PATCH", url, body, headers, env), /in the project page's Settings tab/, `${who} ${JSON.stringify(body)}`);
      for (const [who, headers, env] of peers()) await refuses(() => call("PATCH", url, body, headers, env), /./, who, true);
    }
    assert.equal(JSON.stringify(powers()), before);
  });

  test("only the widening closes: what narrows or names no power stays open to a script", async () => {
    const script = notTheUser()[0]![1];
    const caps = await call("PATCH", url, { caps: { promptsPerTurn: 3 } }, script);
    assert.equal(caps.status, 200, await caps.clone().text());
    assert.equal(readPoSettings(projectOverseerPaths(p.id)).caps.promptsPerTurn, 3);
    assert.equal((await call("PATCH", url, { watch: false }, script)).status, 200);
    assert.equal((await call("PATCH", url, { resume: true }, script)).status, 200);
    assert.equal((await call("PATCH", url, { powers: { assistant: { codingStart: false } } }, script)).status, 200, "a power already Off");
    assert.equal((await call("PATCH", url, { powers: { overseer: { nope: true } } }, script)).status, 400, "a bad body is refused for what it is");
  });

  test("the page turns one On; the Overseer keeps its own; then Off and a repeat of On stay open", async () => {
    const page = await call("PATCH", url, on, pageHeaders());
    assert.equal(page.status, 200, await page.clone().text());
    assert.equal(powers().assistant.codingStart, true);
    const script = notTheUser()[0]![1];
    assert.equal((await call("PATCH", url, on, script)).status, 200, "already On widens nothing");
    assert.equal((await call("PATCH", url, { powers: { assistant: { codingStart: false } } }, script)).status, 200);
    assert.equal(powers().assistant.codingStart, false);
    assert.equal((await call("PATCH", url, on, { [OVERSEER_SENDER_HEADER]: senderSecret() })).status, 200);
    assert.equal(powers().assistant.codingStart, true);
  });
});

describe("a click on this page that approves on another computer", () => {
  const relayed = (headers: Record<string, string>, body = "{\"pin\":\"a\"}", path = "/peer/b/api/schedules/approve") => new Request(`http://x${path}`, { method: "POST", headers, body });
  /** The proxy's own view of a request (Hono's Context, as clickProofFor reads it). */
  const seen = (r: Request, env?: unknown) => ({ env, req: { method: r.method, raw: r, header: (n: string) => r.headers.get(n) ?? undefined } }) as never;
  const TAIL = "/api/schedules/approve";

  test("this host mints a proof only for its own page, and only for the door that takes one", async () => {
    assert.ok(await clickProofFor(seen(relayed(pageHeaders())), "b", TAIL));
    assert.equal(await clickProofFor(seen(relayed({})), "b", TAIL), undefined, "no page proof");
    assert.equal(await clickProofFor(seen(relayed({ ...pageHeaders(), "x-sova-token": "t" })), "b", TAIL), undefined, "a script");
    assert.equal(await clickProofFor(seen(relayed({ ...pageHeaders(), "x-sova-caller": "k" })), "b", TAIL), undefined, "a chat");
    assert.equal(await clickProofFor(seen(relayed({ ...pageHeaders(), "X-Sova-Relayed": "1" })), "b", TAIL), undefined, "a chain through another peer");
    assert.equal(await clickProofFor(seen(relayed(pageHeaders())), "b", "/api/sandbox"), undefined, "any other door");
  });

  test("a proof is good once, for that peer and that body, and not after its minute", async () => {
    const body = "{\"pin\":\"a\"}";
    const asked = async (peer: string, b: string, at?: number) => {
      const proof = (await clickProofFor(seen(relayed(pageHeaders(), body)), "b", TAIL))!;
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256").update(b).digest("hex");
      return { proof, digest, ok: takeClick(proof, peer, digest, at) };
    };
    const good = await asked("b", body);
    assert.equal(good.ok, true);
    assert.equal(takeClick(good.proof, "b", good.digest), false, "spent");
    const wrongPeer = await asked("c", body);
    assert.equal(wrongPeer.ok, false, "another peer can't spend it");
    assert.equal(takeClick(wrongPeer.proof, "b", wrongPeer.digest), false, "and asking burnt it");
    assert.equal((await asked("b", "{\"pin\":\"z\"}")).ok, false, "another body");
    assert.equal((await asked("b", body, Date.now() + 120_000)).ok, false, "too late");
    assert.equal(takeClick("invented", "b", "x"), false);
  });

  test("after a failed proof a fresh click works: it gets a new proof, and the used and expired ones stay refused", async () => {
    const body = "{\"pin\":\"a\"}";
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(body).digest("hex");
    const click = async () => (await clickProofFor(seen(relayed(pageHeaders(), body)), "b", TAIL))!;
    // The same click spent: its check failed part-way (a wrong body here), and that spent it.
    const failed = await click();
    assert.equal(takeClick(failed, "b", "not-the-body"), false);
    assert.equal(takeClick(failed, "b", digest), false, "a failed proof isn't good a second time, even with the right body");
    // Approve again: a new click, a different proof, and it passes.
    const retry = await click();
    assert.notEqual(retry, failed);
    assert.equal(takeClick(retry, "b", digest), true);
    assert.equal(takeClick(retry, "b", digest), false, "used");
    // One past its minute is refused, and a fresh click after that passes too.
    const late = await click();
    assert.equal(takeClick(late, "b", digest, Date.now() + 61_000), false, "expired");
    assert.equal(takeClick(late, "b", digest), false, "and it stays refused");
    assert.equal(takeClick(await click(), "b", digest), true);
  });

  test("the other computer asks the host the request came from, and any doubt is no", async () => {
    const proofed = { "X-Sova-Click-Proof": "p", "X-Forwarded-Host": "h" };
    const c = (headers: Record<string, string>, id: string | undefined = "a") => ({ env: id ? { meshPeer: { id } } : {}, req: { header: (n: string) => new Headers(headers).get(n) ?? undefined } }) as never;
    const asked: string[] = [];
    const yes = async (peer: string) => (asked.push(peer), Response.json({ ok: true }));
    assert.equal(await peerClickProven(c(proofed), "{}", yes), true);
    assert.deepEqual(asked, ["a"], "the sender's identity, never a name in the request");
    assert.equal(await peerClickProven(c({}), "{}", yes), false, "no proof");
    assert.equal(await peerClickProven(c({ "X-Sova-Click-Proof": "p" }), "{}", yes), false, "not relayed for a browser");
    assert.equal(await peerClickProven(c(proofed, ""), "{}", yes), false, "not a peer");
    assert.equal(await peerClickProven(c(proofed), "{}", async () => Response.json({ ok: false })), false);
    assert.equal(await peerClickProven(c(proofed), "{}", async () => new Response("x", { status: 500 })), false);
    assert.equal(await peerClickProven(c(proofed), "{}", async () => { throw new Error("down"); }), false);
  });
});
