// Run: pnpm test -- src/lib/form-kit.test.ts
// The form kit: shared/form-rules.ts (one check, one sentence, for the form and the server) and the
// fields in src/components/form/ (rendered with Solid's SSR build, src/lib/align-card-ssr.mjs): a box
// keeps exactly what was typed, a value its rule refuses is red (aria-invalid) with one sentence
// under it that the box names (aria-describedby), and limited text shows "n / most".
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check, firstIssue, problemOf, type Rule } from "../../shared/form-rules";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const { renderToString } = await import("solid-js/web");
const kit = await importSsr(new URL("../components/form/index.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const whole: Rule = { kind: "whole", label: "Running at once", min: 0, max: 1000 };
const text: Rule = { kind: "text", label: "Label", min: 1, max: 5, trim: true };

describe("rules", () => {
  test("a whole number: typed or stored, in range; anything half-typed is refused in one sentence", () => {
    assert.deepEqual(check(whole, "12"), { ok: true, value: 12 });
    assert.deepEqual(check(whole, " 1000 "), { ok: true, value: 1000 });
    assert.deepEqual(check(whole, 0), { ok: true, value: 0 });
    for (const raw of ["", " ", "-", "1e", "1.", "2.5", "-3", "a5", "1001", 1.5, Number.NaN, null, undefined])
      assert.deepEqual(check(whole, raw), { ok: false, message: "Running at once must be a whole number from 0 to 1,000." }, String(raw));
    assert.deepEqual(check({ ...whole, optional: true }, ""), { ok: true, value: null });
  });
  test("text: trimmed when the rule trims, blank and too long refused, a label override names one of many", () => {
    assert.deepEqual(check(text, " abcde "), { ok: true, value: "abcde" });
    assert.equal(problemOf(text, "  "), "Label can't be empty.");
    assert.equal(problemOf(text, "abcdef"), "Label can be at most 5 characters.");
    assert.equal(problemOf(text, "abcdef", "Quick action 2's label"), "Quick action 2's label can be at most 5 characters.");
    assert.equal(problemOf({ kind: "text", label: "Notes", max: 8000 }, "x".repeat(8001)), "Notes can be at most 8,000 characters.");
    assert.equal(problemOf({ ...text, empty: "This host needs a name." }, ""), "This host needs a name.");
    assert.equal(problemOf(text, 5), "Label must be text.");
  });
  test("custom", () => {
    assert.equal(problemOf({ kind: "custom", label: "Url", issue: (t) => (t.startsWith("https://") ? null : "Use https.") }, " http://x "), "Use https.");
  });
  test("the first issue in page order, a rule's or a form's own sentence", () => {
    assert.equal(firstIssue([{ rule: whole, value: "5" }, { message: null }]), null);
    assert.deepEqual(firstIssue([{ rule: whole, value: "5" }, { message: "Pick one.", at: 2 }, { rule: text, value: "", at: 3 }]), { message: "Pick one.", at: 2 });
    assert.deepEqual(firstIssue([{ rule: text, value: "", label: "Name", at: 1 }]), { message: "Name can't be empty.", at: 1 });
  });
});

const html = (f: () => unknown) => renderToString(f as never).replace(/ data-hk="[^"]*"/g, "");
const attr = (out: string, tag: string, name: string) => new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`).exec(out)?.[1];

describe("fields", () => {
  test("a number box keeps what was typed, is never type=number, and goes red with its sentence wired to it", () => {
    const out = html(() => kit.NumberField({ id: "n", label: "Running at once", rule: whole, value: "1e", onInput() {} }));
    assert.equal(attr(out, "input", "value"), "1e");
    assert.equal(attr(out, "input", "type"), "text");
    assert.equal(attr(out, "input", "inputmode"), "numeric");
    assert.equal(attr(out, "input", "aria-invalid"), "true");
    assert.equal(attr(out, "input", "aria-describedby"), "n-error");
    assert.match(out, /<span class="field-error" id="n-error">Running at once must be a whole number from 0 to 1,000\.<\/span>/);
    assert.match(out, /<label class="field-label" for="n">Running at once<\/label>/);
  });
  test("a valid value: no red, no sentence; the hint is wired", () => {
    const out = html(() => kit.NumberField({ id: "n", label: "L", hint: "Per message.", rule: whole, value: "7", onInput() {} }));
    assert.equal(attr(out, "input", "aria-invalid"), undefined);
    assert.equal(attr(out, "input", "aria-describedby"), "n-hint");
    assert.doesNotMatch(out, /field-error/);
  });
  test("limited text shows n / most, red past it; one sentence only, the form's own error wins", () => {
    const notes: Rule = { kind: "text", label: "Notes", max: 8000 };
    const ok = html(() => kit.TextArea({ id: "t", label: "Notes", hideLabel: true, rule: notes, value: "abc", onInput() {} }));
    assert.match(ok, /<span class="field-hint text-num" id="t-count">3 \/ 8,000<\/span>/);
    assert.match(ok, /<label class="visually-hidden" for="t">/);
    const over = html(() => kit.TextArea({ id: "t", label: "Notes", rule: notes, value: "x".repeat(8001), onInput() {} }));
    assert.match(over, /<span class="field-error text-num" id="t-count">8,001 \/ 8,000<\/span>/);
    assert.equal(attr(over, "textarea", "aria-describedby"), "t-error t-count");
    const own = html(() => kit.TextArea({ id: "t", label: "Notes", rule: notes, error: "Too long with the appended lines.", value: "x".repeat(8001), onInput() {} }));
    assert.equal((own.match(/class="field-error"/g) ?? []).length, 1);
    assert.match(own, /Too long with the appended lines\./);
  });
  test("select, toggle, choice and search draw the base classes", () => {
    const sel = html(() => kit.Select({ id: "s", label: "Thinking", value: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], onChange() {} }));
    assert.match(sel, /<div class="select-wrap"><select class="select ?" id="s"/);
    assert.match(sel, /<option value="b" selected/);
    const tog = html(() => kit.Toggle({ switch: true, label: "Resume", checked: true, hint: "Why.", onChange() {} }));
    assert.match(tog, /<label class="toggle toggle-switch"><span>Resume<\/span><input type="checkbox" checked/);
    const ch = html(() => kit.Choice({ label: "Proactivity", value: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B", hint: "Badge" }], onChange() {} }));
    assert.match(ch, /role="radiogroup" aria-label="Proactivity"/);
    assert.equal((ch.match(/checked/g) ?? []).length, 1);
    const search = html(() => kit.SearchField({ label: "Search sessions", value: "", onInput() {} }));
    assert.equal(attr(search, "input", "type"), "search");
    assert.match(search, /<div class="search"><input[^>]*><span class="icon"/);
    assert.match(html(() => kit.Toggle({ label: "Enable zai", title: "zai is off", checked: false, onChange() {} })), /<label class="toggle" title="zai is off">/);
  });
});
