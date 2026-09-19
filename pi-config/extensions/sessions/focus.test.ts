import { test } from "node:test";
import assert from "node:assert/strict";
import { __testing, isFocusTarget, type FocusTarget } from "./focus.ts";

function stat(pid: number, parent: number, comm: string, tty = "34817", start = "100") {
  const fields = Array(20).fill("0");
  fields[0] = "S"; fields[1] = String(parent); fields[4] = tty; fields[19] = start;
  return `${pid} (${comm}) ${fields.join(" ")}`;
}
function fixture(tmux = false) {
  const files = new Map<string, string>([
    ["/proc/sys/kernel/random/boot_id", "boot-1"],
    ["/proc/10/stat", stat(10, 1, "ghostty", "0")],
    ["/proc/10/fdinfo/7", "pos:\t0\ntty-index:\t1\n"],
    ["/proc/11/stat", stat(11, 10, "bash")],
    ["/proc/12/stat", stat(12, 11, "pi")],
  ]);
  const links = new Map([["/proc/10/exe", "/usr/bin/ghostty"], ["/proc/11/fd/0", "/dev/pts/1"]]);
  let windows = [{ pid: 10, address: "0xabc", class: "com.mitchellh.ghostty", title: "unique pi marker", mapped: true, hidden: false }];
  let clients = "13\t/dev/pts/1\t0\n";
  let panes = "%3\t21\t/dev/pts/2\t$1\t@2\n";
  const calls: [string, string[]][] = [];
  const env: NodeJS.ProcessEnv = { HYPRLAND_INSTANCE_SIGNATURE: "instance-1" };
  if (tmux) {
    env.TMUX = "/tmp/tmux socket,20,0"; env.TMUX_PANE = "%3";
    files.set("/proc/13/stat", stat(13, 11, "tmux"));
    files.set("/proc/20/stat", stat(20, 1, "tmux: server", "0"));
    files.set("/proc/21/stat", stat(21, 20, "bash", "34818"));
    files.set("/proc/12/stat", stat(12, 21, "pi", "34818"));
    links.set("/proc/12/fd/0", "/dev/pts/2"); links.set("/proc/13/fd/0", "/dev/pts/1");
  }
  const io = {
    platform: "linux", pid: 12, env,
    read: async (path: string) => { if (!files.has(path)) throw Object.assign(new Error(path), { code: "ENOENT" }); return files.get(path)!; },
    list: async (path: string) => path === "/proc" ? [...files.keys()].flatMap((p) => /^\/proc\/(\d+)\/stat$/.exec(p)?.slice(1) ?? []) :
      [...files.keys()].filter((p) => p.startsWith(`${path}/`)).map((p) => p.slice(path.length + 1)),
    link: async (path: string) => { if (!links.has(path)) throw new Error(path); return links.get(path)!; },
    run: async (command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === "hyprctl") return args[0] === "-j" ? JSON.stringify(windows) : "ok\n";
      if (args.includes("list-panes")) return panes;
      if (args.includes("list-clients")) return clients;
      return "";
    },
  };
  return { ...__testing.api(io), io, files, links, calls,
    addWindow: (title = windows[0].title) => { windows = [...windows, { ...windows[0], address: "0xdef", title }]; },
    setTitle: (title: string) => { windows[0].title = title; },
    setClients: (s: string) => { clients = s; }, setPanes: (s: string) => { panes = s; } };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(([, a]) => a.includes("dispatch") || a.includes("switch-client"));

test("stat parser handles spaces and closing parentheses", () => {
  const p = __testing.parseStat(stat(12, 11, "a (b) c)"));
  assert.equal(p.comm, "a (b) c)"); assert.equal(p.ppid, 11); assert.equal(p.start, "100");
  assert.throws(() => __testing.parseStat("bad"));
});
test("TMUX parser preserves commas/spaces in the absolute socket path", () => {
  assert.deepEqual(__testing.tmuxEnv("/tmp/a,b c,20,1"), { socket: "/tmp/a,b c", pid: 20 });
  assert.throws(() => __testing.tmuxEnv("relative,20,1"));
});
test("discover and focus a serialized exact window without active-window queries", async () => {
  const f = fixture(); const target = (await f.discoverFocusTarget())!;
  assert.ok(isFocusTarget(target)); assert.ok(JSON.stringify(target).length < 14000);
  await f.focusTarget(JSON.parse(JSON.stringify(target)));
  assert.deepEqual(mutations(f), [["hyprctl", ["dispatch", "focuswindow", "address:0xabc"]]]);
  assert.ok(!f.calls.some(([, a]) => a.includes("activewindow")));
});
test("reject multiple windows and hidden Ghostty tabs/splits", async () => {
  const f = fixture(); f.addWindow(); await assert.rejects(f.discoverFocusTarget(), /ambiguous/);
  const g = fixture(); g.files.set("/proc/14/stat", stat(14, 10, "bash", "34819"));
  await assert.rejects(g.discoverFocusTarget(), /ambiguous/);
  assert.equal(mutations(f).length + mutations(g).length, 0);
});
test("unique visible title supports shared Ghostty, rejects hidden/duplicate/stale titles", async () => {
  const f = fixture(); f.addWindow("other window");
  f.files.set("/proc/14/stat", stat(14, 10, "bash", "34819"));
  f.files.set("/proc/10/fdinfo/8", "tty-index:\t3\n");
  const t = (await f.discoverFocusTarget("unique pi marker"))!;
  assert.equal(t.title, "unique pi marker"); assert.ok(isFocusTarget(t));
  await f.focusTarget(JSON.parse(JSON.stringify(t)));
  f.calls.length = 0; f.setTitle("another active tab");
  await assert.rejects(f.focusTarget(t)); assert.equal(mutations(f).length, 0);
  await assert.rejects(f.discoverFocusTarget("unique pi marker"));
  const g = fixture(); g.addWindow();
  await assert.rejects(g.discoverFocusTarget("unique pi marker"));
  await assert.rejects(g.discoverFocusTarget(""));
});
test("refuse extra PTY surfaces even with no live child", async () => {
  const f = fixture(); f.files.set("/proc/10/fdinfo/8", "tty-index:\t2\n");
  await assert.rejects(f.discoverFocusTarget(), /PTY surfaces/);
  const g = fixture(); g.files.delete("/proc/10/fdinfo/7");
  await assert.rejects(g.discoverFocusTarget(), /PTY surfaces/);
});
test("revalidate identity and ambiguity immediately before focus", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.files.set("/proc/12/stat", stat(12, 11, "pi", "34817", "101")),
    (f: ReturnType<typeof fixture>) => f.files.set("/proc/sys/kernel/random/boot_id", "boot-2"),
    (f: ReturnType<typeof fixture>) => f.addWindow(),
    (f: ReturnType<typeof fixture>) => f.files.set("/proc/14/stat", stat(14, 10, "bash")),
    (f: ReturnType<typeof fixture>) => { f.io.env.HYPRLAND_INSTANCE_SIGNATURE = "other"; },
  ]) {
    const f = fixture(); const t = (await f.discoverFocusTarget())!; change(f);
    await assert.rejects(f.focusTarget(t)); assert.equal(mutations(f).length, 0);
  }
});
test("reject untrusted target shapes before executing commands", async () => {
  const f = fixture();
  for (const value of [null, {}, [], { version: 1 }, { version: 1, origin: { pid: "../../etc" } }]) {
    assert.equal(isFocusTarget(value), false);
    await assert.rejects(f.focusTarget(value as unknown as FocusTarget));
  }
  const valid = (await f.discoverFocusTarget())!; f.calls.length = 0;
  for (const value of [{ ...valid, origin: { ...valid.origin, pid: -1 } }, { ...valid, address: "0xabc; exec evil" },
    { ...valid, tmux: { socket: "/tmp/x" } }]) {
    assert.equal(isFocusTarget(value), false); await assert.rejects(f.focusTarget(value as unknown as FocusTarget));
  }
  assert.equal(f.calls.length, 0);
});
test("tmux uses exact socket, client, session/window and pane IDs", async () => {
  const f = fixture(true); const t = (await f.discoverFocusTarget())!;
  assert.ok(isFocusTarget(t)); await f.focusTarget(t);
  assert.deepEqual(mutations(f), [
    ["tmux", ["-S", "/tmp/tmux socket", "switch-client", "-c", "/dev/pts/1", "-t", "$1:@2", ";", "select-pane", "-t", "%3"]],
    ["hyprctl", ["dispatch", "focuswindow", "address:0xabc"]],
  ]);
});
test("tmux refuses detached, multiple, read-only, linked, stale and wrong-TTY targets", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setClients(""),
    (f: ReturnType<typeof fixture>) => f.setClients("13\t/dev/pts/1\t0\n14\t/dev/pts/3\t0\n"),
    (f: ReturnType<typeof fixture>) => f.setClients("13\t/dev/pts/1\t1\n"),
    (f: ReturnType<typeof fixture>) => f.setPanes("%3\t21\t/dev/pts/2\t$1\t@2\n%3\t21\t/dev/pts/2\t$2\t@2\n"),
    (f: ReturnType<typeof fixture>) => f.links.set("/proc/12/fd/0", "/dev/pts/99"),
    (f: ReturnType<typeof fixture>) => f.files.set("/proc/20/stat", stat(20, 1, "tmux: server", "0", "999")),
  ]) {
    const f = fixture(true); const t = (await f.discoverFocusTarget())!; change(f);
    await assert.rejects(f.focusTarget(t)); assert.equal(mutations(f).length, 0);
  }
});
test("unsupported environments explicitly reject", async () => {
  const f = fixture(); f.io.platform = "darwin"; await assert.rejects(f.discoverFocusTarget(), /only Linux/);
  const g = fixture(); g.files.set("/proc/10/stat", stat(10, 1, "kitty", "0"));
  await assert.rejects(g.discoverFocusTarget(), /no Ghostty/);
  const h = fixture(); h.io.env.TMUX_PANE = "%1"; await assert.rejects(h.discoverFocusTarget(), /incomplete/);
});
