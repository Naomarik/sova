import assert from "node:assert/strict";
import { test } from "node:test";
import { extFrameSrc, extHref, extRouteFromHash } from "./ext-route";

test("extRouteFromHash reads #/ext/<id>, with or without a trailing slash", () => {
  assert.equal(extRouteFromHash("#/ext/dataico"), "dataico");
  assert.equal(extRouteFromHash("#/ext/my.ext_2-b/"), "my.ext_2-b");
});

test("extRouteFromHash refuses other routes, deeper paths and ids the manifest can't hold", () => {
  for (const hash of ["", "#/", "#/ext", "#/ext/", "#/ext/a/b", "#/s/%2Ftmp%2Fx.jsonl", "#/g/ext", "#/extra/a",
    "#/ext/..", "#/ext/.", "#/ext/a%2Fb", "#/ext/a b", "#ext/a"]) {
    assert.equal(extRouteFromHash(hash), null, hash);
  }
});

test("extHref and extFrameSrc round-trip through the route", () => {
  for (const id of ["dataico", "a.b", "x_y-z"]) {
    assert.equal(extRouteFromHash(extHref(id)), id);
    assert.equal(extFrameSrc(id), `/ext/${id}/`);
  }
});
