// A file outside the project on the device the chat came from (§app.transport/agent "A file outside the project"):
// the agent only names it; nothing reads it there before your Bring From click, and then only that one file, once,
// never one in the sandbox's hidden list, a folder or one over the cap; here it never overwrites a file already there.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { onboardModels } from "../projects/onboard";
import { afterArrival, agentOf, type AgentDeps, askOutsideFile, bringOutsideFile, placedOutsideFile } from "./agent";
import { cleanOutsidePath, OUTSIDE_FILE_MAX, readOutside, serveOutsideFile, writeOutside } from "./outside-file";
import { createTransport, readTransport } from "./store";

after(dropScratchAgentDir);

const REMOTE = "git@github.com:acme/motors.git";
const tick = () => new Promise<void>((r) => setImmediate(r));

test("the agent's path is a file in that device's home: ~/… only, no . or .. parts; an absolute path in its home reads the same", () => {
  assert.deepEqual(cleanOutsidePath("~/.config/motors/settings.json"), { rel: ".config/motors/settings.json" });
  assert.deepEqual(cleanOutsidePath("/home/desk/.config/m.json", "/home/desk"), { rel: ".config/m.json" });
  for (const bad of ["/etc/hosts", "~/../etc/passwd", "~/a/./b", "~/", "relative/file", "", "~/a//b"]) assert.ok("error" in cleanOutsidePath(bad), bad);
});

test("the device it lives on reads only one regular file: the hidden list (a symlink into it too), a folder and one over the cap are refused", () => {
  const home = scratchRoot("transport-outside-src-");
  const hidden = [join(home, ".ssh"), join(home, ".aws")];
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "secret");
  mkdirSync(join(home, ".config", "motors"), { recursive: true });
  writeFileSync(join(home, ".config", "motors", "settings.json"), '{"region":"eu"}');
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, ".config", "motors", "key"));
  writeFileSync(join(home, "big.bin"), Buffer.alloc(OUTSIDE_FILE_MAX + 1));
  const read = (rel: string) => readOutside(rel, home, hidden, [join(home, ".pi")]);
  assert.match((read(".ssh/id_ed25519") as { error: string }).error, /hidden list/);
  assert.match((read(".config/motors/key") as { error: string }).error, /hidden list/, "a symlink into the hidden list is the hidden file");
  assert.match((read(".config/motors") as { error: string }).error, /is a folder/);
  assert.match((read("big.bin") as { error: string }).error, /over the 1024 KB/);
  assert.match((read("nope.json") as { error: string }).error, /isn't on this device/);
  const ok = read(".config/motors/settings.json");
  assert.ok(ok.ok && ok.bytes.toString() === '{"region":"eu"}');
});

test("here it goes to the same path in this home, readable only by the user, and a file already there is kept as it is", () => {
  const home = scratchRoot("transport-outside-dst-");
  const put = writeOutside(".config/motors/settings.json", home, Buffer.from("new"), [join(home, ".ssh")], []);
  assert.deepEqual(put, { written: join(home, ".config/motors/settings.json") });
  assert.equal(statSync(join(home, ".config/motors/settings.json")).mode & 0o777, 0o600);
  writeFileSync(join(home, "existing.json"), "mine");
  assert.deepEqual(writeOutside("existing.json", home, Buffer.from("theirs"), [], []), { kept: join(home, "existing.json") });
  assert.equal(readFileSync(join(home, "existing.json"), "utf8"), "mine", "never overwritten");
  assert.ok("error" in writeOutside(".ssh/config", home, Buffer.from("x"), [join(home, ".ssh")], []));
});

test("the device it lives on sends that one file once per transport, and only for the device the transport went to", () => {
  const home = scratchRoot("transport-outside-src-");
  writeFileSync(join(home, "motors.env"), "A=1");
  createTransport({ tid: "tr_outside01", side: "source", mode: "move", chatId: "c", sourceChatId: "c", title: "t", peer: "air", peerLabel: "Air", path: "", folder: "/x", state: "done", steps: {} });
  const opts = { home, hidden: [join(home, ".ssh")], refused: [] };
  assert.equal(serveOutsideFile("tr_outside01", "someone", "~/motors.env", opts).status, 404);
  const first = serveOutsideFile("tr_outside01", "air", "~/motors.env", opts);
  assert.equal(first.status, 200);
  assert.equal(Buffer.from(String(first.body.data), "base64").toString(), "A=1");
  assert.equal(serveOutsideFile("tr_outside01", "air", "~/motors.env", opts).status, 409, "sent once");
  assert.equal(serveOutsideFile("tr_outside01", "air", "~/.ssh/id_rsa", opts).status, 409);
  assert.deepEqual((readTransport("tr_outside01")!.ext as { outsideSent?: string[] }).outsideSent, ["motors.env"]);
});

/** An arrived device whose agent is running, its fetch of the other device's file recorded. */
async function arrived(root: string, tid: string, over: Partial<AgentDeps> = {}) {
  const fetched: string[] = [];
  const told: string[] = [];
  let busy = 0;
  let clock = 0;
  const project = join(root, "webapps", "motors");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "Cargo.toml"), "");
  const deps: AgentDeps = {
    stateRoot: () => join(root, "state"),
    home: () => root,
    protectedRoots: () => [join(root, "state")],
    device: () => "laptop-b",
    // cargo is missing: an agent starts.
    which: async (ps) => new Set(ps.filter((p) => p !== "cargo")),
    git: async (args) => (args[0] === "remote" ? { code: 0, stdout: `origin\t${REMOTE} (fetch)\n` } : { code: 0, stdout: "" }),
    doctor: async () => null,
    offeredModels: async () => [...onboardModels()],
    claudeUsable: () => true,
    agentHidden: async () => [],
    confine: async () => null,
    startChat: async () => ((busy = 2), { id: "agent-1", path: join(root, "agent-1.jsonl") }),
    link: async () => ({ linkId: "lk_1" }),
    tell: async (_p, text) => void (told.push(text), (busy = 2)),
    busy: () => busy-- > 0,
    sleep: tick,
    now: () => (clock += 5_000),
    hiddenPaths: () => [join(root, ".ssh"), join(root, ".aws"), join(root, ".gnupg")],
    fetchOutside: async (_t, rel) => (fetched.push(rel), { ok: true, bytes: Buffer.from(`from laptop: ${rel}`) }),
    ...over,
  };
  await afterArrival({ tid, sourcePeer: "sova-laptop", sourceLabel: "laptop", sourceChatId: "chat-1", title: "Motors", project: { remotes: [REMOTE], path: project }, worktrees: [], fromSource: true, trees: [project], privateFiles: [], sourceValues: [] }, deps);
  const a = agentOf(join(root, "state"), tid)!;
  return { deps, fetched, told, a };
}

test("the agent names a file: nothing is read on the other device until your Bring From, then that one file, once; it is written here and the agent is told", async () => {
  const root = scratchRoot("transport-outside-");
  const { deps, fetched, told, a } = await arrived(root, "tr_outside02");
  const asked = askOutsideFile(deps, a.sessionId, { path: "~/.config/motors/settings.json", why: "The app reads its region from it." });
  assert.ok(asked.ok, JSON.stringify(asked));
  assert.deepEqual(fetched, [], "naming it reads nothing there");
  const f = agentOf(join(root, "state"), "tr_outside02")!.outside![0]!;
  assert.deepEqual({ path: f.path, folder: f.folder, from: f.from, state: f.state }, { path: "~/.config/motors/settings.json", folder: "~/.config/motors", from: "laptop", state: "asked" });
  assert.equal(agentOf(join(root, "state"), "tr_outside02")!.state, "needs-you", "it waits on you");
  const done = await bringOutsideFile(deps, "tr_outside02", f.id);
  assert.ok(done.ok);
  await done.handed;
  await done.checked;
  assert.deepEqual(fetched, [".config/motors/settings.json"]);
  assert.equal(readFileSync(join(root, ".config/motors/settings.json"), "utf8"), "from laptop: .config/motors/settings.json");
  assert.ok(told.some((t) => t.includes("The user brought ~/.config/motors/settings.json from laptop")));
  // Pressed again: already brought, nothing read again.
  assert.ok((await bringOutsideFile(deps, "tr_outside02", f.id)).ok);
  assert.equal(fetched.length, 1);
});

test("a file in the hidden list or inside the project is never put on the card; one already here is kept, nothing read there; I Placed It Myself reads nothing", async () => {
  const root = scratchRoot("transport-outside-");
  const { deps, fetched, told, a } = await arrived(root, "tr_outside03");
  for (const p of ["~/.ssh/id_ed25519", "~/.aws/credentials", "~/.gnupg/pubring.kbx", "~/webapps/motors/.env"]) {
    const r = askOutsideFile(deps, a.sessionId, { path: p });
    assert.equal(r.ok, false, p);
  }
  assert.equal(agentOf(join(root, "state"), "tr_outside03")!.outside, undefined, "nothing on the card");
  mkdirSync(join(root, ".config", "motors"), { recursive: true });
  writeFileSync(join(root, ".config", "motors", "settings.json"), "mine");
  assert.ok(askOutsideFile(deps, a.sessionId, { path: "~/.config/motors/settings.json" }).ok);
  const id = agentOf(join(root, "state"), "tr_outside03")!.outside![0]!.id;
  const done = await bringOutsideFile(deps, "tr_outside03", id);
  assert.ok(done.ok);
  await done.handed;
  assert.deepEqual(fetched, [], "already here: nothing read there");
  assert.equal(readFileSync(join(root, ".config", "motors", "settings.json"), "utf8"), "mine", "never overwritten");
  assert.equal(agentOf(join(root, "state"), "tr_outside03")!.outside![0]!.state, "kept");
  assert.ok(told.some((t) => t.includes("it was kept as it is and nothing was brought")));
  assert.ok(askOutsideFile(deps, a.sessionId, { path: "~/.motorsrc" }).ok);
  const second = agentOf(join(root, "state"), "tr_outside03")!.outside!.find((x) => x.path === "~/.motorsrc")!;
  const placed = await placedOutsideFile(deps, "tr_outside03", second.id);
  assert.ok(placed.ok);
  await placed.handed;
  assert.deepEqual(fetched, []);
  assert.equal(existsSync(join(root, ".motorsrc")), false, "nothing written for it");
  assert.equal(agentOf(join(root, "state"), "tr_outside03")!.outside!.find((x) => x.id === second.id)!.state, "placed");
});

test("the missing file a copy's log names at this device's own path is asked as the same ~/… there, its folder missing here or not", async () => {
  const root = scratchRoot("transport-outside-");
  const { deps, fetched, a } = await arrived(root, "tr_outside09");
  const here = join(root, "Projects", "stack", "compose", "motors.override.yml");
  const r = askOutsideFile(deps, a.sessionId, { path: here, why: "The copy's data step reads the stack's compose override from it." });
  assert.ok(r.ok, JSON.stringify(r));
  const f = agentOf(join(root, "state"), "tr_outside09")!.outside![0]!;
  assert.deepEqual({ path: f.path, folder: f.folder, state: f.state }, { path: "~/Projects/stack/compose/motors.override.yml", folder: "~/Projects/stack/compose", state: "asked" });
  assert.deepEqual(fetched, [], "naming it reads nothing there");
  assert.equal(askOutsideFile(deps, a.sessionId, { path: "/etc/motors.yml" }).ok, false, "outside this home: still refused");
});
