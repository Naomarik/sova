// Settings and themes sync between in-process "hosts", each with its own scratch agent dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelFavorites } from "../../pi-config/extensions/command-palette/favorites.ts";
import { delegateDefaults } from "../../pi-config/extensions/mode/delegate.ts";
import { specDefaults } from "../../pi-config/extensions/mode/spec.ts";
import { loadSubagentProfiles, readSubagentProfiles, writeSubagentProfiles, type SubagentProfile } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { compareDocs, DocSync, settingsDocs, themeDoc, validFavorites, type DocManifest, type DocMeta, type DocPeer, type DocPush, type DocReply } from "./docs";
import { listKept, LIBRARY_KEY } from "./kept";
import { libraryText } from "./profile-merge";
import { replacedNotice, restoreReplacedProfiles } from "../subagent-profiles";

const root = mkdtempSync(join(tmpdir(), "sova-doc-sync-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

class Host {
  online = true;
  offset = 0;
  sync!: DocSync;
  enabled = { settings: true, themes: true };
  readonly agentDir: string;
  readonly stateDir: string;
  constructor(
    readonly id: string,
    private readonly mesh: Host[],
    base: string,
    themesDir = true,
  ) {
    this.agentDir = join(base, id, "agent");
    this.stateDir = join(this.agentDir, "sova");
    mkdirSync(themesDir ? join(this.stateDir, "themes") : this.stateDir, { recursive: true });
    this.boot();
  }
  boot() {
    this.sync = new DocSync({
      hostId: this.id,
      agentDir: this.agentDir,
      stateDir: this.stateDir,
      sidecarPath: join(this.stateDir, "doc-sync.json"),
      peers: () => this.mesh.filter((h) => h !== this).map((h) => this.peerTo(h)),
      categoryEnabled: (c) => this.enabled[c],
      deviceName: (id) => `Device ${id.toUpperCase()}`,
      now: () => Date.now() + this.offset,
      log: () => {},
      debounceMs: 30,
    });
  }
  peerTo(t: Host): DocPeer {
    const reach = () => {
      if (!this.online || !t.online) throw new Error("unreachable");
    };
    return {
      id: t.id,
      manifest: async () => (reach(), structuredClone(t.sync.manifest())),
      doc: async (key) => {
        reach();
        const d = t.sync.doc(key);
        if (!d) throw new Error("404");
        return structuredClone(d);
      },
      push: async (body) => (reach(), t.sync.receivePush(this.id, structuredClone(body))),
    };
  }
  write(rel: string, content: string) {
    const p = join(this.agentDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  read(rel: string): string | undefined {
    const p = join(this.agentDir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }
}

function mesh(n: number): Host[] {
  const base = join(root, `m${++seq}`);
  const hosts: Host[] = [];
  for (let i = 0; i < n; i++) hosts.push(new Host(String.fromCharCode(97 + i), hosts, base));
  return hosts;
}
const tick = () => new Promise((r) => setTimeout(r, 3));
async function converge(hosts: Host[]) {
  for (let r = 0; r < 2; r++) for (const h of hosts) if (h.online) await h.sync.syncAll();
}
const modeJson = (mode: string) => `${JSON.stringify({ mode, minorModes: [], strict: false }, null, 2)}\n`;
const theme = (name: string) => JSON.stringify({ name, base: "dark", colors: {} });

test("favorites: the restated shape agrees with the palette's own reader on every sample", () => {
  const dir = join(root, "fav");
  mkdirSync(dir);
  const samples = [
    { version: 1, models: [] },
    { version: 1, models: [{ provider: "zai", id: "glm-5.3" }] },
    { version: 1, models: [{ provider: "zai", id: "glm-5.3", extra: 1 }] },
    { version: 1, models: [{ provider: "", id: "x" }] },
    { version: 1, models: [{ provider: "a", id: "" }] },
    { version: 1, models: [null] },
    { version: 2, models: [] },
    { version: 1, models: [], more: true },
    { version: 1 },
    { models: [] },
    [],
    "text",
    { version: 1, models: [{ provider: 1, id: "x" }] },
  ];
  for (const [i, s] of samples.entries()) {
    const text = JSON.stringify(s);
    const p = join(dir, `f${i}.json`);
    writeFileSync(p, text);
    let palette: boolean;
    try {
      new ModelFavorites(p);
      palette = true;
    } catch {
      palette = false;
    }
    assert.equal(validFavorites(text), palette, text);
  }
  assert.equal(validFavorites("{not json"), false);
});

test("validators: the consumers' defaults are valid, garbage is not; theme files are named safely", () => {
  const specs = Object.fromEntries(settingsDocs("/a", "/a/sova").map((s) => [s.key, s]));
  assert.equal(specs["settings:mode-delegate.json"]!.valid(JSON.stringify(delegateDefaults())), true);
  assert.equal(specs["settings:mode-delegate.json"]!.valid(JSON.stringify({ version: 9 })), false);
  assert.equal(specs["settings:mode-spec.json"]!.valid(JSON.stringify(specDefaults())), true);
  assert.equal(specs["settings:model-policy.json"]!.valid(JSON.stringify({ version: 1, disabledModels: ["a/b"] })), true);
  assert.equal(specs["settings:model-policy.json"]!.valid(JSON.stringify({ version: 1, disabledModels: [3] })), false);
  assert.equal(specs["settings:provider-limits.json"]!.valid(JSON.stringify({ version: 1, limits: { zai: 5 } })), true);
  assert.equal(specs["settings:provider-limits.json"]!.valid(JSON.stringify({ version: 1, limits: { zai: 0 } })), false);
  assert.equal(specs["settings:provider-limits.json"]!.valid(JSON.stringify({ version: 1, limits: {}, extra: true })), false);
  assert.equal(specs["settings:usage-windows.json"], undefined, "Ollama's old declared reset day is no longer a document");
  assert.equal(specs["settings:sova/settings.json"]!.valid("{}"), false);
  // Yours: the whole file, checked with the profile store's strict parser.
  const yours = specs["settings:sova/session-profiles.json"]!;
  assert.equal(yours.path, "/a/sova/session-profiles.json");
  assert.equal(yours.category, "settings");
  const card = { id: "claude", label: "Claude session", model: "claude-code-cli/claude-opus-5-5", thinking: "high", subagents: "claude-subs" };
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [card] })), true);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [] })), true);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [{ ...card, thinking: "hot" }] })), false);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [{ ...card, typo: 1 }] })), false);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [card, { ...card, label: "Other" }] })), false, "two profiles with one id");
  assert.equal(yours.valid(JSON.stringify({ version: 2, profiles: [] })), false);
  assert.equal(yours.valid("{"), false);
  assert.equal(themeDoc("/t", "../evil.json"), null);
  assert.equal(themeDoc("/t", "a/b.json"), null);
  assert.equal(themeDoc("/t", ".hidden.json"), null);
  assert.equal(themeDoc("/t", "ocean.json")!.valid(theme("Ocean")), true);
  assert.equal(themeDoc("/t", "ocean.json")!.valid("{"), false);
});

test("newest edit wins; ties by origin then hash", () => {
  const a = { hash: "a".repeat(64), modifiedAt: 5, origin: "a" };
  assert.ok(compareDocs({ ...a, modifiedAt: 6 }, a) > 0);
  assert.ok(compareDocs({ ...a, origin: "b" }, a) > 0);
  assert.ok(compareDocs({ ...a, hash: "b".repeat(64) }, a) > 0);
  assert.ok(compareDocs({ ...a, hash: null }, a) < 0);
});

test("mesh off: constructing reads and writes nothing", () => {
  const dir = join(root, "off");
  mkdirSync(dir);
  new DocSync({ hostId: "x", agentDir: dir, stateDir: join(dir, "sova"), sidecarPath: join(dir, "sova", "doc-sync.json") });
  assert.deepEqual(readdirSync(dir), []);
});

test("a settings edit on one host reaches the others; a later edit elsewhere wins back", async () => {
  const [a, b, c] = mesh(3);
  for (const h of [a!, b!, c!]) await h.sync.start();
  try {
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!, c!]);
    for (const h of [b!, c!]) assert.equal(h.read("mode.json"), modeJson("delegate"), h.id);
    await tick();
    c!.write("mode.json", modeJson("normal"));
    c!.sync.observe();
    await converge([a!, b!, c!]);
    for (const h of [a!, b!]) assert.equal(h.read("mode.json"), modeJson("normal"), h.id);
  } finally {
    for (const h of [a!, b!, c!]) h.sync.stop();
  }
});

test("themes: an added theme appears everywhere, a deleted one disappears everywhere", async () => {
  const [a, b] = mesh(2);
  await a!.sync.start();
  await b!.sync.start();
  try {
    a!.write("sova/themes/ocean.json", theme("Ocean"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("sova/themes/ocean.json"), theme("Ocean"));
    await tick();
    rmSync(join(b!.stateDir, "themes", "ocean.json"));
    b!.sync.observe();
    await converge([a!, b!]);
    assert.equal(a!.read("sova/themes/ocean.json"), undefined);
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("first run: existing files are stamped by mtime (the later edit wins); a missing file deletes nothing", async () => {
  const [a, b] = mesh(2);
  a!.write("mode-spec.json", `${JSON.stringify(specDefaults())}\n`);
  b!.write("mode-spec.json", `${JSON.stringify({ ...specDefaults() }, null, 2)}\n`);
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(join(a!.agentDir, "mode-spec.json"), old, old);
  a!.write("sova/themes/only-a.json", theme("A"));
  await a!.sync.start();
  await b!.sync.start();
  try {
    await converge([a!, b!]);
    assert.equal(a!.read("mode-spec.json"), b!.read("mode-spec.json"));
    assert.equal(a!.read("mode-spec.json"), `${JSON.stringify({ ...specDefaults() }, null, 2)}\n`, "B's newer edit won");
    assert.equal(b!.read("sova/themes/only-a.json"), theme("A"), "B had no such theme: nothing to delete");
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("a local file its reader rejects is neither offered nor overwritten; a symlink is never written", async () => {
  const [a, b] = mesh(2);
  a!.write("model-favorites.json", JSON.stringify({ version: 1, models: [{ provider: "zai", id: "glm-5.3" }] }));
  b!.write("model-favorites.json", "{ broken");
  const target = join(root, `link-target-${seq}.json`);
  writeFileSync(target, modeJson("normal"));
  symlinkSync(target, join(b!.agentDir, "mode.json"));
  await a!.sync.start();
  await b!.sync.start();
  try {
    await tick();
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("model-favorites.json"), "{ broken", "never overwritten");
    assert.equal(readFileSync(target, "utf8"), modeJson("normal"), "the link's target is untouched");
    assert.equal(b!.sync.manifest().docs["settings:mode.json"], undefined);
    assert.equal(b!.sync.manifest().docs["settings:model-favorites.json"], undefined);
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("the palette's lock is honoured, and an unobserved local edit is never written over", async () => {
  const [a, b] = mesh(2);
  const fav = (id: string) => JSON.stringify({ version: 1, models: [{ provider: "zai", id }] });
  await a!.sync.start();
  await b!.sync.start();
  try {
    a!.write("model-favorites.json", fav("one"));
    a!.sync.observe();
    const lock = join(b!.agentDir, "model-favorites.json.lock");
    mkdirSync(lock);
    await converge([a!, b!]);
    assert.equal(b!.read("model-favorites.json"), undefined, "held off by the palette's lock");
    rmdirSync(lock);
    await converge([a!, b!]);
    assert.equal(b!.read("model-favorites.json"), fav("one"));
    // B edits after A's edit but before B has looked: applying A's document first folds B's
    // unobserved edit in (stamped now, so newer), and A's is refused rather than written over it.
    await tick();
    a!.write("model-favorites.json", fav("two"));
    a!.sync.observe();
    await tick();
    b!.write("model-favorites.json", fav("local"));
    const reason = b!.sync.apply("settings:model-favorites.json", a!.sync.doc("settings:model-favorites.json")!);
    assert.equal(reason, "older");
    assert.equal(b!.read("model-favorites.json"), fav("local"));
    await converge([a!, b!]);
    assert.equal(a!.read("model-favorites.json"), fav("local"), "the later edit won everywhere");
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("a switched-off category is neither offered nor taken; clock skew refuses", async () => {
  const [a, b] = mesh(2);
  await a!.sync.start();
  await b!.sync.start();
  try {
    b!.enabled.themes = false;
    a!.write("sova/themes/x.json", theme("X"));
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("sova/themes/x.json"), undefined);
    assert.equal(b!.read("mode.json"), modeJson("delegate"));
    b!.offset = 3_600_000;
    await tick();
    a!.write("mode.json", modeJson("normal"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("mode.json"), modeJson("delegate"), "no exchange across the skew");
    assert.equal(b!.sync.peers().a?.state, "clock-skew");
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("a forged document (content not matching its hash, or rejected by its reader) is refused", async () => {
  const [a] = mesh(1);
  await a!.sync.start();
  try {
    const now = Date.now() + 1000;
    const r = a!.sync.receivePush("b", {
      hostId: "b",
      now: Date.now(),
      docs: {
        "settings:mode.json": { meta: { hash: "0".repeat(64), modifiedAt: now, origin: "b" }, content: modeJson("delegate") },
        "themes:../../auth.json": { meta: { hash: null, modifiedAt: now, origin: "b" }, content: null },
        "settings:auth.json": { meta: { hash: null, modifiedAt: now, origin: "b" }, content: null },
      },
    });
    assert.deepEqual(r.rejected.map((x) => x.reason), ["invalid", "unknown", "unknown"]);
    assert.equal(a!.read("mode.json"), undefined);
  } finally {
    a!.sync.stop();
  }
});

test("a theme deleted inside a themes folder that did not exist at start is still noticed by its watcher", async () => {
  const hosts: Host[] = [];
  const base = join(root, `m${++seq}`);
  const a = new Host("a", hosts, base, false);
  hosts.push(a);
  await a.sync.start();
  try {
    const until = async (cond: () => boolean) => {
      const end = Date.now() + 15_000; // a hang guard
      while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      return cond();
    };
    a.write("sova/themes/late.json", theme("Late"));
    assert.equal(await until(() => a.sync.recordsSnapshot()["themes:late.json"]?.hash !== undefined), true, "creation seen");
    rmSync(join(a.stateDir, "themes", "late.json"));
    assert.equal(await until(() => a.sync.recordsSnapshot()["themes:late.json"]?.hash === null), true, "deletion seen without a manual observe");
  } finally {
    a.sync.stop();
  }
});

test("a local delete first noticed by a peer's request still reaches every other peer at once", async () => {
  // The lab's repro: b has themes off while a adds a theme (c takes it); a deletes it and b turns
  // themes back on at once, so b's pull asks a for the document before a's own watcher scans.
  const [a, b, c] = mesh(3);
  for (const h of [a!, b!, c!]) await h.sync.start();
  const until = async (cond: () => boolean) => {
    const end = Date.now() + 15_000; // a hang guard
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };
  try {
    b!.enabled.themes = false;
    a!.write("sova/themes/toggle.json", theme("Toggle"));
    a!.sync.observe();
    await converge([a!, b!, c!]);
    assert.equal(c!.read("sova/themes/toggle.json"), theme("Toggle"));
    rmSync(join(a!.stateDir, "themes", "toggle.json"));
    b!.enabled.themes = true;
    // b pulls from a before a's watcher fires: a.doc() folds the delete into a's records.
    await b!.sync.syncWith(b!.peerTo(a!));
    assert.equal(await until(() => c!.read("sova/themes/toggle.json") === undefined), true, "c lost it without a reconcile");
  } finally {
    for (const h of [a!, b!, c!]) h.sync.stop();
  }
});

// ---------------------------------------------------------------- the subagent profile library

const prof = (id: string, name: string, model?: string): SubagentProfile => ({
  id,
  name,
  delegate: delegateDefaults().profiles,
  teams: null,
  members: model ? { backend: "pi", model, effort: "low" } : null,
  specWriter: null,
});
const LIB = "subagent-profiles.json";
/** The library's profiles on a host, by id → members model ("-" for none). */
const libOf = (h: Host): Record<string, string> => {
  const st = readSubagentProfiles(h.agentDir);
  assert.equal(st.state, "ok", `${h.id}'s library parses`);
  return Object.fromEntries((st as { value: { profiles: SubagentProfile[] } }).value.profiles.map((p) => [p.id, p.members?.model ?? "-"]));
};
const save = (h: Host, profiles: SubagentProfile[]) => {
  writeSubagentProfiles(h.agentDir, { version: 1, profiles });
  h.sync.observe();
};
const startAll = async (hosts: Host[]) => {
  for (const h of hosts) await h.sync.start();
};
const stopAll = (hosts: Host[]) => hosts.forEach((h) => h.sync.stop());

test("library: a fresh device's starter yields to the mesh's real library, which stays untouched (first run, or seeded while running)", async () => {
  // The incident: the real library exists first; the fresh device seeds its starter minutes later.
  const [flow, zen] = mesh(2);
  writeSubagentProfiles(flow!.agentDir, { version: 1, profiles: [prof("fast", "Fast", "zai/fast"), prof("deep", "Deep", "zai/deep"), prof("cheap", "Cheap")] });
  const real = flow!.read(LIB);
  await tick();
  assert.equal(loadSubagentProfiles(zen!.agentDir).state, "ok"); // seeds "My setup", dated at the epoch
  await startAll([flow!, zen!]);
  try {
    await converge([flow!, zen!]);
    assert.equal(flow!.read(LIB), real, "the real library is never replaced by a starter");
    assert.equal(zen!.read(LIB), real, "the fresh device takes the real library whole, its starter dropped");
    // The starter it had is kept, and Settings → Subagents says so.
    const notice = replacedNotice(zen!.agentDir)!;
    assert.equal(notice.by, "Device A", "flow is host a here");
    assert.deepEqual(notice.changes, { added: ["Fast", "Deep", "Cheap"], changed: [], removed: ["My setup"] });
    assert.equal(replacedNotice(flow!.agentDir), undefined, "nothing replaced on the device that had the library");
  } finally {
    stopAll([flow!, zen!]);
  }

  // Already running with the mesh on (a sync record exists) when the starter is seeded.
  const [desk, air] = mesh(2);
  writeSubagentProfiles(desk!.agentDir, { version: 1, profiles: [prof("fast", "Fast", "zai/fast")] });
  await startAll([desk!, air!]);
  try {
    await converge([desk!, air!]);
    rmSync(join(air!.agentDir, LIB));
    air!.sync.observe();
    await tick();
    loadSubagentProfiles(air!.agentDir);
    air!.sync.observe();
    await converge([desk!, air!]);
    assert.deepEqual(libOf(desk!), { fast: "zai/fast" });
    assert.deepEqual(libOf(air!), { fast: "zai/fast" }, "a starter seeded on a running device is dated by its file, not by when it was seen");
  } finally {
    stopAll([desk!, air!]);
  }
});

test("library: a device alone keeps its starter; two starters meeting keep one", async () => {
  const [solo] = mesh(1);
  loadSubagentProfiles(solo!.agentDir);
  const starter = solo!.read(LIB);
  await solo!.sync.start();
  try {
    await solo!.sync.syncAll();
    assert.equal(solo!.read(LIB), starter);
    assert.equal(solo!.sync.manifest().docs[LIBRARY_KEY]?.items?.["my-setup"]?.modifiedAt, 0, "dated as old");
  } finally {
    solo!.sync.stop();
  }
  const [a, b] = mesh(2);
  loadSubagentProfiles(a!.agentDir);
  loadSubagentProfiles(b!.agentDir);
  await startAll([a!, b!]);
  try {
    await converge([a!, b!]);
    assert.deepEqual(Object.keys(libOf(a!)), ["my-setup"]);
    assert.equal(a!.read(LIB), b!.read(LIB));
  } finally {
    stopAll([a!, b!]);
  }
});

test("library: a profile only one device has survives a sync with a device that lacks it, even when that device's file is newer", async () => {
  const [a, b] = mesh(2);
  writeSubagentProfiles(a!.agentDir, { version: 1, profiles: [prof("x", "X"), prof("only-a", "Only A")] });
  await tick();
  writeSubagentProfiles(b!.agentDir, { version: 1, profiles: [prof("x", "X"), prof("only-b", "Only B")] });
  await startAll([a!, b!]);
  try {
    await converge([a!, b!]);
    for (const h of [a!, b!]) assert.deepEqual(Object.keys(libOf(h)).sort(), ["only-a", "only-b", "x"], h.id);
    assert.equal(a!.read(LIB), b!.read(LIB), "one library everywhere");
  } finally {
    stopAll([a!, b!]);
  }
});

test("library: a deleted profile stays deleted, even after a device that still has it comes back", async () => {
  const [a, b, c] = mesh(3);
  await startAll([a!, b!, c!]);
  try {
    save(a!, [prof("x", "X"), prof("y", "Y")]);
    await converge([a!, b!, c!]);
    assert.deepEqual(Object.keys(libOf(c!)), ["x", "y"]);
    c!.online = false;
    await tick();
    save(a!, [prof("x", "X")]);
    await converge([a!, b!, c!]);
    assert.deepEqual(Object.keys(libOf(b!)), ["x"]);
    assert.deepEqual(Object.keys(libOf(c!)), ["x", "y"], "c was away");
    c!.online = true;
    await converge([c!, a!, b!]);
    for (const h of [a!, b!, c!]) assert.deepEqual(Object.keys(libOf(h)), ["x"], `${h.id}: Y did not come back`);
  } finally {
    stopAll([a!, b!, c!]);
  }
});

test("library: two edits to one profile resolve newest-wins for that profile only", async () => {
  const [a, b] = mesh(2);
  await startAll([a!, b!]);
  try {
    save(a!, [prof("x", "X"), prof("y", "Y")]);
    await converge([a!, b!]);
    a!.online = false;
    b!.online = false;
    await tick();
    save(a!, [prof("x", "X", "zai/a-first"), prof("y", "Y", "zai/a-y")]);
    await tick();
    save(b!, [prof("x", "X", "zai/b-later"), prof("y", "Y")]);
    a!.online = true;
    b!.online = true;
    await converge([a!, b!]);
    for (const h of [a!, b!]) assert.deepEqual(libOf(h), { x: "zai/b-later", y: "zai/a-y" }, h.id);
    await tick();
    save(a!, [prof("x", "X", "zai/a-again"), prof("y", "Y", "zai/a-y")]);
    await converge([a!, b!]);
    assert.deepEqual(libOf(b!), { x: "zai/a-again", y: "zai/a-y" });
  } finally {
    stopAll([a!, b!]);
  }
});

/** A peer on an older build: whole documents, newest edit wins, no per-profile stamps. */
class OldPeer implements DocPeer {
  docs: Record<string, DocReply> = {};
  constructor(readonly id: string) {}
  set(key: string, content: string, modifiedAt: number) {
    this.docs[key] = { meta: { hash: createHash("sha256").update(content).digest("hex"), modifiedAt, origin: this.id }, content };
  }
  async manifest(): Promise<DocManifest> {
    return { hostId: this.id, now: Date.now(), docs: Object.fromEntries(Object.entries(this.docs).map(([k, d]) => [k, d.meta])) };
  }
  async doc(key: string): Promise<DocReply> {
    const d = this.docs[key];
    if (!d) throw new Error("404");
    return structuredClone(d);
  }
  async push(body: DocPush) {
    const accepted: string[] = [];
    for (const [key, item] of Object.entries(body.docs)) {
      const mine = this.docs[key];
      // The old build stored the sender's meta as given, extra keys and all.
      if (!mine || compareDocs(item.meta, mine.meta) > 0) {
        this.docs[key] = structuredClone(item);
        accepted.push(key);
      }
    }
    return { accepted, rejected: [] };
  }
}

test("library: an older peer's whole file is merged by union (nothing it lacks is deleted), and it takes the union back", async () => {
  const [a] = mesh(1);
  await a!.sync.start();
  try {
    save(a!, [prof("x", "X"), prof("mine", "Mine")]);
    const old = new OldPeer("old");
    old.set(LIBRARY_KEY, libraryText([prof("x", "X", "zai/old-edit"), prof("theirs", "Theirs")]), Date.now() + 5_000);
    await a!.sync.syncWith(old);
    assert.deepEqual(libOf(a!), { x: "zai/old-edit", mine: "-", theirs: "-" }, "its newer X is taken; Mine stays; Theirs joins");
    assert.equal(old.docs[LIBRARY_KEY]!.content, a!.read(LIB), "the older peer replaced its file with the union");
    // Its file re-sent as a push (no stamps): still a union, never a deletion.
    const lacking = libraryText([prof("x", "X", "zai/old-edit")]);
    const sentAt = Date.now() + 9_000;
    const r = a!.sync.receivePush("old", { hostId: "old", now: Date.now(), docs: { [LIBRARY_KEY]: { meta: { hash: createHash("sha256").update(lacking).digest("hex"), modifiedAt: sentAt, origin: "old" }, content: lacking } } });
    assert.deepEqual(r.rejected, []);
    assert.deepEqual(Object.keys(libOf(a!)).sort(), ["mine", "theirs", "x"], "nothing it lacks was deleted");
    assert.ok(a!.sync.manifest().docs[LIBRARY_KEY]!.modifiedAt > sentAt, "dated after its file, so the older peer takes the union back");
    // An absent library from an older peer deletes nothing either.
    assert.equal(a!.sync.apply(LIBRARY_KEY, { meta: { hash: null, modifiedAt: Date.now() + 20_000, origin: "old" }, content: null }), "older");
    assert.ok(a!.read(LIB));
  } finally {
    a!.sync.stop();
  }
});

test("a settings file that first appears on a running host is dated by its own age, never by when it was seen", async () => {
  const [a, b] = mesh(2);
  await startAll([a!, b!]);
  try {
    await converge([a!, b!]); // both running, with sync records, and no mode.json anywhere
    b!.online = false;
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await tick();
    // Later, b gets a copy of a day-old file (restored from a backup, say).
    const old = new Date(Date.now() - 86_400_000);
    b!.write("mode.json", modeJson("plan"));
    utimesSync(join(b!.agentDir, "mode.json"), old, old);
    b!.sync.observe();
    assert.ok(b!.sync.recordsSnapshot()["settings:mode.json"]!.modifiedAt <= old.getTime() + 1, "dated by its mtime");
    b!.online = true;
    await converge([a!, b!]);
    assert.equal(b!.read("mode.json"), modeJson("delegate"), "a's edit, made after that file's own edit, wins");
  } finally {
    stopAll([a!, b!]);
  }
});

test("kept copies: a replaced settings document is kept (newest 10); a replaced library is kept, and Restore brings it back everywhere", async () => {
  const [a, b] = mesh(2);
  await startAll([a!, b!]);
  try {
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!]);
    for (let i = 0; i < 12; i++) {
      await tick();
      b!.write("mode.json", modeJson(`m${i}`));
      b!.sync.observe();
      await converge([a!, b!]);
    }
    const kept = listKept(a!.stateDir, "settings:mode.json");
    assert.equal(kept.length, 10, "the newest 10");
    assert.equal(kept[0]!.content, modeJson("m10"), "newest first: the version m11 replaced");
    assert.equal(kept[0]!.by, "b");
    assert.equal(kept[0]!.byName, "Device B");
    assert.equal(listKept(b!.stateDir, "settings:mode.json").length, 0, "b's own edits keep nothing, and its first copy replaced no file");

    save(a!, [prof("fast", "Fast", "zai/mine")]);
    await converge([a!, b!]);
    const before = a!.read(LIB);
    await tick();
    save(b!, [prof("fast", "Fast", "zai/theirs"), prof("extra", "Extra")]);
    await converge([a!, b!]);
    assert.deepEqual(libOf(a!), { fast: "zai/theirs", extra: "-" });
    const notice = replacedNotice(a!.agentDir)!;
    assert.deepEqual(notice.changes, { added: ["Extra"], changed: ["Fast"], removed: [] });
    assert.equal(notice.by, "Device B");
    const restored = restoreReplacedProfiles(notice.file, a!.agentDir);
    assert.ok(!("error" in restored), JSON.stringify(restored));
    assert.equal(a!.read(LIB), before, "the kept version, back as written");
    assert.equal(replacedNotice(a!.agentDir), undefined, "the notice is done");
    await tick();
    a!.sync.observe();
    await converge([a!, b!]);
    for (const h of [a!, b!]) assert.deepEqual(libOf(h), { fast: "zai/mine" }, `${h.id}: the restore is the newest edit`);
    assert.equal(replacedNotice(a!.agentDir, Date.now() + 25 * 3600_000), undefined);
    assert.ok("error" in restoreReplacedProfiles("../../etc/passwd", a!.agentDir));
  } finally {
    stopAll([a!, b!]);
  }
});
