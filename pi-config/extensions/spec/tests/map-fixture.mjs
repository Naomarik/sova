// Shared fixture for the map, graph, impact --near and where tests: a small spec with source files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "../core/sova-spec.mjs");
const roots = [];
process.on("exit", () => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
export function write(root, path, text) { const abs = join(root, path); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); }

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-map-")); roots.push(root);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, claims: {
    "§ed/seed": { kind: "surface", authority: "accepted", evidence: "verified", requires: [], code: ["src/editor.ts"] },
    "§ed.seed/compose": { kind: "behavior", authority: "accepted", evidence: "verified", requires: ["§ot/base"], code: ["src/editor.ts", "src/shared.ts"] },
    "§ed.seed/save": { kind: "behavior", authority: "migrated", evidence: "unreviewed", code: ["src/save.ts"] },
    "§ot/base": { kind: "note", requires: [] },
    "§ot/uses": { kind: "behavior", authority: "accepted", requires: ["§ed.seed/compose"], code: ["src/other.ts"] },
    "§ot/whole": { kind: "behavior", requires: ["§ed/seed"] },
    "§ot/second": { kind: "behavior", requires: ["§ot/uses"] },
    "§ot/planted": { kind: "behavior", code: ["src/other.ts"] },
    "§ot/unrelated": { kind: "behavior" },
    "§ot/coder": { kind: "note", code: ["src/shared.ts", "src/link.ts"] },
    "§section/bundle": { kind: "section", members: ["§ed.seed/save"] },
  } }));
  write(root, ".sova/spec/claims/ed/seed.md", [
    "# §ed/seed — Editor (`EditorPane`)", "", "The editor pane, where a draft is written.", "",
    "## §ed.seed/compose — Compose", "", "`Composer.send()` posts `POST /api/send` with the `draftId`. It builds on §ot/base.", "",
    "## §ed.seed/save — Save", "", "Saving keeps the draft; plain words like `save` are not tokens.", "",
  ].join("\n"));
  write(root, ".sova/spec/claims/ot/base.md", "# §ot/base — Base\n\nThe base everything stands on.\n");
  write(root, ".sova/spec/claims/ot/uses.md", "# §ot/uses — Uses\n\nIt sends through the composer (§ed.seed/compose). Then it reads `draftId`.\n");
  write(root, ".sova/spec/claims/ot/whole.md", "# §ot/whole — Whole\n\nIt embeds the whole editor, without saying which part.\n");
  write(root, ".sova/spec/claims/ot/second.md", "# §ot/second — Second\n\nBuilt on the user of the composer.\n");
  write(root, ".sova/spec/claims/ot/planted.md", "# §ot/planted — Planted\n\nThe archive opens the editor (§ed/seed) before it saves.\n");
  write(root, ".sova/spec/claims/ot/unrelated.md", "# §ot/unrelated — Unrelated\n\nNothing about editors at all.\n");
  write(root, ".sova/spec/claims/ot/coder.md", "# §ot/coder — Coder\n\n<!-- §ed/seed in a comment is not a mention -->\nShares a file with the composer.\n");
  write(root, ".sova/spec/claims/section/bundle.md", "# §section/bundle — Bundle\n\nA bundle of saves.\n");
  write(root, "src/editor.ts", "export class EditorPane { send() { return Composer.send(); } } // POST /api/send with draftId\n");
  write(root, "src/shared.ts", "export const draftId = 1;\n");
  write(root, "src/save.ts", "export const save = 1;\n");
  write(root, "src/other.ts", "export const other = 1;\n");
  write(root, "src/unmapped.ts", "const x = draftId; // Composer.send()\n");
  return root;
}
export function cli(root, args, { json = true, budget } = {}) {
  const r = spawnSync(process.execPath, [CORE, ...args, "--root", root, ...(json ? ["--json"] : []), ...(budget ? ["--budget", String(budget)] : [])],
    { cwd: root, encoding: "utf8" });
  assert.equal(r.error, undefined);
  assert.equal(r.stderr, "", "no stderr side channel");
  const j = json || r.stdout.startsWith("{") ? JSON.parse(r.stdout) : null;
  if (j) assert.equal(r.status, j.exit);
  return { r, j };
}
// Every page of a command, following next; the budget holds for each.
export function pages(root, args, budget) {
  const out = [];
  let cursor;
  do {
    const { r, j } = cli(root, [...args, ...(cursor ? ["--cursor", cursor] : [])], { budget });
    assert.ok(Buffer.byteLength(r.stdout) <= budget, `page within ${budget}`);
    assert.notEqual(j.status, "refused", JSON.stringify(j));
    out.push(j); cursor = j.next;
  } while (cursor);
  return out;
}
