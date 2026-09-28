import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutSequence, stepsOf, type SequenceLayout } from "./layout";
import { parseSequence } from "./parse";

const OAUTH = `actor u "User"
actor b "Browser"
actor app "App server"
actor idp "Identity provider"
u -> b "click Sign in"
b -> app "GET /login"
app --> b "302 to /authorize"
b -> idp "GET /authorize"
idp -> idp "check session"
idp --> b "302 back with code"
== back channel ==
app -> idp "POST /token (code + secret)"
idp --> app "access + id token"
note app "store session, set cookie"
app --> b "302 home, Set-Cookie"`;

const inBounds = (l: SequenceLayout) => {
  for (const a of l.actors) assert.ok(a.x - a.w / 2 >= 0 && a.x + a.w / 2 <= l.width, `actor ${a.id} inside`);
  for (const r of l.rows) if (r.type !== "divider") assert.ok(r.box.x >= 0 && r.box.x + r.box.w <= l.width + 0.5, `${r.type} box inside: ${JSON.stringify(r.box)} of ${l.width}`);
};

test("steps are messages: a divider goes with the next message, a note with the one before", () => {
  const s = parseSequence('== open ==\na -> b "1"\nnote a "after 1"\n== next ==\nb --> a "2"\nnote b "after 2"\n== end ==');
  assert.deepEqual(stepsOf(s), { stepOf: [0, 0, 0, 1, 1, 1, 1], steps: 2 });
  assert.deepEqual(stepsOf(parseSequence('note a b "only notes"')), { stepOf: [0], steps: 1 });
});

test("rows go down in order and nothing leaves the drawing", () => {
  const l = layoutSequence(parseSequence(OAUTH));
  const ys = l.rows.map((r) => r.box.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i]! > ys[i - 1]!, `row ${i} below row ${i - 1}`);
  for (let i = 1; i < l.rows.length; i++) assert.ok(l.rows[i]!.box.y >= l.rows[i - 1]!.box.y + l.rows[i - 1]!.box.h - 0.5, `row ${i} clears row ${i - 1}`);
  assert.ok(l.lifelineEnd <= l.height);
  inBounds(l);
});

test("a narrower pane wraps tighter: never wider, and in bounds", () => {
  const spec = parseSequence(OAUTH);
  const wide = layoutSequence(spec);
  let prev = wide.width;
  for (const fit of [600, 480, 400, 300]) {
    const l = layoutSequence(spec, undefined, fit);
    assert.ok(l.width <= prev, `fit ${fit}: ${l.width} <= ${prev}`);
    inBounds(l);
    prev = l.width;
  }
  assert.ok(prev < wide.width * 0.8, `${prev} well under ${wide.width}`);
  assert.deepEqual(layoutSequence(spec, undefined, 400), layoutSequence(spec, undefined, 400), "deterministic");
});

test("the last actor's self-message loops left, inside the drawing", () => {
  const l = layoutSequence(parseSequence('a -> b "go"\nb -> b "a long thought about it"'));
  const self = l.rows[1]!;
  assert.ok(self.type === "msg" && self.self && self.left);
  const b = l.actors[1]!;
  assert.ok(self.box.x + self.box.w <= b.x + b.w / 2 + 12, "no margin grown right of the last actor");
  inBounds(l);
  const first = layoutSequence(parseSequence('a -> a "think"\na -> b "go"')).rows[0]!;
  assert.ok(first.type === "msg" && !first.left, "any other actor's loops right");
});
