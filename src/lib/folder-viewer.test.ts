import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileCount, fileKind, firstFile, sizeWords, sortFiles, withoutFrontMatter } from "./folder-viewer";

describe("the folder viewer's model", () => {
  test("markdown is rendered; scripts, JSON and anything else are shown as text", () => {
    assert.equal(fileKind("PLAYBOOK.md"), "markdown");
    assert.equal(fileKind("notes/Guide.MARKDOWN"), "markdown");
    for (const p of ["scripts/verdict.mjs", "run.sh", "config.json", "Makefile", "md"]) assert.equal(fileKind(p), "text", p);
  });

  test("a file holding a NUL byte is binary, whatever its name; the source's own word wins", () => {
    assert.equal(fileKind("x.md", "a\u0000b"), "binary");
    assert.equal(fileKind("x.md", "# fine", "too-large"), "too-large");
    assert.equal(fileKind("x.txt", "fine", "binary"), "binary");
    assert.equal(fileKind("x.md", "# fine", "markdown"), "markdown");
  });

  test("reading order: a folder's own files first, the playbook or readme leading, then by name", () => {
    const got = sortFiles([{ path: "scripts/verdict.mjs" }, { path: "references/checklist.md" }, { path: "zeta.md" }, { path: "PLAYBOOK.md" }, { path: "alpha.md" }]).map((f) => f.path);
    assert.deepEqual(got, ["PLAYBOOK.md", "alpha.md", "zeta.md", "references/checklist.md", "scripts/verdict.mjs"]);
  });

  test("it opens on the first group's first file; an empty first group passes to the next; none at all is null", () => {
    assert.deepEqual(firstFile([{ group: "a", files: [] }, { group: "b", files: [{ path: "z.md" }, { path: "README.md" }] }]), { group: "b", path: "README.md" });
    assert.equal(firstFile([{ group: "a", files: [] }]), null);
    assert.equal(firstFile([]), null);
  });

  test("front matter goes only from the very start, and only when it closes", () => {
    assert.equal(withoutFrontMatter("---\ntitle: A\nmore: b\n---\n\n# Body\n"), "# Body\n");
    assert.equal(withoutFrontMatter("---\r\ntitle: A\r\n---\r\n# Body"), "# Body", "CRLF");
    assert.equal(withoutFrontMatter("---\n---\n# Body"), "# Body", "an empty block");
    assert.equal(withoutFrontMatter("---\ntitle: A\n---"), "", "nothing after it");
    assert.equal(withoutFrontMatter("---\na: 1\n---\nb\n---\nc"), "b\n---\nc", "the first closing line ends it");
    for (const same of ["---\ntitle: A\nno close\n", "\n---\na: 1\n---\nb", "# Top\n\n---\na\n---\n", "----\na\n---\n", "---\na\n----\nb", ""])
      assert.equal(withoutFrontMatter(same), same);
  });

  test("counts and sizes read as words", () => {
    assert.equal(fileCount(1), "1 file");
    assert.equal(fileCount(3), "3 files");
    assert.equal(sizeWords(undefined), null);
    assert.equal(sizeWords(512), "512 B");
    assert.equal(sizeWords(2150), "2.1 KB");
  });
  test("keepOrder opens on the first item as listed, not the first in reading order", () => {
    const lists = [{ group: "g", files: [{ path: "tools/bash" }, { path: "README.md" }] }];
    assert.deepEqual(firstFile(lists), { group: "g", path: "README.md" });
    assert.deepEqual(firstFile(lists, true), { group: "g", path: "tools/bash" });
  });
});
