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
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { specIndex, scoreNeed, readStream, proseTexts, median, pool, idsIn, parentOf, capability, readToc, accepts, readLines } from "./fullness.mjs";
import { Tools, workspace, scrubProcessEnv } from "./lib.mjs";
import { DATA, extractPinned } from "./pinned.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export { DATA, extractPinned };
const BASELINE_FILE = join(HERE, "data/g-baseline.json");
export const FRAME_CAP = 12000;
export const DIRS = ["out", "in", "down", "up", "mentions"];
const IMPACT_SEEDS = ["§chat/composer"];
/** The families whose contents lines are graded for a written "why" (plan §5b.8). */
const WHY_FAMILIES = ["§chat/composer", "§chat/sandbox"];

const row = (metric, value, guards = []) => ({ scenario: "g", metric, value, guards });
const guard = (name, ok, detail = "", na = false) => ({ name, ok: Boolean(ok), detail, ...(na ? { na: true } : {}) });

/** The pinned spec root for this arm: `ctx.pinned` when the caller gave one, else extracted into the workspace. */
export function pinnedRoot(ctx) {
  if (ctx.pinned) return ctx.pinned;
  if (!ctx.pinnedCache) ctx.pinnedCache = extractPinned(ctx.ws.dir("g-pinned"));
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
async function pullArm(ctx, root, c, baseline) {
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
  const passages = baseline?.passageOf ?? [];
  const isShown = (p) => Boolean(p && (shown.has(p)));
  const scored = c.needs.map((n, i) => ({ i, na: n.verdict?.status === "n/a" || !n.probe, p: passages[i] })).filter((x) => !x.na);
  const lost = (baseline?.values ?? []).map((v, i) => (v > 0 && !isShown(passages[i]) ? i : null)).filter((i) => i !== null);
  return { shown: scored.filter((x) => isShown(x.p)).length, of: scored.length, bytes, calls, lines, lostUnshown: lost, broken };
}

export async function fullness(ctx) {
  const root = pinnedRoot(ctx);
  const index = specIndex(root);
  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : null;
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
  const lost = [];
  if (baseline) for (const r of results) {
    const b = baseline.comparisons[r.c.id];
    b?.values.forEach((v, i) => { if (v > 0 && r.p.values[i] < v && r.p.needs[i] !== "named") lost.push(`${r.c.id}:${i} ${r.c.needs[i].need}`); });
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
    guard("g.packet.total-never-drops", baseline && answered >= baseline.total.answered, baseline ? `${answered} vs recorded ${baseline.total.answered}` : "no recorded baseline"),
    guard("g.frame-cap", frameMax <= FRAME_CAP, `largest frame ${frameMax} B, cap ${FRAME_CAP} B`),
  ]));
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
    rows.push(row("g.pull.total", "n/a: this tree has no toc", [guard("g.pull.toc-answers", true, "n/a: this tree has no toc", true)]));
    for (const h1 of WHY_FAMILIES) rows.push(row(`g.pull.why.${h1.slice(1).replace("/", "-")}`, "n/a"));
  } else {
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
    const pulls = await pool(results, 8, async ({ c }) => ({ c, q: await pullArm(ctx, root, c, baseline?.comparisons[c.id]) }));
    for (const { c, q } of pulls) {
      rows.push(row(`g.pull.${c.id}`, { shown: q.shown, of: q.of, bytes: q.bytes, calls: q.calls, lines: q.lines.total, lost: q.lostUnshown.length }));
    }
    const broken = pulls.flatMap(({ c, q }) => q.broken.map((b) => `${c.id} ${b}`));
    const lostUnshown = pulls.flatMap(({ c, q }) => q.lostUnshown.map((i) => `${c.id}:${i} ${c.needs[i].need}`));
    const L = pulls.reduce((s, { q }) => ({ total: s.total + q.lines.total, withWhat: s.withWhat + q.lines.withWhat, withWhy: s.withWhy + q.lines.withWhy }), { total: 0, withWhat: 0, withWhy: 0 });
    rows.push(row("g.pull.total", {
      shown: pulls.reduce((s, { q }) => s + q.shown, 0), of, bytesMedian: median(pulls.map(({ q }) => q.bytes)), bytesTotal: pulls.reduce((s, { q }) => s + q.bytes, 0), callsTotal: pulls.reduce((s, { q }) => s + q.calls, 0),
      lines: L.total, linesWithWhat: L.withWhat, linesWithWhy: L.withWhy, answeredByPacketNotShown: lostUnshown.length,
    }, [guard("g.pull.toc-answers", broken.length === 0, broken.length ? `toc failed: ${broken.slice(0, 5).join("; ")}` : "every toc call answered")]));
    // A row, not a guard: one hop is a proxy, and a need two hops out is a fair loss to report. The guard
    // "no need packet answers is lost unless shown" belongs to the agent arm, where the agent may take more hops.
    rows.push(row("g.pull.not-shown", lostUnshown.join("; ") || "none"));
  }
  return rows;
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
    rows.push(row("g.where.all", "n/a: this tree has no where", [guard("g.where.all-listed", true, "n/a: this tree has no where", true)]));
    rows.push(row("g.target.where-ranked", "n/a: this tree has no where"));
  } else {
    const claims = JSON.parse(readFileSync(join(root, ".sova/spec/manifest.json"), "utf8")).claims;
    const mapping = Object.entries(claims).filter(([, r]) => (r.code ?? []).includes(WHERE_ALL)).map(([id]) => id);
    const all = await readLines(ctx.tools, root, ctx.ws.home, ["where", "--all", WHERE_ALL]);
    const listed = new Set(all.lines.map((l) => l.id));
    const missing = mapping.filter((id) => !listed.has(id));
    rows.push(row("g.where.all", { file: WHERE_ALL, mapped: mapping.length, listed: listed.size, calls: all.calls }, [
      guard("g.where.all-listed", all.ok && missing.length === 0, !all.ok ? `where --all failed: ${all.refused}` : missing.length ? `not listed: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` … ${missing.length - 5} more` : ""}` : `all ${mapping.length} claims whose code names the file are listed`),
    ]));
    const ranked = await readLines(ctx.tools, root, ctx.ws.home, ["where", WHERE_RANKED]);
    rows.push(row("g.target.where-ranked", ranked.ok ? { file: WHERE_RANKED, total: ranked.first?.total ?? null, shown: ranked.lines.length, ranked: ranked.first?.counts?.ranked ?? null, bytes: ranked.bytes } : `refused: ${ranked.refused}`));
  }
  return rows;
}

/** Record the packet arm of `tree` as the per-need baseline the guards compare against. */
export async function recordBaseline(tree, { pinned, source } = {}) {
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
    return { about: "Scenario g's recorded packet arm: per need, the value (1 in, 0.5 partial) and the passage it lives in. Generated by `node scenario-g.mjs --record <tree>`; never edited by hand.", tree: source ?? "unknown", pinned: DATA.pinned, total: { answered, of }, comparisons };
  } finally { ws.dispose(); }
}

/** The bytes `--record` writes for `tree` (a make-tree.mjs tree names its ref and commit). */
export async function baselineText(tree) {
  let source = null;
  try { source = JSON.parse(readFileSync(join(tree, "../../replay-source.json"), "utf8")); } catch { /* a working tree */ }
  return JSON.stringify(await recordBaseline(tree, { source: source ? `${source.ref} @ ${source.commit}` : "working tree" }), null, 1) + "\n";
}

export const BASELINE_PATH = BASELINE_FILE;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== "--record" || !args[1]) { console.error("usage: node scenario-g.mjs --record <extensions tree>"); process.exit(2); }
  const text = await baselineText(args[1]);
  writeFileSync(BASELINE_FILE, text);
  const out = JSON.parse(text);
  console.log(`recorded ${out.total.answered}/${out.total.of} from ${out.tree} → data/g-baseline.json`);
}
