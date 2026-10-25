import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { carryOver, derivedAutonomy, POWERS, readStoredPowers } from "../shared/powers";
import { DEFAULT_HOLD_MIN, HOLD_MIN_MAX, holdProblem } from "../shared/project-overseer";
import { OrgError } from "./orgs";
import { parsePoSettings, patchPoSettings, readPoSettings, type ProjectOverseerPaths } from "./project-overseer-store";

// The hold's length (§app.project-overseer/holds): plain data in overseer.json, read tolerantly and
// patched strictly, like every other setting of the project overseer.

const root = mkdtempSync(join(tmpdir(), "po-settings-"));
after(() => rmSync(root, { recursive: true, force: true }));

const pathsIn = (dir: string): ProjectOverseerPaths => ({
  projectId: "prj_x",
  dir,
  settings: join(dir, "overseer.json"),
  notes: join(dir, "notes.md"),
  actions: join(dir, "actions.jsonl"),
  ideas: join(dir, "ideas"),
  todos: join(dir, "todos.json"),
});

const SENTENCE = `The hold must be a whole number of minutes from 0 to ${HOLD_MIN_MAX} (0: no hold).`;

describe("holdMin: how long a held act waits (§app.project-overseer/holds)", () => {
  test("the default is 10 minutes, for a missing file and a file without the key", () => {
    assert.equal(DEFAULT_HOLD_MIN, 10);
    assert.equal(parsePoSettings(undefined).holdMin, 10);
    assert.equal(parsePoSettings({ autonomy: "L2" }).holdMin, 10);
  });

  test("the file: 0 and every whole number up to the maximum are kept", () => {
    for (const v of [0, 1, 10, 59, HOLD_MIN_MAX]) assert.equal(parsePoSettings({ holdMin: v }).holdMin, v);
  });

  test("the file: over the maximum reads as the maximum; any other bad value as the default", () => {
    assert.equal(parsePoSettings({ holdMin: HOLD_MIN_MAX + 1 }).holdMin, HOLD_MIN_MAX);
    assert.equal(parsePoSettings({ holdMin: 100_000 }).holdMin, HOLD_MIN_MAX);
    for (const v of [-1, 2.5, "10", null, true, {}, Number.NaN, HOLD_MIN_MAX + 0.5]) assert.equal(parsePoSettings({ holdMin: v }).holdMin, DEFAULT_HOLD_MIN, String(v));
  });

  test("holdProblem accepts exactly the whole numbers 0..max", () => {
    assert.equal(holdProblem(0), null);
    assert.equal(holdProblem(HOLD_MIN_MAX), null);
    for (const v of [-1, HOLD_MIN_MAX + 1, 1.5, "5", null, undefined]) assert.equal(holdProblem(v), SENTENCE, String(v));
  });

  test("a PATCH saves a valid value, 0 included, and leaves the rest of the file as it was", () => {
    const p = pathsIn(mkdtempSync(join(root, "ok-")));
    writeFileSync(p.settings, JSON.stringify({ autonomy: "L3", watchGapMin: 30 }));
    assert.equal(patchPoSettings(p, { holdMin: 0 }).holdMin, 0);
    const saved = JSON.parse(readFileSync(p.settings, "utf8"));
    assert.deepEqual([saved.holdMin, saved.autonomy, saved.watchGapMin], [0, "L3", 30]);
    assert.equal(patchPoSettings(p, { holdMin: 45 }).holdMin, 45);
    assert.equal(readPoSettings(p).holdMin, 45);
  });

  test("a PATCH with a bad value is refused whole (400, the sentence) and writes nothing", () => {
    const p = pathsIn(mkdtempSync(join(root, "bad-")));
    writeFileSync(p.settings, JSON.stringify({ holdMin: 5 }));
    const before = readFileSync(p.settings, "utf8");
    for (const v of [-1, HOLD_MIN_MAX + 1, 2.5, "10", null]) {
      assert.throws(
        () => patchPoSettings(p, { holdMin: v, watch: false }),
        (err: unknown) => err instanceof OrgError && err.status === 400 && err.message === SENTENCE,
        String(v),
      );
      assert.equal(readFileSync(p.settings, "utf8"), before, "nothing written, the valid key of the same PATCH neither");
    }
  });
});

// The powers (§app.project-overseer/autonomy-levels): stored beside a never-looser level, carried over from the
// level, re-derived when an older Sova writes a level, the confirmation checklist dropped.
const LEVEL_ON = { L1: ["gather", "whatsapp", "ownerUpdates", "bookkeeping", "share"], L2: ["roster", "promote", "markMerged"], L3: ["codingStart", "codingPrompt", "onboard", "copiesRun", "copiesReset"] } as const;
const onAt = (l: "L0" | "L1" | "L2" | "L3"): string[] => {
  const on: readonly string[] = l === "L0" ? [] : l === "L1" ? [...LEVEL_ON.L1] : l === "L2" ? [...LEVEL_ON.L1, ...LEVEL_ON.L2] : [...LEVEL_ON.L1, ...LEVEL_ON.L2, ...LEVEL_ON.L3];
  return POWERS.filter((k) => on.includes(k));
};
const onOf = (m: Record<string, boolean>): string[] => POWERS.filter((k) => m[k]);
const ALL_KINDS = ["gather", "offer", "close", "promote", "build", "prompt", "owner-update", "send", "roster-approve", "roster-decline", "preview"];
const OLD_KINDS = ALL_KINDS.filter((k) => k !== "preview");

describe("powers: the migration of the six real settings shapes (al_3 t12, copied, never read from ~/.pi)", () => {
  // As overseer.json held them on 2026-10-17: five at L1, motorsaif at L3, all holdMin 10, every confirm kind
  // on except oldproject (no confirmKindsKnown, send off); amal is held by its empty roster (a ceiling, not a setting).
  const SHAPES: Record<string, Record<string, unknown>> = {
    amal: { version: 1, autonomy: "L1", holdMin: 10, confirmKinds: ALL_KINDS, confirmKindsKnown: ALL_KINDS, watch: true },
    oldproject: { version: 1, autonomy: "L1", holdMin: 10, confirmKinds: OLD_KINDS.filter((k) => k !== "send") },
    gatecapital: { version: 1, autonomy: "L1", holdMin: 10, confirmKinds: ALL_KINDS, confirmKindsKnown: ALL_KINDS, model: "anthropic/claude-sonnet-4-5" },
    "mamluk-archery": { version: 1, autonomy: "L1", holdMin: 10, confirmKinds: ALL_KINDS, confirmKindsKnown: ALL_KINDS },
    standalone: { version: 1, autonomy: "L1", holdMin: 10, confirmKinds: ALL_KINDS, confirmKindsKnown: ALL_KINDS },
    motorsaif: { version: 1, autonomy: "L3", holdMin: 10, confirmKinds: ALL_KINDS, confirmKindsKnown: ALL_KINDS, caps: { createPerDay: 4 } },
  };

  for (const [name, raw] of Object.entries(SHAPES))
    test(`${name}: within its level On, the rest Off, the assistant all Off, a one-time note; the hold kept`, () => {
      const s = parsePoSettings(raw);
      const level = raw.autonomy as "L1" | "L3";
      assert.deepEqual(onOf(s.powers.overseer), onAt(level));
      assert.equal(s.powers.overseer.deploy, false, "no level ever deployed");
      assert.deepEqual(onOf(s.powers.assistant), []);
      assert.equal(s.autonomy, level, "the derived level is the level it had");
      assert.deepEqual([s.powers.note?.kind, s.powers.note?.from, s.powers.note?.seen], ["carried-over", level, false]);
      assert.equal(s.holdMin, 10);
      assert.equal(s.confirmKinds, undefined, "the checklist is read and ignored");
    });

  test("al_3 t16, stated: every ticked kind becomes On (within the level) and goes ahead after its hold alone", () => {
    // Before: a held act of a ticked kind waited for the overseer's approval. Now nothing does (q2): the envelope
    // carries no confirm list, and the one-time note says so on the page.
    const s = parsePoSettings(SHAPES["mamluk-archery"]);
    for (const k of ["gather", "ownerUpdates", "whatsapp", "share"]) assert.equal(s.powers.overseer[k as "gather"], true, k);
  });

  test("saved: autonomy and powers.derivedAutonomy agree, no confirmKinds written, read back the same with no note change", () => {
    const p = pathsIn(join(root, "migrate-save"));
    patchPoSettings(p, { holdMin: 5 });
    writeFileSync(p.settings, JSON.stringify(SHAPES.motorsaif));
    patchPoSettings(p, { holdMin: 10 });
    const file = JSON.parse(readFileSync(p.settings, "utf8"));
    assert.equal(file.autonomy, "L3");
    assert.equal(file.powers.derivedAutonomy, "L3");
    assert.equal("confirmKinds" in file, false);
    assert.equal("confirmKindsKnown" in file, false);
    assert.deepEqual(onOf(readPoSettings(p).powers.overseer), onAt("L3"));
    assert.equal(readPoSettings(p).powers.note?.kind, "carried-over", "kept until seen");
  });
});

describe("powers: a new project", () => {
  test("no file, or a file with no level: L1's carry-over, the assistant all Off, and no one-time note", () => {
    for (const raw of [undefined, {}, { holdMin: 5 }]) {
      const s = parsePoSettings(raw);
      assert.deepEqual(onOf(s.powers.overseer), onAt("L1"));
      assert.deepEqual(onOf(s.powers.assistant), []);
      assert.equal(s.powers.note, null, JSON.stringify(raw));
    }
  });
});

describe("powers: the level written for older readers is never looser", () => {
  test("the highest level whose every old power is On; L0 when any L1 power is Off; deploy counts for none", () => {
    assert.equal(derivedAutonomy(carryOver("L3")), "L3");
    assert.equal(derivedAutonomy({ ...carryOver("L3"), deploy: true }), "L3");
    assert.equal(derivedAutonomy({ ...carryOver("L3"), markMerged: false }), "L1", "an L2 power Off caps it at L1, whatever L3 has");
    assert.equal(derivedAutonomy({ ...carryOver("L1"), codingStart: true }), "L1", "an L3 power On alone raises nothing");
    assert.equal(derivedAutonomy({ ...carryOver("L1"), share: false }), "L0");
    for (const l of ["L0", "L1", "L2", "L3"] as const) assert.equal(derivedAutonomy(carryOver(l)), l);
  });
});

describe("powers: a level written by an older Sova re-derives the switches (al_3 t15)", () => {
  test("switches saved, then an old client writes another level: overseer = carry-over of it, assistant kept, a note", () => {
    const p = pathsIn(join(root, "old-writer"));
    patchPoSettings(p, { powers: { overseer: { codingStart: true, share: false }, assistant: { codingStart: true } } });
    const saved = JSON.parse(readFileSync(p.settings, "utf8"));
    assert.equal(saved.autonomy, "L0", "share Off: never looser than L0");
    // An old Sova that keeps unknown keys (a hand edit, a merge) writes L2 beside them.
    writeFileSync(p.settings, JSON.stringify({ ...saved, autonomy: "L2" }));
    const s = readPoSettings(p);
    assert.deepEqual(onOf(s.powers.overseer), onAt("L2"));
    assert.equal(s.powers.assistant.codingStart, true, "the assistant column is kept");
    assert.deepEqual([s.powers.note?.kind, s.powers.note?.from], ["rederived", "L2"]);
    // An old Sova that drops unknown keys: no powers at all, so the carry-over.
    writeFileSync(p.settings, JSON.stringify({ version: 1, autonomy: "L3", holdMin: 10 }));
    assert.deepEqual(onOf(readPoSettings(p).powers.overseer), onAt("L3"));
    assert.equal(readPoSettings(p).powers.note?.kind, "carried-over");
  });

  test("an older Sova rewriting the same level is told by confirmKindsKnown, never by the level's value: the column re-derives", () => {
    // What an older host saves: the same L1 (to rule out coding), its confirm kinds, the powers block kept as it found it.
    const old = { autonomy: "L1", confirmKindsKnown: ["send", "preview"], confirmKinds: ["send"], powers: { version: 1, derivedAutonomy: "L1", overseer: { ...carryOver("L1"), codingStart: true }, assistant: {} } };
    const r = readStoredPowers(old);
    assert.equal(r.overseer.codingStart, false, "codingStart Off: L1's carry-over");
    assert.deepEqual(onOf(r.overseer), onAt("L1"));
    assert.deepEqual([r.note?.kind, r.note?.from], ["rederived", "L1"]);
    // either key alone is the sign
    const { confirmKinds: _k, ...knownOnly } = old;
    assert.equal(readStoredPowers(knownOnly).overseer.codingStart, false);
    const { confirmKindsKnown: _n, ...kindsOnly } = old;
    assert.equal(readStoredPowers(kindsOnly).overseer.codingStart, false);
  });

  test("a stamp that no longer matches the file re-derives; this Sova's own save round-trips with codingStart On", () => {
    const p = pathsIn(join(root, "stamp"));
    patchPoSettings(p, { powers: { overseer: { codingStart: true } } });
    const saved = JSON.parse(readFileSync(p.settings, "utf8"));
    assert.match(saved.powers.stamp, /^s1-[0-9a-f]{16}$/);
    assert.equal(saved.confirmKindsKnown, undefined, "never written by this Sova");
    assert.equal(saved.autonomy, "L1");
    // new Sova round trip: read, save again, read
    assert.equal(readPoSettings(p).powers.overseer.codingStart, true);
    assert.equal(readPoSettings(p).powers.note, null);
    patchPoSettings(p, { holdMin: 7 });
    assert.equal(readPoSettings(p).powers.overseer.codingStart, true, "kept across its own saves");
    // the same file with its keys reordered still matches (the stamp is over canonical JSON)
    const again = JSON.parse(readFileSync(p.settings, "utf8"));
    const reordered = Object.fromEntries(Object.entries(again).reverse());
    assert.equal(readStoredPowers(reordered).overseer.codingStart, true);
    // an older Sova changes something else (a cap, a model), same level, no confirm kinds: the stamp moved
    writeFileSync(p.settings, JSON.stringify({ ...again, model: "zai/glm-5.3" }));
    const s = readPoSettings(p);
    assert.equal(s.powers.overseer.codingStart, false, "re-derived from L1");
    assert.equal(s.powers.note?.kind, "rederived");
    // and an edit of the switches themselves outside this Sova
    writeFileSync(p.settings, JSON.stringify({ ...again, powers: { ...again.powers, overseer: { ...again.powers.overseer, deploy: true } } }));
    assert.equal(readPoSettings(p).powers.overseer.deploy, false);
  });

  test("a bad switch reads as its carry-over default; an assistant key the column can't have reads Off", () => {
    const s = parsePoSettings({ autonomy: "L1", powers: { version: 1, derivedAutonomy: "L1", overseer: { gather: "yes", promote: true }, assistant: { whatsapp: true, codingStart: true } } });
    assert.equal(s.powers.overseer.gather, true, "bad value: L1's default");
    assert.equal(s.powers.overseer.promote, true);
    assert.equal(s.powers.assistant.whatsapp, false);
    assert.equal(s.powers.assistant.codingStart, true);
    assert.equal(s.powers.note, null);
  });
});

describe("powers: the patch", () => {
  test("a partial column patch sets only its keys; the note can be marked seen; the old level maps by carry-over", () => {
    const p = pathsIn(join(root, "patch"));
    patchPoSettings(p, { powers: { overseer: { promote: true } } });
    assert.equal(readPoSettings(p).powers.overseer.promote, true);
    assert.equal(readPoSettings(p).powers.overseer.gather, true, "untouched keys keep their value");
    patchPoSettings(p, { autonomy: "L3" });
    assert.deepEqual(onOf(readPoSettings(p).powers.overseer), onAt("L3"));
    patchPoSettings(p, { confirmKinds: ["gather"] });
    assert.equal("confirmKinds" in JSON.parse(readFileSync(p.settings, "utf8")), false, "accepted and ignored");
  });

  test("refused whole: an unknown power or column, a non-boolean, an assistant power its column can't have", () => {
    const p = pathsIn(join(root, "patch-bad"));
    patchPoSettings(p, { holdMin: 3 });
    const before = readFileSync(p.settings, "utf8");
    for (const [bad, re] of [
      [{ overseer: { nope: true } }, /^There is no power "nope"/],
      [{ client: {} }, /^powers has no column "client"/],
      [{ overseer: { gather: 1 } }, /must be true \(On\) or false \(Off\)/],
      [{ assistant: { whatsapp: true } }, /^Message people on WhatsApp can't be turned on for the Project Assistant\.$/],
    ] as const)
      assert.throws(() => patchPoSettings(p, { powers: bad as never, holdMin: 7 }), (e: unknown) => e instanceof OrgError && e.status === 400 && re.test(e.message));
    assert.equal(readFileSync(p.settings, "utf8"), before);
    assert.doesNotThrow(() => patchPoSettings(p, { powers: { assistant: { whatsapp: false } } }), "Off is always allowed");
  });
});
