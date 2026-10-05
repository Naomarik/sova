// Scenario f: slice quality on a small synthetic spec with planted items, so each row has a known right answer.
// The builder's seed is §f.seed/edit. Planted around it:
// - a true dependency (§f.dep/rule, named in the seed's text) and its own dependency, two hops out (§f.deep/base);
// - an embedded H1 with three H2s (§f/panel, drawn inside the seed);
// - a contrast-only edge to a 40 KB H1 (§f/wander: required, but the text only says "unlike" it);
// - a sibling H2 that answers a need (§f.seed/limits; nothing links it);
// - a core claim (§design.rules/voice, `core: true`), linked to nothing;
// - an about note (§design.copy/editor, `about: [§f/seed]`, its heading names the surface);
// - two uninvestigated behaviors: one that mentions the seed (the true consumer), one unrelated.
// Rows measure; guards hold today and must keep holding; target rows record what today's tools miss by design.
// The pull checks need `toc` (and `read`); a tree without them reports n/a, never a pass.
import { Repo, seedSpec } from "./lib.mjs";
import { specIndex, readStream, proseTexts, idsIn, capability, readToc, readPassage, accepts, readLines } from "./fullness.mjs";
import { FRAME_CAP, DIRS } from "./scenario-g.mjs";

const row = (scenario, metric, value, guards = []) => ({ scenario, metric, value, guards });
const guard = (name, ok, detail = "", na = false) => ({ name, ok: Boolean(ok), detail, ...(na ? { na: true } : {}) });

const SEED = "§f.seed/edit";
const P = {
  dep: "§f.dep/rule", deep: "§f.deep/base", panel: "§f/panel", panelKids: ["§f.panel/bold", "§f.panel/italic", "§f.panel/link"],
  wander: "§f/wander", sibling: "§f.seed/limits", core: "§design.rules/voice", about: "§design.copy/editor",
  consumer: "§f.other/uses-edit", unrelated: "§f.other/unrelated",
};
const WANDER_KIDS = ["first", "second", "third", "fourth"].map((k) => `§f.wander/${k}`);

/** About 10 KB of prose that says nothing the seed needs; deterministic. */
const filler = (tag) => Array.from({ length: 108 }, (_, i) => `The ${tag} archive keeps entry ${i + 1} in the order it arrived, and a reader may page through it.`).join(" ") + "\n";

const FILES = {
  ".sova/spec/claims/f/seed.md": [
    "# §f/seed — Editor", "", "The editor pane, where a draft is written.", "",
    "## §f.seed/edit — Editing", "",
    "Editing saves the draft whenever the writer pauses, as §f.dep/rule allows. The toolbar is drawn inside the editor as §f/panel. Unlike §f/wander, editing never asks before it saves.", "",
    "## §f.seed/limits — Limits", "", "A draft holds at most 200 lines; the 201st is refused with \"Drafts stop at 200 lines.\"", "",
  ].join("\n"),
  ".sova/spec/claims/f/dep.md": "# §f/dep — Saving\n\nWhen drafts may be written.\n\n## §f.dep/rule — Save rule\n\nA save runs only when no other save is in flight; it builds on §f.deep/base.\n",
  ".sova/spec/claims/f/deep.md": "# §f/deep — Write queue\n\nThe one queue every write goes through.\n\n## §f.deep/base — Queue order\n\nEvery write goes through one queue, in the order it was asked for.\n",
  ".sova/spec/claims/f/panel.md": "# §f/panel — Toolbar\n\nThe formatting toolbar, drawn inside a host surface.\n\n## §f.panel/bold — Bold\n\nBold wraps the selection in `**`.\n\n## §f.panel/italic — Italic\n\nItalic wraps the selection in `_`.\n\n## §f.panel/link — Link\n\nLink asks for an address and wraps the selection as a link.\n",
  ".sova/spec/claims/f/wander.md": `# §f/wander — Archive\n\nThe archive of old drafts, which asks before it overwrites anything.\n\n${WANDER_KIDS.map((id, i) => `## ${id} — Archive part ${i + 1}\n\n${filler(`part-${i + 1}`)}`).join("\n")}`,
  ".sova/spec/claims/f/other.md": "# §f/other — Sidebar\n\nThe sidebar beside the editor.\n\n## §f.other/uses-edit — Outline\n\nThe outline shows the draft that §f.seed/edit saves, heading by heading.\n\n## §f.other/unrelated — Clock\n\nThe clock shows the time.\n",
  ".sova/spec/claims/design/rules.md": "# §design/rules — Ground rules\n\nRules every surface follows.\n\n## §design.rules/voice — Voice\n\nEvery message says what happened and what to do next.\n",
  ".sova/spec/claims/design/copy.md": "# §design/copy — Copy deck\n\nThe exact words surfaces show.\n\n## §design.copy/editor — Editor copy (§f/seed)\n\nThe save hint reads \"Saved\"; the limit refusal reads \"Drafts stop at 200 lines.\"\n",
  "src/edit.txt": "edit\n", "src/limits.txt": "limits\n", "src/dep.txt": "dep\n", "src/deep.txt": "deep\n", "src/panel.txt": "panel\n", "src/other.txt": "other\n",
};
const CLAIMS = {
  "§f/seed": { kind: "surface", authority: "accepted" },
  [SEED]: { kind: "behavior", authority: "accepted", requires: [P.dep, P.panel, P.wander], embeds: [P.panel], code: ["src/edit.txt"] },
  [P.sibling]: { kind: "behavior", authority: "accepted", requires: [], code: ["src/limits.txt"] },
  "§f/dep": { kind: "surface", authority: "accepted" },
  [P.dep]: { kind: "behavior", authority: "accepted", requires: [P.deep], code: ["src/dep.txt"] },
  "§f/deep": { kind: "surface", authority: "accepted" },
  [P.deep]: { kind: "behavior", authority: "accepted", requires: [], code: ["src/deep.txt"] },
  [P.panel]: { kind: "surface", authority: "accepted" },
  ...Object.fromEntries(P.panelKids.map((id) => [id, { kind: "behavior", authority: "accepted", requires: [], code: ["src/panel.txt"] }])),
  [P.wander]: { kind: "surface", authority: "accepted" },
  ...Object.fromEntries(WANDER_KIDS.map((id) => [id, { kind: "behavior", authority: "accepted", requires: [] }])),
  "§f/other": { kind: "surface", authority: "accepted" },
  [P.consumer]: { kind: "behavior", authority: "accepted", code: ["src/other.txt"] },
  [P.unrelated]: { kind: "behavior", authority: "accepted", code: ["src/other.txt"] },
  "§design/rules": { kind: "note", authority: "accepted" },
  [P.core]: { kind: "note", authority: "accepted", core: true },
  "§design/copy": { kind: "note", authority: "accepted" },
  [P.about]: { kind: "note", authority: "accepted", about: ["§f/seed"] },
};

/** What a builder of the seed needs: the seed and its orientation, the true dependencies, the embedded H1, the frame, the about note. */
const RELEVANT = [SEED, "§f/seed", "§f/dep", P.dep, "§f/deep", P.deep, P.panel, ...P.panelKids, P.core, P.about, P.sibling];

export async function sliceQuality(ctx) {
  const repo = new Repo(ctx.ws.dir("f-synthetic"), ctx.ws.home);
  seedSpec(repo, { boundary: { include: ["src"], exclude: [] }, claims: CLAIMS, files: FILES });
  const index = specIndex(repo.root);
  const rows = [];
  const run = (args) => ctx.tools.spec(repo.root, ctx.ws.home, args);

  // ── The packet arm ──
  const prose = await readStream(ctx.tools, repo.root, ctx.ws.home, ["packet", SEED]);
  const frontier = await readStream(ctx.tools, repo.root, ctx.ws.home, ["packet", SEED, "--part", "frontier"]);
  const frame = await readStream(ctx.tools, repo.root, ctx.ws.home, ["packet", SEED, "--part", "frame"]);
  const texts = new Map([...proseTexts(prose.items), ...(frame.refused ? [] : proseTexts(frame.items))]);
  const inexact = [...texts].filter(([id, t]) => index.passages.get(id)?.text !== t).map(([id]) => id);
  const read = new Set([...texts.keys()].filter((id) => !inexact.includes(id)));
  const named = new Set([...idsIn(frontier.items)].filter((id) => !read.has(id) && index.passages.has(id)));
  const bytes = [...texts.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
  const bytesOf = (ids) => ids.filter((id) => read.has(id)).reduce((s, id) => s + index.passages.get(id).bytes, 0);
  const frameBytes = frame.refused ? 0 : [...proseTexts(frame.items).values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
  const status = (id) => (read.has(id) ? "read" : named.has(id) ? "named" : "absent");
  const deps = [P.dep, P.deep, P.panel, ...P.panelKids];
  const missingDeps = deps.filter((id) => !read.has(id));

  rows.push(row("f", "f.packet.slice", { bytes, passages: texts.size, files: new Set([...texts.keys()].map((id) => index.passages.get(id)?.rel)).size, calls: prose.calls }, [
    guard("f.ran", !prose.refused, prose.refused ? `packet refused: ${prose.refused}` : "packet answered"),
    guard("f.spans-exact", texts.size > 0 && inexact.length === 0, inexact.length ? `not byte-equal to the source span: ${inexact.join(", ")}` : `${texts.size} passage(s) byte-equal to their source span`),
    guard("f.deps-read-whole", missingDeps.length === 0, missingDeps.length ? `not read whole: ${missingDeps.join(", ")}` : "the true dependency, its dependency and the embedded H1 with its 3 H2s are read whole"),
    guard("f.mention-not-absent", status(P.wander) !== "absent", `the contrast-only target is ${status(P.wander)}`),
    guard("f.frame-cap", frameBytes <= FRAME_CAP, `frame ${frameBytes} B, cap ${FRAME_CAP} B`),
  ]));
  rows.push(row("f", "f.packet.precision", bytes ? Math.round((bytesOf(RELEVANT) / bytes) * 100) / 100 : 0));
  rows.push(row("f", "f.packet.wander-bytes", bytesOf([P.wander, ...WANDER_KIDS])));
  rows.push(row("f", "f.packet.names-only", named.size));
  rows.push(row("f", "f.packet.unknown", frontier.items.length));
  rows.push(row("f", "f.packet.frame-bytes", frame.refused ? "no frame stream" : frameBytes));
  // Targets: today's packet misses these by design; a candidate moves them.
  rows.push(row("f", "f.target.sibling", status(P.sibling)));
  rows.push(row("f", "f.target.about-note", status(P.about)));
  rows.push(row("f", "f.target.core-unasked", status(P.core)));

  // ── Reverse impact ──
  const imp = run(["impact", SEED]);
  const consumers = (imp.json?.consumers ?? []).map((c) => c.id);
  const front = (imp.json?.frontier ?? []).map((c) => c.id);
  rows.push(row("f", "f.impact", imp.json ? { consumers: consumers.length, frontier: front.length, unrelatedOnFrontier: front.includes(P.unrelated) } : `no-json(status ${imp.status})`, [
    guard("f.true-consumer-kept", consumers.includes(P.consumer) || front.includes(P.consumer), `${P.consumer} is ${consumers.includes(P.consumer) ? "a consumer" : front.includes(P.consumer) ? "on the frontier" : "gone"}`),
  ]));
  // Narrowed impact (`--near`): n/a only when the tree rejects the flag.
  if ((await accepts(ctx.tools, repo.root, ctx.ws.home, ["impact", "§f/seed", "--near"])) === "absent") {
    rows.push(row("f", "f.impact-near", "n/a", [guard("f.near.true-consumer-kept", true, "n/a: no impact --near", true), guard("f.near.unrelated-off-frontier", true, "n/a: no impact --near", true)]));
  } else {
    const n = await readLines(ctx.tools, repo.root, ctx.ws.home, ["impact", "§f/seed", "--near"]);
    const groupOf = (id) => n.lines.filter((l) => l.id === id).map((l) => l.group);
    const kept = groupOf(P.consumer), stray = groupOf(P.unrelated).filter((g) => g === "frontier");
    rows.push(row("f", "f.impact-near", n.ok ? { lines: n.lines.length, consumer: kept.join(",") || "absent", unrelated: groupOf(P.unrelated).join(",") || "absent" } : `refused: ${n.refused}`, [
      guard("f.near.true-consumer-kept", n.ok && kept.length > 0, n.ok ? `${P.consumer}: ${kept.join(",") || "absent"}` : `impact --near failed: ${n.refused}`),
      guard("f.near.unrelated-off-frontier", n.ok && stray.length === 0, n.ok ? `${P.unrelated}: ${groupOf(P.unrelated).join(",") || "absent"}` : `impact --near failed: ${n.refused}`),
    ]));
  }

  // ── Under pull ──
  rows.push(...(await pull(ctx, repo, index)));
  return rows;
}

/** The pull checks: `toc` on the seed in every direction, then `read` of the seed. */
async function pull(ctx, repo, index) {
  const [toc, rd] = await Promise.all(["toc", "read"].map((cmd) => capability(ctx.tools, repo.root, ctx.ws.home, cmd)));
  const na = (name, what) => guard(name, true, `n/a: this tree has no ${what}`, true);
  if (toc === "absent") {
    return [
      row("f", "f.pull.lines", "n/a", [na("f.pull.items-shown", "toc"), na("f.pull.what-and-why", "toc"), na("f.pull.unrelated-only-in", "toc")]),
      ...(rd === "absent" ? [row("f", "f.pull.read", "n/a", [na("f.pull.read-exact", "read"), na("f.pull.read-names-links", "read")])] : []),
      row("f", "f.pull.target.unasked", "n/a"),
      row("f", "f.pull.target.about-note", "n/a"),
      row("f", "f.pull.target.sibling", "n/a"),
    ].concat(rd === "absent" ? [] : await readRows(ctx, repo, index, rd));
  }
  const byDir = {};
  let bytes = 0, calls = 0;
  const broken = [], delivered = new Set();
  for (const dir of DIRS) {
    const t = await readToc(ctx.tools, repo.root, ctx.ws.home, SEED, dir);
    bytes += t.bytes; calls += t.calls;
    if (!t.ok) broken.push(`${dir}: ${t.refused}`);
    byDir[dir] = t.lines;
    idsIn(t.footer?.delivered ?? [], delivered);
  }
  // What arrives unasked with a plain `read` of the seed (first page): its items and any frame items.
  const unasked = await ctx.tools.runAsync(repo.root, ctx.ws.home, ["read", SEED]);
  for (const it of unasked.json?.items ?? []) if (typeof it?.id === "string" && it.id !== SEED) delivered.add(it.id);
  idsIn(unasked.json?.frame ?? {}, delivered); // the frame, in whatever form read carries it (items or passages)
  const where = (id) => DIRS.filter((d) => byDir[d].some((l) => l.id === id));
  const line = (id) => DIRS.flatMap((d) => byDir[d]).find((l) => l.id === id);
  // Each planted link shows as a line in the direction a builder would ask for it.
  const expect = [[P.dep, ["out"]], [P.panel, ["out"]], [P.wander, ["out"]], [P.consumer, ["in", "mentions"]]];
  const unshown = expect.filter(([id, dirs]) => !dirs.some((d) => where(id).includes(d))).map(([id, dirs]) => `${id} (wanted under ${dirs.join("|")}; seen under ${where(id).join(",") || "none"})`);
  // A what, and a why or a plain statement that none is written (whySource "none").
  const said = (s) => typeof s === "string" && s.trim().length > 0;
  const vague = expect.map(([id]) => line(id)).filter(Boolean).filter((l) => !(said(l.what) && said(l.why) && ["prose", "comment", "none"].includes(l.whySource))).map((l) => l.id);
  const strayUnrelated = where(P.unrelated).filter((d) => d !== "in");
  const all = DIRS.flatMap((d) => byDir[d]);
  const lines = Object.fromEntries(DIRS.map((d) => [d, byDir[d].length]));
  const whyProse = all.filter((l) => l.whySource === "prose").length, whyComment = all.filter((l) => l.whySource === "comment").length;
  return [
    row("f", "f.pull.lines", { ...lines, whyProse, whyComment, bytes, calls }, [
      guard("f.pull.items-shown", broken.length === 0 && unshown.length === 0, broken.length ? `toc failed: ${broken.join("; ")}` : unshown.length ? `not shown: ${unshown.join("; ")}` : "every planted link is a contents line in its direction"),
      guard("f.pull.what-and-why", broken.length === 0 && vague.length === 0, vague.length ? `line without a what or a why: ${vague.join(", ")}` : "every planted line says what it is and why it is linked, or that no reason is written"),
      guard("f.pull.unrelated-only-in", broken.length === 0 && strayUnrelated.length === 0, strayUnrelated.length ? `the unrelated consumer shows under ${strayUnrelated.join(",")}` : "the unrelated consumer shows only under --dir in, if at all"),
    ]),
    ...(rd === "absent" ? [row("f", "f.pull.read", "n/a", [na("f.pull.read-exact", "read"), na("f.pull.read-names-links", "read")])] : await readRows(ctx, repo, index, rd)),
    row("f", "f.pull.target.unasked", [P.core, P.panel].map((id) => `${id}:${delivered.has(id) ? "delivered" : "not"}`).join(", ")),
    row("f", "f.pull.target.about-note", where(P.about).length ? `line under ${where(P.about).join(",")}` : "absent"),
    row("f", "f.pull.target.sibling", where(P.sibling).length ? `line under ${where(P.sibling).join(",")}` : "absent"),
  ];
}

/** `read` of the seed: exactly its span, about its own size, and every link it didn't open still named. */
async function readRows(ctx, repo, index, capable) {
  const own = index.passages.get(SEED);
  const r = capable === "broken" ? { ok: false, refused: "no-json" } : await readPassage(ctx.tools, repo.root, ctx.ws.home, SEED);
  const named = new Set(r.footer?.named ?? []);
  // A link read delivered (an embed arrives whole) needs no name; every other one must be named.
  const links = [P.dep, P.panel, P.wander].filter((id) => !named.has(id) && !r.texts?.has(id));
  return [row("f", "f.pull.read", r.ok ? { bytes: r.text ? Buffer.byteLength(r.text) : null, own: own.bytes, calls: r.calls } : `refused: ${r.refused}`, [
    guard("f.pull.read-exact", r.ok && r.text === own.text, r.ok ? (r.text === own.text ? "read returns exactly the seed's passage" : "read's text differs from the seed's source span") : `read failed: ${r.refused}`),
    guard("f.pull.read-names-links", r.ok && links.length === 0, links.length ? `links not named by read: ${links.join(", ")}` : "every link of the seed it didn't deliver is named"),
  ])];
}
