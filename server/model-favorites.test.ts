// Uses a throwaway favorites file in the OS temp dir; ~/.pi is never read or written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelRef, readFavorites, setFavorite } from "./model-favorites";
import { ModelFavorites } from "../pi-config/extensions/command-palette/favorites.ts";

const dir = mkdtempSync(join(tmpdir(), "sova-favorites-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `f${++n}`, "model-favorites.json");
const onDisk = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("parseModelRef splits at the first slash, and refuses an empty half", () => {
  assert.deepEqual(parseModelRef("openrouter/meta/llama-5"), { provider: "openrouter", id: "meta/llama-5" });
  for (const bad of ["", "gpt-5", "/gpt-5", "openai/"]) assert.equal(parseModelRef(bad), null, bad);
});

test("a star is written in the palette's format, and read back by both the listing and the palette", () => {
  const path = fresh(); // its folder doesn't exist yet: the first star creates it
  const r = setFavorite({ ref: "zai/glm-5.3", favorite: true }, path);
  assert.deepEqual(r, { status: 200, body: { ref: "zai/glm-5.3", favorite: true } });
  assert.deepEqual(onDisk(path), { version: 1, models: [{ provider: "zai", id: "glm-5.3" }] });
  assert.equal(readFavorites(path)("zai", "glm-5.3"), true);
  assert.equal(readFavorites(path)("other", "glm-5.3"), false, "a favorite is a provider/id PAIR");
  assert.equal(new ModelFavorites(path).has({ provider: "zai", id: "glm-5.3" }), true);

  assert.equal(setFavorite({ ref: "zai/glm-5.3", favorite: false }, path).status, 200);
  assert.deepEqual(onDisk(path), { version: 1, models: [] });
  assert.equal(readFavorites(path)("zai", "glm-5.3"), false);
});

test("a write keeps favorites another writer saved after this server last read", () => {
  const path = fresh();
  const listing = readFavorites(path); // read before the palette writes
  new ModelFavorites(path).set({ provider: "anthropic", id: "claude-opus-5" }, true);
  assert.equal(listing("anthropic", "claude-opus-5"), false);
  setFavorite({ ref: "openai/gpt-5", favorite: true }, path);
  assert.deepEqual(onDisk(path).models, [
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "openai", id: "gpt-5" },
  ]);
});

test("bad bodies and refs are 400s and write nothing", () => {
  const path = fresh();
  for (const body of [null, "x", {}, { ref: "a/b" }, { ref: "a/b", favorite: "yes" }, { ref: 3, favorite: true }]) {
    assert.equal(setFavorite(body, path).status, 400, JSON.stringify(body));
  }
  const r = setFavorite({ ref: "no-slash", favorite: true }, path);
  assert.equal(r.status, 400);
  assert.match((r.body as { error: string }).error, /no-slash/);
  assert.equal(existsSync(path), false);
});

test("the palette's lock is a 409 with its message, and the file is untouched", () => {
  const path = fresh();
  setFavorite({ ref: "zai/glm-5.3", favorite: true }, path);
  const before = readFileSync(path, "utf8");
  mkdirSync(`${path}.lock`);
  try {
    const r = setFavorite({ ref: "openai/gpt-5", favorite: true }, path);
    assert.equal(r.status, 409);
    assert.match((r.body as { error: string }).error, /^Favorites are locked; retry/);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmdirSync(`${path}.lock`);
  }
});

test("a malformed file lists no favorites, and a write reports it instead of overwriting it", () => {
  for (const bad of ["{not json", JSON.stringify({ version: 2, models: [] }), JSON.stringify({ version: 1, models: [{ provider: "a" }] })]) {
    const path = fresh();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bad);
    assert.equal(readFavorites(path)("a", "b"), false);
    const r = setFavorite({ ref: "a/b", favorite: true }, path);
    assert.equal(r.status, 500, bad);
    assert.match((r.body as { error: string }).error, /^Invalid model favorites file: /);
    assert.equal(readFileSync(path, "utf8"), bad, "left exactly as it was");
    assert.equal(existsSync(`${path}.lock`), false);
  }
});
