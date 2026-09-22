import assert from "node:assert/strict";
import { test } from "node:test";
import { fileFromDataUrl, stageFork, stagePlan, stripPaths, type StageDeps } from "./fork-stage";
import type { TmpAttachment, UploadResult } from "../../shared/protocol";

const att = (path: string, available = true): TmpAttachment => ({ path, name: path.split("/").pop()!, mimeType: "image/png", available });
const dataUrl = (payload: string) => `data:image/png;base64,${btoa(payload)}`;
const SOURCE_DIR = "/home/x/.pi/agent/pi-web/attachments/SOURCE-SESSION";
const CHILD = "/home/x/.pi/agent/sessions/--x--/child.jsonl";

/** A fake world: paths resolve to their own bytes, uploads land in the child's folder. */
function world(over: Partial<StageDeps> & { contents?: Record<string, string> } = {}) {
  const uploaded: { name: string; into: string; bytes: string }[] = [];
  /** What actually reached the target's draft — the thing the source-protecting invariant is about. */
  const draft: { text: string; files: UploadResult[] } = { text: "", files: [] };
  const contents = over.contents ?? {};
  const deps: StageDeps = {
    setText: over.setText ?? ((_t, text) => void (draft.text = text)),
    setAttachments: over.setAttachments ?? ((_t, files) => void draft.files.push(...files)),
    read: over.read ?? (async (path) => (contents[path] === undefined ? null : new File([contents[path]!], path.split("/").pop()!, { type: "image/png" }))),
    upload:
      over.upload ??
      (async (file, into) => {
        const bytes = await file.text();
        uploaded.push({ name: file.name, into, bytes });
        return { path: `/home/x/.pi/agent/pi-web/attachments/CHILD-SESSION/pi-web-${uploaded.length}.png`, name: file.name, mimeType: "image/png", size: bytes.length } as UploadResult;
      }),
  };
  return { deps, uploaded, draft };
}

// The bytes a fork hands back for an image whose file is gone. Getting this wrong is not a
// cosmetic failure: the image is counted as carried and the sentence then says it came along.
test("a base64 data URL becomes a file with its own bytes and type", async () => {
  const png = "iVBORw0KGgo=";
  const file = fileFromDataUrl(`data:image/png;base64,${png}`, "forked-1.png");
  assert.ok(file);
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "forked-1.png");
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
});

test("anything that isn't a data URL is refused rather than uploaded as junk", () => {
  assert.equal(fileFromDataUrl("/tmp/pi-clipboard-1.png", "x.png"), null);
  assert.equal(fileFromDataUrl("https://example.com/a.png", "x.png"), null);
  assert.equal(fileFromDataUrl("", "x.png"), null);
  // Malformed base64: the caller counts this as an image that couldn't come, never as one that did.
  assert.equal(fileFromDataUrl("data:image/png;base64,!!!!", "x.png"), null);
});

test("the plan takes BOTH channels, and only counts what it cannot read", () => {
  const plan = stagePlan({ attachments: [att("/tmp/a.png"), att("/tmp/gone.png", false)], images: [dataUrl("x")] });
  assert.deepEqual(plan.paths.map((p) => p.name), ["a.png"]);
  assert.equal(plan.bytes.length, 1);
  assert.equal(plan.lost, 1);
});

test("an editor with nothing in it plans nothing and loses nothing", () => {
  assert.deepEqual(stagePlan(undefined), { paths: [], bytes: [], lost: 0 });
  assert.deepEqual(stagePlan({ text: "just words" }), { paths: [], bytes: [], lost: 0 });
});

// ---- The rule that protects the SOURCE session --------------------------------------------------

test("a forked image is COPIED into the child: the draft never names the source's file", async () => {
  // The danger this pins: a chip's Remove deletes by path, and the server allows deleting anything
  // under the attachments root. A draft holding the SOURCE's path would let the fork's composer
  // delete the picture out of the message it was forked from.
  const source = `${SOURCE_DIR}/pi-web-original.png`;
  const staged: UploadResult[] = [];
  const { deps, uploaded, draft } = world({ contents: { [source]: "PNGBYTES" } });
  const stage = await stageFork(CHILD, { text: `look at this\n${source}`, attachments: [att(source)] }, {
    ...deps,
    async upload(file, into) {
      const up = await deps.upload(file, into);
      staged.push(up);
      return up;
    },
  });
  assert.equal(stage.carried, 1);
  assert.equal(stage.lost, 0);
  assert.equal(uploaded.length, 1, "the source file was read and re-uploaded");
  assert.equal(uploaded[0]!.into, CHILD, "into the CHILD's own folder");
  assert.equal(uploaded[0]!.bytes, "PNGBYTES", "with the source's content");
  // The decisive assertions: nothing staged is the source's path, and nothing staged lives in the
  // source's folder — so no chip in the child can delete a file the source still references.
  for (const up of staged) {
    assert.notEqual(up.path, source);
    assert.ok(!up.path.startsWith(SOURCE_DIR), `staged path must not live in the source's folder: ${up.path}`);
  }
});

test("the draft's text is rewritten to the copy, so what it names is what the child owns", async () => {
  const source = `${SOURCE_DIR}/pi-web-original.png`;
  let drafted = "";
  const { deps, draft } = world({ contents: { [source]: "PNGBYTES" } });
  const stage = await stageFork(CHILD, { text: `see ${source} please`, attachments: [att(source)] }, deps);
  assert.equal(stage.text, true);
  drafted = draft.text;
  // The decisive one: the TEXT handed to the composer names the child's copy and not the source.
  assert.ok(drafted.includes("CHILD-SESSION"), `the text should name the copy: ${drafted}`);
  assert.ok(!drafted.includes(source), `the text still names the source file: ${drafted}`);
});

test("an image that cannot be copied is counted, and its dead name leaves the text", async () => {
  const gone = `${SOURCE_DIR}/pi-web-gone.png`;
  const { deps, uploaded } = world({ contents: {} }); // every read returns null
  const stage = await stageFork(CHILD, { text: `here it is\n${gone}`, attachments: [att(gone)] }, deps);
  assert.equal(stage.carried, 0);
  assert.equal(stage.lost, 1, "counted, never silently dropped");
  assert.equal(uploaded.length, 0, "and nothing was staged for it");
});

test("a failed upload leaves the source untouched and counts the image as not carried", async () => {
  const source = `${SOURCE_DIR}/pi-web-big.png`;
  const { deps } = world({ contents: { [source]: "HUGE" } });
  const stage = await stageFork(CHILD, { text: "x", attachments: [att(source)] }, {
    ...deps,
    upload: async () => {
      throw new Error("Image exceeds the 20MB limit");
    },
  });
  assert.equal(stage.carried, 0);
  assert.equal(stage.lost, 1);
});

// ---- Duplicates are proved, never assumed -------------------------------------------------------

test("bytes identical to a copied file are dropped as the duplicate they are", async () => {
  const source = `${SOURCE_DIR}/pi-web-same.png`;
  const { deps, uploaded } = world({ contents: { [source]: "SAME" } });
  const stage = await stageFork(CHILD, { text: "x", attachments: [att(source)], images: [dataUrl("SAME")] }, deps);
  assert.equal(uploaded.length, 1, "one picture, one copy");
  assert.equal(stage.carried, 1);
  assert.equal(stage.lost, 0, "a proven duplicate is not a loss");
});

test("bytes that are a DIFFERENT picture come along instead of vanishing", async () => {
  // The old rule suppressed these silently and counted nothing, so the sentence claimed a clean
  // fork while a picture was missing.
  const source = `${SOURCE_DIR}/pi-web-one.png`;
  const { deps, uploaded } = world({ contents: { [source]: "ONE" } });
  const stage = await stageFork(CHILD, { text: "x", attachments: [att(source)], images: [dataUrl("TWO")] }, deps);
  assert.equal(uploaded.length, 2);
  assert.equal(stage.carried, 2);
  assert.equal(stage.lost, 0);
});

test("THE INVARIANT: no staged path is any path the SOURCE transcript names", async () => {
  // Stated the way the danger is: a chip's Remove deletes by path, so if anything the fork stages
  // is a path the source's own rows still reference, removing that chip destroys the source's
  // picture. Asserted against the whole set the source names, not just the one being forked.
  const sourceTranscriptPaths = [
    `${SOURCE_DIR}/pi-web-forked.png`,
    `${SOURCE_DIR}/pi-web-elsewhere.png`,
    "/tmp/pi-clipboard-older.png",
  ];
  const forked = sourceTranscriptPaths[0]!;
  const { deps, draft } = world({ contents: { [forked]: "PNGBYTES" } });
  await stageFork(CHILD, { text: `look\n${forked}`, attachments: [att(forked)], images: [dataUrl("OTHER")] }, deps);
  // Asserted on what reached the DRAFT, not on what was uploaded: a version that uploaded a copy
  // and then staged the source's path anyway would pass the upload-side check and still destroy
  // the source's picture when the chip is removed.
  assert.equal(draft.files.length, 2, "the file and the unrelated bytes both came, as copies");
  for (const f of draft.files) assert.ok(!sourceTranscriptPaths.includes(f.path), `staged ${f.path} is a path the source names`);
  assert.ok(!draft.text.includes(forked), "and the text names none of them either");
});

test("the same picture through BOTH channels is staged once — a future pi that inlines a pasted image can't double it", async () => {
  // Today the two channels are disjoint (the TUI's paste inserts a path and stores no
  // ImageContent). This does not RELY on that: identity is proved from the copied content, so a
  // pi that starts sending both for one picture still yields one copy rather than two chips.
  const source = `${SOURCE_DIR}/pi-web-pasted.png`;
  const { deps, uploaded } = world({ contents: { [source]: "PASTED" } });
  const stage = await stageFork(CHILD, { text: "x", attachments: [att(source)], images: [dataUrl("PASTED")] }, deps);
  assert.equal(uploaded.length, 1);
  assert.equal(stage.carried, 1);
});

test("a path the USER typed stays in the forked text, even when its file is gone", async () => {
  // The server strips only GENERATED names (pi-clipboard-…, pi-web-…) because `attachments` stands
  // in for them. A path someone typed themselves is part of their sentence, and a fork must not
  // quietly edit it out while tidying up its own references.
  const typed = "/tmp/holiday-photo.png";
  const generated = `${SOURCE_DIR}/pi-web-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
  const { deps, draft } = world({ contents: {} }); // neither file can be read
  const stage = await stageFork(
    CHILD,
    { text: `see ${typed} and ${generated}`, attachments: [att(typed, false), att(generated, false)] },
    deps,
  );
  assert.equal(stage.carried, 0);
  assert.equal(stage.lost, 2, "both are counted as not carried");
  assert.ok(draft.text.includes(typed), `the user's own path must survive: ${draft.text}`);
  assert.ok(!draft.text.includes(generated), `the generated reference must go: ${draft.text}`);
});

// ---- The forked message is the user's text, byte-for-byte ----------------------------------------

/** A message with everything whitespace-sensitive in it: fenced code, indentation, tabs, aligned
    columns, a trailing-space line break, and blank lines. */
const CODE_MESSAGE = [
  "Here's the failing bit:",
  "",
  "```ts",
  "function f() {",
  "    if (x) {",
  "\t\treturn {",
  "\t\t\ta:  1,",
  "\t\t\tbb: 22,",
  "\t\t};",
  "    }",
  "}",
  "```",
  "",
  "Note the two  spaces above, and this line ends with two spaces  ",
  "    indented continuation",
].join("\n");

test("a fork with NO attachments hands back the message byte-for-byte", async () => {
  // The regression this pins: a blanket `replace(/[ \t]{2,}/g," ").trimEnd()` + `.trim()` used to
  // run on EVERY forked message, dedenting code and collapsing deliberate spacing even when there
  // was nothing to rewrite.
  const { deps, draft } = world();
  const stage = await stageFork(CHILD, { text: CODE_MESSAGE }, deps);
  assert.equal(stage.text, true);
  assert.equal(draft.text, CODE_MESSAGE, "the message must be unchanged, character for character");
});

test("a fork that REPLACES a source path changes only that substring", async () => {
  const source = `${SOURCE_DIR}/pi-web-shot.png`;
  const text = `${CODE_MESSAGE}\n\nscreenshot: ${source}`;
  const { deps, draft } = world({ contents: { [source]: "PNGBYTES" } });
  const stage = await stageFork(CHILD, { text, attachments: [att(source)] }, deps);
  assert.equal(stage.carried, 1);
  const copy = draft.files[0]!.path;
  assert.equal(draft.text, `${CODE_MESSAGE}\n\nscreenshot: ${copy}`, "only the path is swapped");
  // And the code block survives intact inside it.
  assert.ok(draft.text.includes("\t\t\tbb: 22,"), "tabs and alignment preserved");
  assert.ok(draft.text.includes("    if (x) {"), "indentation preserved");
});

test("stripPaths removes the reference and nothing else", () => {
  const p = "/tmp/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
  // Mid-sentence: the path and the space that introduced it go; the rest is untouched.
  assert.equal(stripPaths(`look at this ${p} closely`, [p]), "look at this closely");
  // A line that was ONLY the path is dropped, not left blank.
  assert.equal(stripPaths(`before\n${p}\nafter`, [p]), "before\nafter");
  // Everything whitespace-sensitive around it survives.
  assert.equal(stripPaths(`${CODE_MESSAGE}\n${p}`, [p]), CODE_MESSAGE);
  // A path that isn't there changes nothing at all.
  assert.equal(stripPaths(CODE_MESSAGE, ["/tmp/pi-clipboard-not-here.png"]), CODE_MESSAGE);
  assert.equal(stripPaths(CODE_MESSAGE, []), CODE_MESSAGE);
});

test("a message that was ONLY a dead reference stages no text", async () => {
  const gone = `${SOURCE_DIR}/pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png`;
  const { deps, draft } = world({ contents: {} });
  const stage = await stageFork(CHILD, { text: gone, attachments: [att(gone, false)] }, deps);
  assert.equal(stage.text, false, "nothing left to put in the composer");
  assert.equal(draft.text, "");
  assert.equal(stage.lost, 1, "and the image is still counted");
});
