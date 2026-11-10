// §chat.worktrees/retirement end to end on a throwaway server (server/testing/hermetic-server.ts): a real chat process
// and the stand-in model. Reading a chat whose worktree retired brings nothing back; a message does, before the turn,
// and the model hears it in Sova's words. And the server this all runs on, a test copy, retires nothing by itself.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "./merge-queue/testing/repo";
import { appendLedger } from "./removed-worktrees";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";
import { until } from "./test-wait";

/** A loopback proxy before the stand-in model that keeps every request body. */
async function recorder(mockPort: number): Promise<{ port: number; bodies: string[]; close: () => void; holdNext: () => () => void }> {
  const bodies: string[] = [];
  let held: Promise<void> | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      bodies.push(body.toString("utf8"));
      const wait = held;
      held = null;
      await wait;
      const out = request({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (back) => {
        res.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(res);
      });
      out.end(body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    bodies,
    close: () => server.close(),
    // The next request is seen at once and answered only at the call this returns: its turn stays running until then.
    holdNext: () => {
      let release = () => {};
      held = new Promise<void>((go) => (release = go));
      return () => release();
    },
  };
}

/** A repository beside the server's scratch: main checkout, and a worktree whose branch has landed by a real merge. */
function repoWithFinishedWorktree(server: HermeticServer) {
  const parent = join(realpathSync(server.scratch), "projects");
  const main = join(parent, "demo");
  mkdirSync(main, { recursive: true });
  git(main, ["init", "-q", "-b", "master"]);
  writeFileSync(join(main, "README.md"), "# demo\n");
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "base"]);
  const path = join(parent, ".worktrees", "demo-x");
  git(main, ["worktree", "add", "-q", "-b", "feat/x", path, "master"]);
  writeFileSync(join(path, "x.txt"), "x\n");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", "x"]);
  const tip = git(path, ["rev-parse", "HEAD"]);
  git(main, ["merge", "-q", "--no-ff", "--no-edit", "feat/x"]);
  return { main, path, tip, branch: "feat/x" };
}

/** A chat in a finished worktree, its first message sent (`first` runs before it), and what retires that worktree. */
async function chatToRetire(server: HermeticServer, proxy: Awaited<ReturnType<typeof recorder>>) {
  const modelsFile = join(server.agentDir, "models.json");
  writeFileSync(modelsFile, readFileSync(modelsFile, "utf8").replaceAll(`127.0.0.1:${server.mockPort}`, `127.0.0.1:${proxy.port}`));
  const r = repoWithFinishedWorktree(server);
  const headers = { "content-type": "application/json", "x-sova-token": server.token };
  const api = (path: string, body?: unknown) => fetch(`${server.base}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const made = await api("/api/sessions", { cwd: r.path });
  assert.equal(made.status, 201, await made.clone().text());
  const { path: session } = (await made.json()) as { path: string };
  const first = await api("/api/sessions/prompt", { path: session, text: "Hello." });
  assert.ok(first.status < 300, await first.clone().text());
  await until(() => proxy.bodies.length > 0, "the first turn reached the model");

  /** Retired as the removal step leaves it: pinned, folder and branch gone, in the ledger. Master then moves on. Answers the newest commit. */
  const retire = (): string => {
    git(r.main, ["update-ref", `refs/sova/retired/${r.tip}`, r.tip]);
    git(r.main, ["worktree", "remove", "--force", "--force", r.path]);
    git(r.main, ["branch", "-D", r.branch]);
    const commonDir = realpathSync(join(r.main, ".git"));
    appendLedger([{ v: 1, path: r.path, branch: r.branch, commonDir, tip: r.tip, merged: "ancestor", branchDeleted: true, at: Date.now(), retired: true, pinned: true }], join(server.agentDir, "sova", "removed-worktrees.json"));
    writeFileSync(join(r.main, "newer.txt"), "n\n");
    git(r.main, ["add", "-A"]);
    git(r.main, ["commit", "-q", "-m", "master moves on"]);
    return git(r.main, ["rev-parse", "HEAD"]);
  };
  return { r, api, session, retire };
}

// A message queued behind a running turn joins that run, where no turn-start hook fires: the case that made the test below
// intermittent. Held here so it happens every time, and asserted on the request that first carries the message.
test("a message queued behind a running turn, its folder coming back: the request that carries it tells the model", { timeout: 180_000 }, async () => {
  const server = await startHermeticServer();
  const proxy = await recorder(server.mockPort);
  try {
    const release = proxy.holdNext();
    const { r, api, session, retire } = await chatToRetire(server, proxy);
    const newest = retire();
    const sent = await api("/api/sessions/prompt", { path: session, text: "Carry on." });
    assert.ok(sent.status < 300, await sent.clone().text());
    assert.equal(((await sent.json()) as { queued: boolean }).queued, true, "the case itself: it queued behind the running turn");
    await until(() => existsSync(join(r.path, ".git")), "the folder to come back");
    release();
    const carrying = () => proxy.bodies.find((x) => x.includes("Carry on."));
    await until(carrying, "the queued message to reach the model");
    assert.ok(carrying()!.includes(`Your worktree was retired after ${r.branch} landed.`), `the model is told by the time it reads the message; it ends: ${carrying()!.slice(-800)}`);
    assert.ok(carrying()!.includes(`fresh from master at ${newest.slice(0, 7)}`));
  } finally {
    proxy.close();
    await server.stop();
  }
});

test("reading a retired chat brings nothing back; a message does, before the turn, and the model is told", { timeout: 180_000 }, async () => {
  const server = await startHermeticServer();
  const proxy = await recorder(server.mockPort);
  try {
    const { r, api, session, retire } = await chatToRetire(server, proxy);
    const newest = retire();

    // Reading: the session's page data, twice. A wait of one read's length can't prove an absence by itself: the folder
    // is checked after each read has answered, which is when a read that brought it back would have.
    for (const path of [`/api/sessions/transcript?path=${encodeURIComponent(session)}`, "/api/sessions"]) {
      await (await api(path)).text();
      assert.equal(existsSync(r.path), false, `${path} brought the folder back`);
    }
    assert.equal(git(r.main, ["branch", "--list", r.branch]), "", "reading made no branch");

    const before = proxy.bodies.length;
    const sent = await api("/api/sessions/prompt", { path: session, text: "Carry on." });
    assert.ok(sent.status < 300, await sent.clone().text());
    await until(() => existsSync(join(r.path, ".git")), "the folder to come back");
    assert.equal(git(r.path, ["rev-parse", "--abbrev-ref", "HEAD"]), r.branch);
    assert.equal(git(r.path, ["rev-parse", "HEAD"]), newest, "fresh from the newest target");
    // The stand-in sees every request of the turn; the line reaches the model in one of them, and stays in the rest.
    const toldBody = () => proxy.bodies.slice(before).find((x) => x.includes(`Your worktree was retired after ${r.branch} landed.`));
    await until(toldBody, "the model to be told").catch(() => null);
    const told = toldBody();
    assert.ok(told, `the model is told. ${proxy.bodies.length - before} requests since; the last ends: ${proxy.bodies.at(-1)!.slice(-800)}`);
    assert.ok(told.includes(`fresh from master at ${newest.slice(0, 7)}`));
  } finally {
    proxy.close();
    await server.stop();
  }
});

test("a test copy of Sova retires nothing: its service says it's off, and a finished worktree of a project it knows stays", { timeout: 120_000 }, async () => {
  const server = await startHermeticServer();
  try {
    const r = repoWithFinishedWorktree(server);
    await until(() => /\[retire\] off/.test(server.log()), "the service to say it's off");
    assert.ok(existsSync(join(r.path, "x.txt")));
    assert.ok(git(r.main, ["branch", "--list", r.branch]).includes(r.branch));
    assert.equal(existsSync(join(server.agentDir, "sova", "retire.lock")), false, "it never took the machine's lock");
    assert.equal(existsSync(join(server.agentDir, "sova", "retire-pending.json")), false, "it wrote no report");
  } finally {
    await server.stop();
  }
});
