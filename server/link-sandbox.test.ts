// Run: pnpm exec tsx --test server/link-sandbox.test.ts
// A linked session's sandbox as the transfer honours it (§mesh.links/offers, /transfer): the policy
// from the branch through the extension's own resolver, the sender's read check, the receiver's dest
// check and the pre-scan. Temp trees are removed after.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { resolveSessionPolicy } from "../pi-config/extensions/sandbox/session-policy.ts";
import { canonicalize } from "../pi-config/extensions/sandbox/policy.ts";
import { linkSandbox, linkSandboxOf, type LinkSandbox, prescan, sandboxOf } from "./link-sandbox";
import type { TarMember } from "./mesh/tar-list";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-link-sandbox-")));
after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
const ws = join(root, "ws");
const wt = join(root, "wt");
const state = join(agentDir, "sova");
mkdirSync(agentDir, { recursive: true });
cpSync(join(import.meta.dirname, "..", "pi-config", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });
mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
mkdirSync(join(ws, "proj", "secret"), { recursive: true });
mkdirSync(join(wt, ".agent"), { recursive: true });
mkdirSync(join(home, ".ssh"), { recursive: true });
mkdirSync(state, { recursive: true });

const on = (level = "workspace-write") => ({ type: "custom", customType: "sandbox", data: { version: 1, on: true, level, backend: "linux-bwrap", enforcement: "full" } });
const off = { type: "custom", customType: "sandbox", data: { version: 1, on: false, level: "workspace-write", backend: "none", enforcement: "none" } };
const trees = (path: string, status = "active") => ({
  type: "custom",
  customType: "worktrees",
  data: { version: 1, trees: [{ path, branch: "feat/x", base: "abc", status, session: "s1", how: "created", at: 1 }] },
});
const session = { sessionId: "s1", cwd: ws };
const opts = { agentDir, home };

async function* members(list: Array<Partial<TarMember> & { name: string }>): AsyncGenerator<TarMember> {
  for (const m of list) yield { type: "file", size: 0, ...m };
}

test("the branch decides on/off; on resolves the extension's own policy with the active worktrees", () => {
  assert.deepEqual(sandboxOf(session, [], opts), { on: false });
  assert.deepEqual(sandboxOf(session, [on(), off], opts), { on: false });
  const sb = sandboxOf(session, [on(), trees(wt)], opts);
  assert.ok(sb.on && "policy" in sb);
  const want = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s1", worktreeRoots: [wt], home });
  assert.ok(want.ok);
  assert.deepEqual(sb.policy, want.value);
  // A dropped worktree is no writable root.
  const dropped = sandboxOf(session, [on(), trees(wt, "dropped")], opts);
  assert.ok(dropped.on && "policy" in dropped && !dropped.policy.writable.includes(wt));
});

test("on with no policy file, or no such session: every check refuses (fail closed)", async () => {
  const sb = sandboxOf(session, [on()], { agentDir: join(root, "nowhere"), home });
  assert.ok(sb.on && "error" in sb);
  assert.match(linkSandbox.read(sb, join(ws, "proj"))!, /can't be resolved/);
  assert.ok(linkSandbox.write(sb, join(ws, "in"), { creating: true }));
  assert.equal((await prescan(members([{ name: "a" }]), { dest: ws, sandbox: sb, protectedRoots: [state] }))?.reason, "not-writable");
  const src = { cwd: async (id: string) => (id === "s1" ? ws : null), branch: async () => [on()], agentDir: () => agentDir, home: () => home };
  const none = await linkSandboxOf("nope", src);
  assert.ok(none.on && "error" in none);
  const got = await linkSandboxOf("s1", src);
  assert.ok(got.on && "policy" in got);
});

test("the checks: read, write and hiddenBelow through the policy; off allows everything", () => {
  const sb: LinkSandbox = { on: true, policy: { ...policy(), hidden: [join(home, ".ssh"), join(ws, "proj", "secret")] } };
  assert.ok(linkSandbox.read(sb, join(home, ".ssh", "id")));
  assert.equal(linkSandbox.read(sb, join(ws, "proj")), undefined);
  assert.deepEqual(linkSandbox.hiddenBelow(sb, join(ws, "proj")), [join(ws, "proj", "secret")]);
  assert.equal(linkSandbox.read({ on: false }, join(home, ".ssh")), undefined);
  assert.deepEqual(linkSandbox.hiddenBelow({ on: false }, ws), []);
  const wsb = sandboxOf(session, [on(), trees(wt)], opts);
  assert.equal(linkSandbox.write(wsb, join(ws, "in"), { creating: true }), undefined);
  assert.equal(linkSandbox.write(wsb, canonicalize(join(wt, "in")), { creating: true }), undefined);
  assert.ok(linkSandbox.write(wsb, join(root, "elsewhere"), { creating: true }));
  assert.ok(linkSandbox.write(wsb, join(ws, ".git", "hooks", "x"), { creating: true }));
  assert.equal(linkSandbox.write({ on: false }, join(root, "elsewhere")), undefined);
});

test("pre-scan: structure, protected roots and the sandbox's read-only members", async () => {
  const sb = sandboxOf(session, [on()], opts);
  const ok = [{ name: "proj/", type: "dir" as const }, { name: "proj/a.txt" }, { name: "proj/sub/", type: "dir" as const }, { name: "proj/sub/b" }, { name: "notes.md" }];
  assert.equal(await prescan(members(ok), { dest: ws, sandbox: sb, protectedRoots: [state] }), null);
  assert.equal((await prescan(members([{ name: "/etc/passwd" }]), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }))?.reason, "not-writable");
  assert.equal((await prescan(members([{ name: "proj/", type: "dir" }, { name: "proj/../../x" }]), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }))?.reason, "not-writable");
  // A member under a directory the archive never created: tar would follow what is there.
  assert.equal((await prescan(members([{ name: "proj/a" }]), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }))?.reason, "not-writable");
  // A symlink member then a member through it.
  const through = [{ name: "l", type: "symlink" as const, linkname: "/elsewhere" }, { name: "l/x" }];
  assert.equal((await prescan(members(through), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }))?.reason, "not-writable");
  // A hard link to something the archive doesn't hold.
  assert.equal((await prescan(members([{ name: "h", type: "hardlink", linkname: "../../etc/shadow" }]), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }))?.reason, "not-writable");
  assert.equal(await prescan(members([{ name: "a" }, { name: "h", type: "hardlink", linkname: "a" }]), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }), null);
  // Protected: dest above the state root, a member reaching into it.
  const intoState = [{ name: ".pi/", type: "dir" as const }, { name: ".pi/agent/", type: "dir" as const }, { name: ".pi/agent/sova/", type: "dir" as const }, { name: ".pi/agent/sova/x" }];
  assert.equal((await prescan(members(intoState), { dest: home, sandbox: { on: false }, protectedRoots: [state] }))?.reason, "protected");
  // Sandbox: a member in the read-only .git/hooks.
  const hooks = [{ name: ".git/", type: "dir" as const }, { name: ".git/hooks/", type: "dir" as const }, { name: ".git/hooks/pre-commit" }];
  const bad = await prescan(members(hooks), { dest: ws, sandbox: sb, protectedRoots: [state] });
  assert.equal(bad?.reason, "not-writable");
  assert.equal(bad?.path, join(ws, ".git", "hooks"));
  assert.equal(await prescan(members(hooks), { dest: ws, sandbox: { on: false }, protectedRoots: [state] }), null);
});

test("pre-scan: an existing symlink in dest is replaced by the archive's own directory member, never followed", async () => {
  const dest = join(root, "dest");
  mkdirSync(dest, { recursive: true });
  symlinkSync(join(home, ".ssh"), join(dest, "proj"));
  writeFileSync(join(dest, "keep"), "x");
  const sb: LinkSandbox = { on: true, policy: { ...policy(), writable: [dest] } };
  assert.equal(await prescan(members([{ name: "proj/", type: "dir" }, { name: "proj/k" }]), { dest: dest, sandbox: sb, protectedRoots: [state] }), null);
  assert.equal((await prescan(members([{ name: "proj/k" }]), { dest: dest, sandbox: sb, protectedRoots: [state] }))?.reason, "not-writable");
});

test("pre-scan, sandbox off: a member whose parent resolves into a protected root through a link on disk is refused", async () => {
  const dest = join(root, "dest-off");
  mkdirSync(join(dest, "real"), { recursive: true });
  symlinkSync(state, join(dest, "proj"));
  const off: LinkSandbox = { on: false };
  const d = await prescan(members([{ name: "proj/", type: "dir" }, { name: "proj/mesh-access.json" }]), { dest, sandbox: off, protectedRoots: [state] });
  assert.equal(d?.reason, "protected");
  assert.equal(d?.path, join(dest, "proj", "mesh-access.json"));
  // dest itself swapped for a link into the state root after it was checked.
  const swapped = join(root, "swapped");
  symlinkSync(state, swapped);
  assert.equal((await prescan(members([{ name: "x" }]), { dest: swapped, sandbox: off, protectedRoots: [state] }))?.reason, "protected");
  // A link member pointing into the state root still lands as a link; a plain tree passes.
  assert.equal(await prescan(members([{ name: "real/", type: "dir" }, { name: "real/l", type: "symlink", linkname: state }, { name: "real/a" }]), { dest, sandbox: off, protectedRoots: [state] }), null);
});

/** A hand-made policy: the cwd writable, nothing hidden. */
function policy() {
  const r = resolveSessionPolicy({ agentDir, cwd: ws, sessionId: "s1", home });
  assert.ok(r.ok);
  return { ...r.value, hidden: [] as string[] };
}
