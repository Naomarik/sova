import assert from "node:assert/strict";
import { test } from "node:test";
import { HtmlArgDecoder, pageInReply, ReplyPageDecoder, withoutPages } from "./stream-decode";

const PAGES = ['<a href="x">\n\t\\é😀</a>', "", "\b\f\r/", "\\u0041 not an escape", '""\\"'];

/** Every way of cutting `s` in two, and the chunks of one character each. */
function cuts(s: string): string[][] {
  const out: string[][] = [[s], [...s].flatMap((c) => c.split(""))];
  for (let i = 1; i < s.length; i++) out.push([s.slice(0, i), s.slice(i)]);
  return out;
}

test("the html argument decodes the same however the JSON is cut, whatever comes around it", () => {
  for (const html of PAGES) {
    for (const [wrap, name] of [
      [(j: string) => `{"label":"A","html":${j}}`, "after"],
      [(j: string) => `{"html":${j},"label":"A"}`, "before"],
      [(j: string) => `{"n":12,"notes":{"html":"nope","k":[1,"}"]},"html":${j},"t":true}`, "nest"],
      [(j: string) => `{ "label" : "A" , "html" : ${j} }`, "spaces"],
    ] as const) {
      const json = wrap(JSON.stringify(html));
      for (const chunks of cuts(json)) {
        const d = new HtmlArgDecoder();
        assert.equal(chunks.map((c) => d.feed(c)).join(""), html, `${name}: ${JSON.stringify(chunks.slice(0, 2))}`);
      }
    }
  }
});

test("\\uXXXX escapes decode, a surrogate pair included, however the JSON is cut", () => {
  // JSON.stringify leaves these raw: this is the ASCII-escaped form a provider really sends.
  const json = String.raw`{"label":"A","html":"a\u2014\ud83d\ude00z"}`;
  for (const chunks of cuts(json)) {
    const d = new HtmlArgDecoder();
    assert.equal(chunks.map((c) => d.feed(c)).join(""), "a\u2014\u{1F600}z", JSON.stringify(chunks.slice(0, 2)));
  }
});

test("a tool argument with no html field decodes to nothing", () => {
  const d = new HtmlArgDecoder();
  assert.equal(d.feed('{"label":"A","note":{"layout":"x","html":"not this"}}'), "");
});

test("a part added to the end (`append`) decodes like a page, and the decoder says which it was, however it is cut", () => {
  const json = `{"label":"A","append":${JSON.stringify('<section class="x">\n  <p>"more"</p>\n</section>')}}`;
  for (const chunks of cuts(json)) {
    const d = new HtmlArgDecoder();
    assert.equal(chunks.map((c) => d.feed(c)).join(""), '<section class="x">\n  <p>"more"</p>\n</section>');
    assert.equal(d.field, "append");
  }
  const page = new HtmlArgDecoder();
  page.feed('{"label":"A","html":"<p>');
  assert.equal(page.field, "html");
});

test("edits decode to nothing, and only the first page argument is decoded", () => {
  const edits = new HtmlArgDecoder();
  assert.equal(edits.feed('{"label":"A","edits":[{"find":"<p>a</p>","replace":"<p>b</p>"}]}'), "");
  assert.equal(edits.field, null);
  const both = new HtmlArgDecoder();
  assert.equal(both.feed('{"append":"one","html":"two"}'), "one");
  assert.equal(both.field, "append");
});

test("a page between marker lines is what the reply decoder gives, however the reply is cut", () => {
  const O = "<<<design-page>>>";
  const C = "<<<end-design-page>>>";
  const page = "<!doctype html>\n<p>a <<<design-page>>> inline stays</p>\n<p>b</p>";
  for (const nl of ["\n", "\r\n"]) {
    const reply = `A plan I should not have written.${nl}${O}${nl}${page.replaceAll("\n", nl)}${nl}${C}${nl}and after`;
    const want = page.replaceAll("\n", nl);
    for (const chunks of cuts(reply)) {
      const d = new ReplyPageDecoder(O, C);
      assert.equal(chunks.map((c) => d.feed(c)).join(""), want, JSON.stringify(chunks.slice(0, 2)));
    }
    assert.equal(pageInReply(reply, O, C), want);
    assert.equal(withoutPages(reply, O, C, "[page]"), `A plan I should not have written.[page]and after`);
  }
  assert.equal(pageInReply(`${O}\nno end`, O, C), null);
  assert.equal(new ReplyPageDecoder(O, C).feed("no markers at all"), "");
});
