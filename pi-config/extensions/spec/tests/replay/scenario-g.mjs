// Scenario g: fullness on the real spec. The 24 needs comparisons (data/comparisons.json) are probed against
// what one tool tree hands a builder for each seed, over a copy of `.sova/spec` pinned to one revision, so
// every arm reads identical bytes. Two computed arms:
// - packet: every prose page of `packet <seed>` (plus its `frame` stream when the tree has one);
// - pull proxy: is each need's passage shown (a `toc` line or footer, one hop from the seed, any direction)?
//   A tree without `toc` reports n/a, never a pass.
//
//   node scenario-g.mjs --record <extensions tree>   rewrite data/g-baseline.json from that tree's packet arm
import "../../../claude-code/tests/hermetic-env.mjs";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { specIndex, scoreNeed, readStream, proseTexts, median, pool, idsIn, parentOf, capability, readToc, accepts, readLines, cutWhat } from "./fullness.mjs";
import { Tools, workspace, scrubProcessEnv } from "./lib.mjs";
import { DATA, extractPinned, PINNED_SOURCES } from "./pinned.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export { DATA, extractPinned };
const BASELINE_FILE = join(HERE, "data/g-baseline.json");
export const FRAME_CAP = 12000;
export const DIRS = ["out", "in", "down", "up", "mentions"];
const IMPACT_SEEDS = ["§chat/composer"];
/** The ratchet (D18): needs shown one hop out by toc never drop below what M1 reached (106/138 at its gated head c67a1ae2). */
const SHOWN_FLOOR = 106;
/** The families whose contents lines are graded for a written "why" (plan §5b.8) and, by a reviewer, for their "what". */
const WHY_FAMILIES = ["§chat/composer", "§chat/sandbox"];
const WHAT_VERDICTS_FILE = join(HERE, "data/what-verdicts.json");
/** An H1 and its H2s, in file order. */
const familyIds = (index, h1) => [h1, ...[...index.passages.values()].filter((p) => parentOf(p.id) === h1).map((p) => p.id)];
/** A family's lines against reviewer verdicts {id: {what, right, note}} → counts; right/graded is the target. */
export function whatGrade(ids, shown, verdicts) {
  const out = { lines: ids.length, graded: 0, right: 0, stale: 0, ungraded: 0 };
  for (const id of ids) {
    const v = verdicts[id];
    if (!v) out.ungraded++;
    else if (v.what !== shown.get(id)) out.stale++;
    else { out.graded++; if (v.right === true) out.right++; }
  }
  return { ...out, pct: out.graded ? Math.round((out.right / out.graded) * 1000) / 10 : null };
}

const row = (metric, value, guards = []) => ({ scenario: "g", metric, value, guards });
const guard = (name, ok, detail = "", na = false) => ({ name, ok: Boolean(ok), detail, ...(na ? { na: true } : {}) });

/**
 * The spec root for this arm: `ctx.pinned` when the caller gave one (a candidate or another revision's spec), else
 * the pinned revision extracted into the workspace. A given spec without the `where` source files is copied into the
 * workspace with the pinned revision's sources beside it, so `where` reads the same files; the caller's dir is never written.
 */
export function pinnedRoot(ctx) {
  if (ctx.pinnedCache) return ctx.pinnedCache;
  if (ctx.pinned && PINNED_SOURCES.every((f) => existsSync(join(ctx.pinned, f)))) ctx.pinnedCache = ctx.pinned;
  else if (ctx.pinned) {
    const dir = ctx.ws.dir("g-given");
    cpSync(join(ctx.pinned, ".sova/spec"), join(dir, ".sova/spec"), { recursive: true });
    ctx.pinnedCache = extractPinned(dir, DATA.pinned.rev, PINNED_SOURCES);
  } else ctx.pinnedCache = extractPinned(ctx.ws.dir("g-pinned"));
  return ctx.pinnedCache;
}

/** Copy-deck sections that name the seed's surface (by slug, or by § in the heading). */
function copyDeckFor(index, seed) {
  const deck = [...index.passages.values()].filter((p) => p.id.startsWith("§design.copy-deck/"));
  const ns = seed.replace(/^§/, "").replace(/\./, "/").split("/").slice(0, 2).join("/");
  const h1 = `§${ns}`, slug = ns.split("/")[1];
  return deck.filter((p) => { const head = p.text.split("\n")[0]; return p.id.endsWith(`/${slug}`) || head.includes(`(${h1}`) || head.includes(`(§${ns.replace("/", ".")}`); }).map((p) => p.id);
}

const coreIds = (root) => {
  const m = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8"));
  return new Set(Object.entries(m.claims).filter(([, r]) => r.core === true).map(([id]) => id));
};

/** One comparison under the packet arm. */
async function packetArm(ctx, root, index, c) {
  const prose = await readStream(ctx.tools, root, ctx.ws.home, ["packet", c.seed]);
  const frontier = await readStream(ctx.tools, root, ctx.ws.home, ["packet", c.seed, "--part", "frontier"]);
  const frame = await readStream(ctx.tools, root, ctx.ws.home, ["packet", c.seed, "--part", "frame"]);
  const texts = proseTexts(prose.items);
  const frameTexts = frame.refused ? new Map() : proseTexts(frame.items);
  const inexact = [];
  const delivered = new Set();
  for (const [id, text] of [...texts, ...frameTexts]) {
    if (index.passages.get(id)?.text === text) delivered.add(id);
    else inexact.push(id);
  }
  const named = new Set([...idsIn(frontier.items)].filter((id) => !delivered.has(id)));
  const needs = c.needs.map((n) => scoreNeed(index, n, delivered, named));
  const scored = needs.filter((x) => x.status !== "n/a");
  const bytesOf = (m) => [...m.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
  const bytes = bytesOf(texts) + bytesOf(frameTexts);
  const seedFile = index.passages.get(c.seed)?.rel;
  const seedBytes = [...texts].filter(([id]) => index.passages.get(id)?.rel === seedFile).reduce((s, [, t]) => s + Buffer.byteLength(t), 0);
  const deck = copyDeckFor(index, c.seed);
  return {
    answered: scored.reduce((s, x) => s + x.value, 0),
    of: scored.length,
    named: scored.filter((x) => x.named).length,
    bytes,
    passages: delivered.size,
    files: new Set([...delivered].map((id) => index.passages.get(id).rel)).size,
    seedShare: bytes ? Math.round((seedBytes / bytes) * 100) / 100 : 0,
    frameBytes: bytesOf(frameTexts),
    frame: frame.refused ? "no frame stream" : "stream",
    calls: prose.calls,
    unknown: frontier.items.length,
    groundRules: [...delivered].some((id) => id === "§design/ground-rules" || id.startsWith("§design.ground-rules/")),
    copyDeck: { matching: deck.length, reached: deck.filter((id) => delivered.has(id)).length },
    core: [...coreIds(root)].filter((id) => delivered.has(id)).length,
    needs: needs.map((x) => (x.status === "missed" && x.named ? "named" : x.status)),
    passageOf: needs.map((x) => x.passage ?? null),
    values: needs.map((x) => x.value),
    inexact,
    refused: prose.refused,
  };
}

/** One comparison under the pull proxy: the ids `toc` shows one hop from the seed (its lines), in every direction. */
async function pullArm(ctx, root, c, baseline, index = specIndex(root)) {
  const shown = new Set([c.seed]);
  let bytes = 0, calls = 0;
  const lines = { total: 0, withWhat: 0, withWhy: 0 };
  const broken = [];
  for (const dir of DIRS) {
    const t = await readToc(ctx.tools, root, ctx.ws.home, c.seed, dir);
    calls += t.calls;
    bytes += t.bytes;
    if (!t.ok) broken.push(`${dir}: ${t.refused}`);
    for (const l of t.lines) {
      if (typeof l.id === "string") shown.add(l.id);
      lines.total++;
      if (typeof l.what === "string" && l.what.trim() && l.whatSource !== "none") lines.withWhat++;
      if (l.whySource === "prose" || l.whySource === "comment") lines.withWhy++;
    }
  }
  // What the frame (core records) delivers on the seed's first `read` page is in hand too: shown, and counted apart.
  // Its bytes are reported by g.read.frame-bytes, not added to the toc bytes.
  const first = await ctx.tools.runAsync(root, ctx.ws.home, ["read", c.seed]);
  const framed = new Set((first.json?.frame?.items ?? []).map((it) => it?.id).filter((id) => typeof id === "string"));
  const passages = baseline?.passageOf ?? [];
  const isShown = (p) => Boolean(p && (shown.has(p) || framed.has(p)));
  const scored = c.needs.map((n, i) => ({ i, na: n.verdict?.status === "n/a" || !n.probe, p: passages[i] })).filter((x) => !x.na);
  const frameOnly = scored.filter((x) => x.p && !shown.has(x.p) && framed.has(x.p)).map((x) => x.i);
  // The copy-deck sections for the seed's surface (M6: `about` notes): shown as a contents line, or delivered by that read.
  const deck = copyDeckFor(index, c.seed);
  const readIds = new Set((first.json?.items ?? []).map((it) => it?.id));
  const copyDeck = { matching: deck.length, shown: deck.filter((id) => shown.has(id)).length, read: deck.filter((id) => readIds.has(id) || framed.has(id)).length, which: deck.filter((id) => shown.has(id)).map((id) => `${c.id}:${id}`) };
  const lost = (baseline?.values ?? []).map((v, i) => (v > 0 && !isShown(passages[i]) ? i : null)).filter((i) => i !== null);
  return { shown: scored.filter((x) => isShown(x.p)).length, of: scored.length, bytes, calls, lines, lostUnshown: lost, frameOnly, copyDeck, broken };
}

export async function fullness(ctx) {
  const root = pinnedRoot(ctx);
  const index = specIndex(root);
  // The recorded packet arm the guards compare against: the pinned revision's, or one recorded on the spec under
  // test (`--g-baseline`, e.g. integration's spec when the candidate is a draft of it).
  const baselineFile = ctx.gBaseline ?? BASELINE_FILE;
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : null;
  const floor = ctx.gBaseline ? baseline?.pull?.shown ?? null : SHOWN_FLOOR;
  const rows = [];
  const results = await pool(DATA.comparisons, 8, async (c) => ({ c, p: await packetArm(ctx, root, index, c) }));
  for (const { c, p } of results) {
    rows.push(row(`g.packet.${c.id}`, {
      answered: p.answered, of: p.of, named: p.named, bytes: p.bytes, seedShare: p.seedShare, frameBytes: p.frameBytes,
      calls: p.calls, passages: p.passages, files: p.files, unknown: p.unknown, needs: p.needs.join(" "),
    }));
  }
  const sum = (f) => results.reduce((s, r) => s + f(r.p), 0);
  const answered = sum((p) => p.answered), of = sum((p) => p.of), named = sum((p) => p.named);
  const inexact = results.flatMap((r) => r.p.inexact.map((id) => `${r.c.id}:${id}`));
  const refused = results.filter((r) => r.p.refused).map((r) => `${r.c.id}:${r.p.refused}`);
  // No need answered at the recorded baseline is lost unless this arm names its passage.
  // A hand verdict whose quoted line is gone is listed apart (it needs a new verdict), never counted as lost or kept.
  const lost = [], moved = [];
  const unanchored = results.flatMap((r) => r.p.needs.map((s, i) => (s === "unanchored" ? `${r.c.id}:${i} ${r.c.needs[i].need}` : null)).filter(Boolean));
  if (baseline) for (const r of results) {
    const b = baseline.comparisons[r.c.id];
    b?.values.forEach((v, i) => { if (v > 0 && r.p.values[i] < v && !["named", "unanchored"].includes(r.p.needs[i])) lost.push(`${r.c.id}:${i} ${r.c.needs[i].need}`); });
    // Where each need's answer lives, against the recorded arm: a probe that now hits another passage is listed for a hand check.
    b?.passageOf.forEach((was, i) => { const now = r.p.passageOf[i]; if (was !== now && r.p.needs[i] !== "unanchored") moved.push(`${r.c.id}:${i} ${was ?? "none"} → ${now ?? "none"}`); });
  }
  const deck = results.reduce((s, r) => ({ matching: s.matching + (r.p.copyDeck.matching ? 1 : 0), reached: s.reached + (r.p.copyDeck.reached ? 1 : 0), sections: s.sections + r.p.copyDeck.matching, sectionsReached: s.sectionsReached + r.p.copyDeck.reached }), { matching: 0, reached: 0, sections: 0, sectionsReached: 0 });
  const frameMax = Math.max(...results.map((r) => r.p.frameBytes));
  rows.push(row("g.packet.total", {
    answered, of, pct: Math.round((answered / of) * 1000) / 10, named, answeredOrNamed: answered + named,
    // The research's "median" was the upper middle of 24 (the 13th smallest); both are kept.
    bytesMedian: median(results.map((r) => r.p.bytes)), bytesUpperMiddle: [...results.map((r) => r.p.bytes)].sort((a, b) => a - b)[Math.floor(results.length / 2)], bytesTotal: sum((p) => p.bytes), bytesMax: Math.max(...results.map((r) => r.p.bytes)),
    callsMedian: median(results.map((r) => r.p.calls)), callsTotal: sum((p) => p.calls), callsMax: Math.max(...results.map((r) => r.p.calls)),
    seedShareUnder20: results.filter((r) => r.p.seedShare < 0.2).length,
    frameBytesMax: frameMax, frame: results[0]?.p.frame,
    groundRules: `${results.filter((r) => r.p.groundRules).length}/${results.length}`,
    copyDeck: `${deck.sectionsReached}/${deck.sections}`,
  }, [
    guard("g.packet.ran", refused.length === 0, refused.length ? `refused: ${refused.join(", ")}` : "every seed's packet answered"),
    guard("g.packet.text-exact", inexact.length === 0, inexact.length ? `not byte-equal to the source span: ${inexact.slice(0, 5).join(", ")}${inexact.length > 5 ? ` … ${inexact.length - 5} more` : ""}` : "every delivered passage equals its source span"),
    guard("g.packet.no-need-lost", baseline && lost.length === 0, !baseline ? "no recorded baseline (data/g-baseline.json)" : lost.length ? `lost, not named: ${lost.slice(0, 6).join("; ")}${lost.length > 6 ? ` … ${lost.length - 6} more` : ""}` : `every need answered at ${baseline.tree} is still answered or named`),
    guard("g.packet.total-never-drops", baseline && answered >= baseline.total.answered, baseline ? `${answered} vs ${baseline.total.answered} recorded at ${baseline.tree}` : "no recorded baseline"),
    guard("g.frame-cap", frameMax <= FRAME_CAP, `largest frame ${frameMax} B, cap ${FRAME_CAP} B`),
    guard("g.packet.anchored", unanchored.length === 0, unanchored.length ? `hand verdicts whose quoted line is gone (re-read and re-verdict): ${unanchored.join("; ")}` : "every hand verdict's quoted line is found"),
  ]));
  rows.push(row("g.packet.passage-changed", baseline ? moved.join("; ") || "none" : "no recorded baseline"));
  // Target, not a guard (today's packet fails it by design): needs whose passage is read or named, one hop.
  rows.push(row("g.packet.target.answered-or-named", `${answered + named}/${of}`));

  // Reverse impact of the composer surface: consumers, and the uninvestigated frontier a builder must clear.
  for (const seed of IMPACT_SEEDS) {
    const r = ctx.tools.spec(root, ctx.ws.home, ["impact", seed]);
    rows.push(row(`g.impact.${seed.slice(1).replace(/[/.]/g, "-")}`, r.json ? { consumers: r.json.consumers?.length ?? null, frontier: r.json.frontier?.length ?? null } : `no-json(status ${r.status})`));
  }

  rows.push(...(await mapRows(ctx, root)));

  // The pull proxy: n/a only when the tree's sova-spec.mjs rejects `toc` as an unknown command.
  const toc = await capability(ctx.tools, root, ctx.ws.home, "toc");
  if (toc === "absent") {
    rows.push(row("g.pull.total", "n/a: this tree has no toc", [guard("g.pull.toc-answers", true, "n/a: this tree has no toc", true), guard("g.pull.shown-floor", true, "n/a: this tree has no toc", true)]));
    for (const h1 of WHY_FAMILIES) rows.push(row(`g.pull.why.${h1.slice(1).replace("/", "-")}`, "n/a"));
    rows.push(row("g.pull.what-whole", "n/a: this tree has no toc", [guard("g.pull.what-whole", true, "n/a: this tree has no toc", true)]));
  } else {
    // Every passage's what, read as `toc <H1> --dir down` shows it (the H1 and its H2s): a whole sentence, or
    // marked "…". A line cut at the end of its first source line reads as a what; this counts it as cut.
    const sweeps = await pool([...index.passages.values()].filter((p) => p.level === 1).map((p) => p.id), 8, (h1) => readToc(ctx.tools, root, ctx.ws.home, h1, "down"));
    const seen = new Map();
    for (const t of sweeps) for (const l of [t.seed, ...t.lines]) if (l && typeof l.id === "string" && (l.whatSource !== "none" || typeof l.what !== "string" || !l.what.trim())) seen.set(l.id, typeof l.what === "string" ? l.what : "");
    const verdicts = [...seen].map(([id, what]) => ({ id, what, v: cutWhat(what, index.passages.get(id)?.text ?? "") }));
    const bad = verdicts.filter((x) => x.v !== "whole");
    const sweepBroken = sweeps.filter((t) => !t.ok).length;
    rows.push(row("g.pull.what-whole", {
      whats: verdicts.length, cut: bad.filter((x) => x.v === "cut").length, unlocated: bad.filter((x) => x.v === "unlocated").length, empty: bad.filter((x) => x.v === "empty").length,
      first: bad.slice(0, 3).map((x) => `${x.id}: "${x.what}"`).join(" | ") || "none",
    }, [guard("g.pull.what-whole", sweepBroken === 0 && verdicts.length > 0 && bad.length === 0, sweepBroken ? `toc --dir down failed on ${sweepBroken} H1s` : bad.length ? `${bad.length} of ${verdicts.length} whats are not a whole sentence, e.g. ${bad[0].id}: "${bad[0].what}"` : `all ${verdicts.length} whats are whole sentences`)]));
    // "What" graded by a reviewer (data/what-verdicts.json, or --what-verdicts), per family: a verdict counts only
    // while the what it judged is still the one shown; a changed what is stale until graded again.
    const shownWhat = new Map();
    for (const t of sweeps) for (const l of [t.seed, ...t.lines]) if (l && typeof l.id === "string") shownWhat.set(l.id, typeof l.what === "string" ? l.what : "");
    const verdictFile = ctx.whatVerdicts ?? WHAT_VERDICTS_FILE;
    const graded = existsSync(verdictFile) ? JSON.parse(readFileSync(verdictFile, "utf8")).verdicts ?? {} : null;
    for (const h1 of WHY_FAMILIES) rows.push(row(`g.target.what-right.${h1.slice(1).replace("/", "-")}`, graded ? whatGrade(familyIds(index, h1), shownWhat, graded) : "no verdicts"));
    // Contents-line quality: `--dir out` over each H2 of the family. "requires" lines are the declared edges
    // (the plan's "1 of 6"); a why found only in an HTML comment is counted apart.
    for (const h1 of WHY_FAMILIES) {
      const kids = [...index.passages.values()].filter((p) => parentOf(p.id) === h1).map((p) => p.id);
      const w = { lines: 0, requires: 0, requiresWhyProse: 0, requiresWhyComment: 0, whyProse: 0, whyComment: 0, withWhat: 0 };
      for (const id of kids) {
        const t = await readToc(ctx.tools, root, ctx.ws.home, id, "out");
        for (const l of t.lines) {
          w.lines++;
          if (typeof l.what === "string" && l.what.trim() && l.whatSource !== "none") w.withWhat++;
          if (l.whySource === "prose") w.whyProse++;
          if (l.whySource === "comment") w.whyComment++;
          if (l.group === "requires") {
            w.requires++;
            if (l.whySource === "prose") w.requiresWhyProse++;
            if (l.whySource === "comment") w.requiresWhyComment++;
          }
        }
      }
      rows.push(row(`g.pull.why.${h1.slice(1).replace("/", "-")}`, { h2s: kids.length, ...w }));
    }
    const pulls = await pool(results, 8, async ({ c }) => ({ c, q: await pullArm(ctx, root, c, baseline?.comparisons[c.id], index) }));
    for (const { c, q } of pulls) {
      rows.push(row(`g.pull.${c.id}`, { shown: q.shown, of: q.of, bytes: q.bytes, calls: q.calls, lines: q.lines.total, lost: q.lostUnshown.length }));
    }
    const broken = pulls.flatMap(({ c, q }) => q.broken.map((b) => `${c.id} ${b}`));
    const lostUnshown = pulls.flatMap(({ c, q }) => q.lostUnshown.map((i) => `${c.id}:${i} ${c.needs[i].need}`));
    const shown = pulls.reduce((s, { q }) => s + q.shown, 0);
    const L = pulls.reduce((s, { q }) => ({ total: s.total + q.lines.total, withWhat: s.withWhat + q.lines.withWhat, withWhy: s.withWhy + q.lines.withWhy }), { total: 0, withWhat: 0, withWhy: 0 });
    rows.push(row("g.pull.total", {
      shown, of, bytesMedian: median(pulls.map(({ q }) => q.bytes)), bytesTotal: pulls.reduce((s, { q }) => s + q.bytes, 0), callsTotal: pulls.reduce((s, { q }) => s + q.calls, 0),
      lines: L.total, linesWithWhat: L.withWhat, linesWithWhy: L.withWhy, answeredByPacketNotShown: lostUnshown.length,
    }, [
      guard("g.pull.toc-answers", broken.length === 0, broken.length ? `toc failed: ${broken.slice(0, 5).join("; ")}` : "every toc call answered"),
      guard("g.pull.shown-floor", floor !== null && shown >= floor, floor === null ? "the given baseline records no pull arm to hold" : `needs shown one hop out: ${shown}/${of}; floor ${floor} (${ctx.gBaseline ? "the given baseline" : "M1"})`),
    ]));
    // A row, not a guard: one hop is a proxy, and a need two hops out is a fair loss to report. The guard
    // "no need packet answers is lost unless shown" belongs to the agent arm, where the agent may take more hops.
    rows.push(row("g.pull.not-shown", lostUnshown.join("; ") || "none"));
    const frameOnly = pulls.flatMap(({ c, q }) => q.frameOnly.map((i) => `${c.id}:${i} ${c.needs[i].need}`));
    rows.push(row("g.pull.frame-answered", { needs: frameOnly.length, which: frameOnly.join("; ") || "none" }));
    // Copy-deck sections matching each seed's surface, as g.packet.total's copyDeck counts them (17 on the pinned spec).
    const deckSum = (k) => pulls.reduce((s, { q }) => s + q.copyDeck[k], 0);
    rows.push(row("g.pull.copy-deck", { shown: `${deckSum("shown")}/${deckSum("matching")}`, read: `${deckSum("read")}/${deckSum("matching")}`, which: pulls.flatMap(({ q }) => q.copyDeck.which).join(" ") || "none" }));
  }
  rows.push(...(await frameRead(ctx, root)));
  return rows;
}

/** The frame as `read --frame` delivers it (every page): its bytes and passages, under the cap; n/a when read has no --frame. */
async function frameRead(ctx, root) {
  if ((await accepts(ctx.tools, root, ctx.ws.home, ["read", "--frame"])) === "absent") return [row("g.read.frame-bytes", "n/a: this tree's read has no --frame", [guard("g.read.frame-cap", true, "n/a: no read --frame", true)])];
  let r = await ctx.tools.runAsync(root, ctx.ws.home, ["read", "--frame"]), calls = 1;
  const items = [];
  while (r.json && r.json.status !== "refused" && Array.isArray(r.json.items)) {
    items.push(...r.json.items);
    if (!r.json.next || calls >= 50) break;
    r = await ctx.tools.runAsync(root, ctx.ws.home, ["read", "--frame", "--cursor", r.json.next]);
    calls++;
  }
  const ok = Boolean(r.json && r.json.status !== "refused" && Array.isArray(r.json.items));
  const texts = proseTexts(items), bytes = [...texts.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
  return [row("g.read.frame-bytes", ok ? { bytes, passages: texts.size, calls } : `refused: ${r.json?.code ?? r.status}`, [
    guard("g.read.frame-cap", ok && bytes <= FRAME_CAP, ok ? `read --frame ${bytes} B in ${texts.size} passage(s), cap ${FRAME_CAP} B` : "read --frame failed"),
  ])];
}

/** Files whose claims `where` must list (every claim whose `code` names the file), and one to rank. */
const WHERE_ALL = "server/chat-manager.ts";
const WHERE_RANKED = "shared/protocol.ts";

/**
 * M3's views over the pinned spec: `impact --near` (narrowed reverse impact) and `where` (claims for a file), each
 * n/a only when the tree rejects the command or flag; plus digests of what must not change (`scope` and plain
 * `impact` over every seed), so any change to them shows as a changed row.
 */
async function mapRows(ctx, root) {
  const rows = [];
  const seeds = [...new Set(DATA.comparisons.map((c) => c.seed))].sort();
  const digest = async (cmd) => {
    const h = createHash("sha256");
    for (const out of await pool(seeds, 8, async (s) => (await ctx.tools.runAsync(root, ctx.ws.home, [cmd, s])).stdout.split(root).join("<root>"))) h.update(out);
    return h.digest("hex").slice(0, 16);
  };
  rows.push(row("g.digest.scope", await digest("scope")));
  rows.push(row("g.digest.impact", await digest("impact")));

  const near = await accepts(ctx.tools, root, ctx.ws.home, ["impact", "§chat/composer", "--near"]);
  if (near === "absent") rows.push(row("g.target.impact-near.chat-composer", "n/a: this tree has no impact --near"));
  else {
    const r = await readLines(ctx.tools, root, ctx.ws.home, ["impact", "§chat/composer", "--near"]);
    const groups = r.first?.counts?.groups ?? {};
    rows.push(row("g.target.impact-near.chat-composer", r.ok ? { consumers: groups.consumer ?? null, frontier: groups.frontier ?? null, lines: r.lines.length, calls: r.calls } : `refused: ${r.refused}`, [
      guard("g.impact-near.answers", r.ok, r.ok ? "impact --near answered" : `impact --near failed: ${r.refused}`),
    ]));
  }

  const where = await accepts(ctx.tools, root, ctx.ws.home, ["where", WHERE_ALL]);
  if (where === "absent") {
    rows.push(row("g.where.all", "n/a: this tree has no where", [guard("g.where.all-listed", true, "n/a: this tree has no where", true), guard("g.where.file-read", true, "n/a: this tree has no where", true)]));
    rows.push(row("g.target.where-ranked", "n/a: this tree has no where", [guard("g.where.ranked-file-read", true, "n/a: this tree has no where", true)]));
  } else {
    const claims = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8")).claims;
    const mapping = Object.entries(claims).filter(([, r]) => (r.code ?? []).includes(WHERE_ALL)).map(([id]) => id);
    const all = await readLines(ctx.tools, root, ctx.ws.home, ["where", "--all", WHERE_ALL]);
    const listed = new Set(all.lines.map((l) => l.id));
    const missing = mapping.filter((id) => !listed.has(id));
    // The source file is archived beside the pinned spec; a where that couldn't read it ranks nothing, which is ✗, never a quiet 0.
    const fileRead = (r) => guard(`g.where.${r === all ? "file-read" : "ranked-file-read"}`, r.first?.file?.state === "read", `file.state ${r.first?.file?.state ?? "absent"}`);
    rows.push(row("g.where.all", { file: WHERE_ALL, state: all.first?.file?.state ?? null, mapped: mapping.length, listed: listed.size, calls: all.calls }, [
      guard("g.where.all-listed", all.ok && missing.length === 0, !all.ok ? `where --all failed: ${all.refused}` : missing.length ? `not listed: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` … ${missing.length - 5} more` : ""}` : `all ${mapping.length} claims whose code names the file are listed`),
      fileRead(all),
    ]));
    const ranked = await readLines(ctx.tools, root, ctx.ws.home, ["where", WHERE_RANKED]);
    rows.push(row("g.target.where-ranked", ranked.ok ? { file: WHERE_RANKED, state: ranked.first?.file?.state ?? null, total: ranked.first?.total ?? null, shown: ranked.lines.length, ranked: ranked.first?.counts?.ranked ?? null, bytes: ranked.bytes } : `refused: ${ranked.refused}`, [fileRead(ranked)]));
  }
  return rows;
}

/** Record the packet arm of `tree` as the per-need baseline the guards compare against. */
export async function recordBaseline(tree, { pinned, source, specLabel } = {}) {
  scrubProcessEnv();
  const abs = realpathSync(resolve(tree));
  const ws = workspace("g-record");
  try {
    const ctx = { tools: new Tools(abs), ws, pinned };
    const root = pinnedRoot(ctx);
    const index = specIndex(root);
    const comparisons = {};
    let answered = 0, of = 0;
    for (const { c, p } of await pool(DATA.comparisons, 8, async (c) => ({ c, p: await packetArm(ctx, root, index, c) }))) {
      comparisons[c.id] = { values: p.values, needs: p.needs, passageOf: p.passageOf };
      answered += p.answered; of += p.of;
    }
    // A tree with toc also records its pull proxy, the floor a candidate on the same spec must hold.
    let pull;
    if ((await capability(ctx.tools, root, ws.home, "toc")) !== "absent") {
      const qs = await pool(DATA.comparisons, 8, (c) => pullArm(ctx, root, c, comparisons[c.id]));
      pull = { shown: qs.reduce((s, q) => s + q.shown, 0), of: qs.reduce((s, q) => s + q.of, 0) };
    }
    return { about: "Scenario g's recorded packet arm: per need, the value (1 in, 0.5 partial) and the passage it lives in. Generated by `node scenario-g.mjs --record <tree>`; never edited by hand.", tree: source ?? "unknown", pinned: specLabel ? { spec: specLabel } : DATA.pinned, total: { answered, of }, ...(pull ? { pull } : {}), comparisons };
  } finally { ws.dispose(); }
}

/** The "what" sheet a reviewer grades: each family's H1 and H2s as `toc --dir down` shows them, with the passage text. */
export async function whatSheet(tree, { pinned, families = WHY_FAMILIES } = {}) {
  scrubProcessEnv();
  const ws = workspace("g-what");
  try {
    const ctx = { tools: new Tools(realpathSync(resolve(tree))), ws, pinned };
    const root = pinnedRoot(ctx);
    const index = specIndex(root);
    const out = {};
    for (const h1 of families) {
      const t = await readToc(ctx.tools, root, ws.home, h1, "down");
      if (!t.ok) throw new Error(`toc ${h1} --dir down: ${t.refused}`);
      out[h1] = [t.seed, ...t.lines].map((l) => ({ id: l.id, what: l.what ?? "", whatSource: l.whatSource ?? null, text: index.passages.get(l.id)?.text ?? null }));
    }
    return { about: "Grade each line: is its what a true, whole account of the passage? Return {verdicts: {id: {what, right, note}}}, copying what verbatim; a verdict counts only while that what is still shown.", families: out };
  } finally { ws.dispose(); }
}

/** The bytes `--record` writes for `tree` (a make-tree.mjs tree names its ref and commit). */
export async function baselineText(tree, { pinned, specLabel } = {}) {
  let source = null;
  try { source = JSON.parse(readFileSync(join(tree, "../../replay-source.json"), "utf8")); } catch { /* a working tree */ }
  return JSON.stringify(await recordBaseline(tree, { pinned, specLabel, source: source ? `${source.ref} @ ${source.commit}` : "working tree" }), null, 1) + "\n";
}

export const BASELINE_PATH = BASELINE_FILE;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const pinned = opt("--pinned") && realpathSync(resolve(opt("--pinned")));
  if (args[0] === "--record" && args[1]) {
    // Another spec (`--pinned <dir holding .sova/spec>`, named by `--spec <label>`) records to `--out`, never over the pinned baseline.
    if (pinned && (!opt("--out") || !opt("--spec"))) { console.error("a --pinned spec records with --spec <label> --out <file>"); process.exit(2); }
    const file = opt("--out") ? resolve(opt("--out")) : BASELINE_FILE;
    const text = await baselineText(args[1], { pinned, specLabel: opt("--spec") });
    writeFileSync(file, text);
    const out = JSON.parse(text);
    console.log(`recorded ${out.total.answered}/${out.total.of}${out.pull ? `, pull shown ${out.pull.shown}/${out.pull.of}` : ""} from ${out.tree} → ${file}`);
  } else if (args[0] === "--what-sheet" && args[1]) {
    console.log(JSON.stringify(await whatSheet(args[1], { pinned, ...(opt("--families") ? { families: opt("--families").split(",") } : {}) }), null, 1));
  } else {
    console.error("usage: node scenario-g.mjs --record <extensions tree> [--pinned <dir> --spec <label> --out <file>]\n       node scenario-g.mjs --what-sheet <extensions tree> [--pinned <dir>] [--families §a/b,§c/d]");
    process.exit(2);
  }
}
