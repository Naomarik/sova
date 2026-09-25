// Run: npx tsx --test src/lib/models.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../shared/protocol";
import { loadModels, modelByRef, toggleFavorite, withFavorite } from "./models";

const model = (ref: string, favorite = false): ModelInfo => ({
  ref,
  provider: ref.slice(0, ref.indexOf("/")),
  id: ref.slice(ref.indexOf("/") + 1),
  favorite,
  thinkingLevels: ["off"],
});
const seed = (list: ModelInfo[]) => loadModels(async () => list);
/** A PUT the test settles by hand, so the in-flight window can be observed. */
function deferredPut() {
  const calls: { ref: string; favorite: boolean; resolve(): void; reject(e: Error): void }[] = [];
  const put = (ref: string, favorite: boolean) =>
    new Promise<void>((resolve, reject) => calls.push({ ref, favorite, resolve, reject }));
  return { put, calls };
}
const fav = (ref: string) => modelByRef(ref)?.favorite;

test("withFavorite flips one ref, and returns the same list when nothing changes", () => {
  const list = [model("a/x"), model("b/y", true)];
  const next = withFavorite(list, "a/x", true);
  assert.equal(next[0]!.favorite, true);
  assert.equal(next[1], list[1], "untouched rows keep identity");
  assert.equal(withFavorite(list, "b/y", true), list);
  assert.equal(withFavorite(list, "zz/unknown", true), list);
});

test("a toggle flips the shared cache before the server answers, and keeps it on success", async () => {
  await seed([model("a/x"), model("b/y")]);
  const { put, calls } = deferredPut();
  const done = toggleFavorite("a/x", true, put);
  assert.equal(fav("a/x"), true, "optimistic");
  assert.deepEqual(calls.map((c) => [c.ref, c.favorite]), [["a/x", true]]);
  calls[0]!.resolve();
  await done;
  assert.equal(fav("a/x"), true);
});

test("a failed toggle rolls back and rejects with the server's error", async () => {
  await seed([model("a/x", true)]);
  const { put, calls } = deferredPut();
  const done = toggleFavorite("a/x", false, put);
  assert.equal(fav("a/x"), false);
  calls[0]!.reject(new Error("Favorites are locked; retry."));
  await assert.rejects(done, /locked/);
  assert.equal(fav("a/x"), true);
});

test("a refresh that lands mid-toggle doesn't undo it", async () => {
  await seed([model("a/x")]);
  const { put, calls } = deferredPut();
  const done = toggleFavorite("a/x", true, put);
  await seed([model("a/x"), model("c/z")]); // read from disk before the write landed
  assert.equal(fav("a/x"), true);
  calls[0]!.resolve();
  await done;
  await seed([model("a/x")]); // nothing in flight: the server's value stands again
  assert.equal(fav("a/x"), false);
});

test("only the latest toggle of a ref decides; its failure rolls back to the last confirmed value", async () => {
  await seed([model("a/x")]);
  const { put, calls } = deferredPut();
  const first = toggleFavorite("a/x", true, put);
  const second = toggleFavorite("a/x", false, put);
  assert.equal(fav("a/x"), false);
  calls[0]!.reject(new Error("first failed"));
  await assert.rejects(first);
  assert.equal(fav("a/x"), false, "a superseded failure leaves the cache alone");
  calls[1]!.reject(new Error("second failed"));
  await assert.rejects(second);
  assert.equal(fav("a/x"), false, "back to what the server last had: not a favorite");

  const third = toggleFavorite("a/x", true, put);
  const fourth = toggleFavorite("a/x", false, put);
  calls[2]!.resolve();
  await third;
  calls[3]!.reject(new Error("fourth failed"));
  await assert.rejects(fourth);
  assert.equal(fav("a/x"), true, "the third was confirmed, so that's the rollback target");
});

test("a peer's list, favorites and ladders are its own: this host's cache never answers for it", async () => {
  await seed([model("a/x")]);
  await loadModels(async () => [model("z/peer-only", true)], "laptop");
  assert.equal(modelByRef("z/peer-only"), null, "this host has no such model");
  assert.equal(modelByRef("a/x", "laptop"), null, "the peer doesn't either");
  assert.equal(modelByRef("z/peer-only", "laptop")?.favorite, true);
  const { put, calls } = deferredPut();
  const done = toggleFavorite("a/x", true, put, "laptop");
  assert.equal(fav("a/x"), false, "a toggle on the peer leaves this host's star alone");
  calls[0]!.resolve();
  await done;
});
