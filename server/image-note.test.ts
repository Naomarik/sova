// Run: npx tsx --test server/image-note.test.ts
// pi 0.87's image resize note is hidden wherever Sova shows a user message's text, and nowhere
// else. Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { formatDimensionNote } from "@earendil-works/pi-coding-agent";
import { stripImageNotes } from "../shared/image-note";

const agentDir = mkdtempSync(join(tmpdir(), "sova-image-note-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { normalizeEntry } = await import("./transcript");
const { rewindSession } = await import("./chat-manager");
const { editorFor } = await import("./fork");
const { getSessionSummary } = await import("./sessions-index");

// Verbatim text blocks of three user entries pi 0.87.1 wrote in a hermetic Sova session
// (ollama-cloud/glm-5.3, prompts sent over /ws/chat with 2560x1600 and 3000x1000 PNGs).
const ONE = "One red image attached. Reply with just OK.\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]";
const TWO =
  "Two images. Reply with just OK.\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]\n[Image: original 3000x1000, displayed at 2000x667. Multiply coordinates by 1.50 to map to original image.]";
const NOTE_ONLY = "\n\n[Image: original 3000x1000, displayed at 2000x667. Multiply coordinates by 1.50 to map to original image.]";

const image = { type: "image", data: "AAAA", mimeType: "image/png" };
const withImages = (text: string, n: number) => [{ type: "text", text }, ...Array.from({ length: n }, () => image)];
const userEntry = (id: string, content: unknown) => ({ type: "message", id, parentId: null, timestamp: "2026-09-24T00:00:00.000Z", message: { role: "user", content, timestamp: 0 } });

describe("stripImageNotes", () => {
  test("the fixtures are what pi's own formatter writes, joined as prompt() joins them", () => {
    const note = (ow: number, oh: number, w: number, h: number) =>
      formatDimensionNote({ data: "", mimeType: "image/png", originalWidth: ow, originalHeight: oh, width: w, height: h, wasResized: true });
    assert.equal(ONE, `One red image attached. Reply with just OK.\n\n${note(2560, 1600, 2000, 1250)}`);
    assert.equal(TWO, `Two images. Reply with just OK.\n\n${[note(2560, 1600, 2000, 1250), note(3000, 1000, 2000, 667)].join("\n")}`);
    assert.equal(NOTE_ONLY, `\n\n${note(3000, 1000, 2000, 667)}`);
  });

  test("removes one note per resized image and leaves the typed text exactly", () => {
    assert.equal(stripImageNotes(ONE, withImages(ONE, 1)), "One red image attached. Reply with just OK.");
    assert.equal(stripImageNotes(TWO, withImages(TWO, 2)), "Two images. Reply with just OK.");
    assert.equal(stripImageNotes(NOTE_ONLY, withImages(NOTE_ONLY, 1)), "");
    // Typed text that itself ends in a newline keeps it: the note block starts at the LAST blank line.
    const typed = "line one\n\nline two\n";
    const stored = `${typed}\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]`;
    assert.equal(stripImageNotes(stored, withImages(stored, 1)), typed);
  });

  test("keeps pi's other hints, removing only the dimension notes", () => {
    const stored = "look\n\n[Image converted from image/bmp to image/png.]\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]\n[Image omitted: could not be resized below the inline image size limit.]";
    assert.equal(
      stripImageNotes(stored, withImages(stored, 1)),
      "look\n\n[Image converted from image/bmp to image/png.]\n[Image omitted: could not be resized below the inline image size limit.]",
    );
  });

  test("a typed look-alike is kept whenever the message could not have produced it", () => {
    // No images at all.
    assert.equal(stripImageNotes(ONE, [{ type: "text", text: ONE }]), ONE);
    assert.equal(stripImageNotes(ONE, ONE), ONE);
    // More notes than images.
    assert.equal(stripImageNotes(TWO, withImages(TWO, 1)), TWO);
    // A scale that does not match its own dimensions (2560/2000 is 1.28, not 1.30).
    const wrongScale = "hi\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.30 to map to original image.]";
    assert.equal(stripImageNotes(wrongScale, withImages(wrongScale, 1)), wrongScale);
    // Not the whole last block: typed text follows the note, or shares its line.
    const followed = `${ONE}\nand then I typed more`;
    assert.equal(stripImageNotes(followed, withImages(followed, 1)), followed);
    const sameLine = "hi\n\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.] thanks";
    assert.equal(stripImageNotes(sameLine, withImages(sameLine, 1)), sameLine);
    // No blank line before it.
    const noGap = "hi\n[Image: original 2560x1600, displayed at 2000x1250. Multiply coordinates by 1.28 to map to original image.]";
    assert.equal(stripImageNotes(noGap, withImages(noGap, 1)), noGap);
    // Not prompt()'s shape: an image before the text, or a second text block.
    assert.equal(stripImageNotes(ONE, [image, { type: "text", text: ONE }]), ONE);
    assert.equal(stripImageNotes(ONE, [{ type: "text", text: ONE }, { type: "text", text: "x" }, image]), ONE);
  });
});

describe("where Sova shows a user message's text", () => {
  test("the transcript row shows the typed text; the entry the row carries is untouched", () => {
    const entry = userEntry("u1", withImages(TWO, 2));
    const [row] = normalizeEntry(entry);
    assert.equal(row?.kind, "user");
    assert.equal(row?.text, "Two images. Reply with just OK.");
    assert.equal(row?.images?.length, 2);
    assert.equal((row?.raw as any).message.content[0].text, TWO, "the stored text, as the model got it, is unchanged");
  });

  test("a note-only message renders as an image-only row", () => {
    const [row] = normalizeEntry(userEntry("u1", withImages(NOTE_ONLY, 1)));
    assert.equal(row?.kind, "user");
    assert.equal(row?.text, "");
    assert.equal(row?.images?.length, 1);
  });

  test("a look-alike in an assistant reply or in an image-less user message is shown as written", () => {
    const [user] = normalizeEntry(userEntry("u1", [{ type: "text", text: ONE }]));
    assert.equal(user?.text, ONE);
    const assistant = {
      type: "message",
      id: "a1",
      parentId: null,
      message: { role: "assistant", content: [{ type: "text", text: ONE }, image], provider: "p", model: "m", stopReason: "stop" },
    };
    assert.equal(normalizeEntry(assistant)[0]?.text, ONE);
  });

  test("rewind hands the composer the typed text", async () => {
    for (const [text, n, expected] of [[ONE, 1, "One red image attached. Reply with just OK."], [NOTE_ONLY, 1, ""], [ONE, 0, ONE]] as const) {
      const target = userEntry("u1", n ? withImages(text, n) : [{ type: "text", text }]);
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionManager: { getBranch: () => [target], getLeafId: () => "u1", appendCustomEntry: () => "m1" } as any,
        // pi's navigateTree returns the target's text blocks as stored (contentText(content, "")).
        navigateTree: async () => ({ cancelled: false, editorText: text }),
      };
      const out = await rewindSession(session, "u1", { guard() {}, beforeMarker() {}, queued: () => false });
      assert.deepEqual(out, { ok: true, editorText: expected });
    }
  });

  test("a fork's composer gets the typed text beside the images", () => {
    assert.equal(editorFor(userEntry("u1", withImages(ONE, 1)))?.text, "One red image attached. Reply with just OK.");
    const noteOnly = editorFor(userEntry("u1", withImages(NOTE_ONLY, 1)));
    assert.equal(noteOnly?.text, undefined, "no text to put back, only the image");
    assert.equal(noteOnly?.images?.length, 1);
  });

  test("the session title is the typed text", async () => {
    const dir = join(agentDir, "sessions", "--tmp-image-note--");
    mkdirSync(dir, { recursive: true });
    const id = "01a0d4ba-9a5a-7088-94f8-0d7da880e63b";
    const path = join(dir, `2026-09-24T18-43-14-139Z_${id}.jsonl`);
    const header = { type: "session", version: 3, id, timestamp: "2026-09-24T18:43:14.139Z", cwd: "/tmp/image-note" };
    writeFileSync(path, `${[header, userEntry("u1", withImages(ONE, 1))].map((e) => JSON.stringify(e)).join("\n")}\n`);
    assert.equal((await getSessionSummary(path))?.title, "One red image attached. Reply with just OK.");
  });
});
