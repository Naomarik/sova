// A strict JSON reader that remembers where every value is. JSON.parse keeps the last of two equal
// keys without a word and reports errors by offset; a hand-edited story needs both caught, with a
// line and column. Zero dependencies.
//
//   parseWithPositions(text) -> { value, pos: Map<pointer, { line, col, keyLine?, keyCol? }> }
//   throws JsonPosError { line, col, pointer, message } on a syntax error or a duplicate key.

export class JsonPosError extends Error {
  constructor(message, line, col, pointer = "") {
    super(message);
    this.line = line;
    this.col = col;
    this.pointer = pointer;
  }
}

/** RFC 6901: "/" and "~" escaped in each segment. */
export const pointerOf = (parts) => parts.map((p) => "/" + String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("");

export function parseWithPositions(text) {
  const pos = new Map();
  let i = 0;
  let line = 1;
  let col = 1;

  const fail = (message, path = []) => {
    throw new JsonPosError(message, line, col, pointerOf(path));
  };
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (text[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) advance();
  };
  const describe = (ch) => (ch === undefined ? "end of file" : JSON.stringify(ch));

  function str(path) {
    if (text[i] !== '"') fail(`expected a string, found ${describe(text[i])}`, path);
    advance();
    let out = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined) fail("unterminated string", path);
      if (ch === '"') {
        advance();
        return out;
      }
      if (ch === "\n" || ch < " ") fail("a line break or control character inside a string; split long text into an array of lines", path);
      if (ch === "\\") {
        const e = text[i + 1];
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e in map) {
          out += map[e];
          advance(2);
        } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          advance(6);
        } else fail(`bad escape \\${e ?? ""}`, path);
        continue;
      }
      out += ch;
      advance();
    }
  }

  function value(path) {
    ws();
    const at = { line, col };
    const ch = text[i];
    let v;
    if (ch === "{") v = object(path);
    else if (ch === "[") v = array(path);
    else if (ch === '"') v = str(path);
    else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
      if (!m) fail(`bad number`, path);
      v = Number(m[0]);
      advance(m[0].length);
    } else if (text.startsWith("true", i)) {
      v = true;
      advance(4);
    } else if (text.startsWith("false", i)) {
      v = false;
      advance(5);
    } else if (text.startsWith("null", i)) {
      v = null;
      advance(4);
    } else if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) fail('comments are not JSON; use a "note" key instead', path);
    else fail(`expected a value, found ${describe(ch)}`, path);
    const p = pointerOf(path);
    pos.set(p, { ...(pos.get(p) ?? {}), line: at.line, col: at.col });
    return v;
  }

  function object(path) {
    advance(); // {
    const out = {};
    const seen = new Map();
    ws();
    if (text[i] === "}") {
      advance();
      return out;
    }
    for (;;) {
      ws();
      if (text[i] === "}") fail("trailing comma before }", path);
      const keyAt = { line, col };
      if (text[i] !== "\"") fail(`expected a "key" in double quotes, found ${describe(text[i])}`, path);
      const key = str(path);
      if (seen.has(key)) {
        line = keyAt.line;
        col = keyAt.col;
        const first = seen.get(key);
        fail(`duplicate key "${key}" (first at line ${first.line}:${first.col}); JSON.parse would silently keep only this one`, [...path, key]);
      }
      seen.set(key, keyAt);
      ws();
      if (text[i] !== ":") fail(`expected ":" after "${key}", found ${describe(text[i])}`, [...path, key]);
      advance();
      out[key] = value([...path, key]);
      const p = pointerOf([...path, key]);
      pos.set(p, { ...pos.get(p), keyLine: keyAt.line, keyCol: keyAt.col });
      ws();
      if (text[i] === ",") {
        advance();
        continue;
      }
      if (text[i] === "}") {
        advance();
        return out;
      }
      fail(`expected "," or "}" after the value of "${key}", found ${describe(text[i])}`, [...path, key]);
    }
  }

  function array(path) {
    advance(); // [
    const out = [];
    ws();
    if (text[i] === "]") {
      advance();
      return out;
    }
    for (;;) {
      ws();
      if (text[i] === "]") fail("trailing comma before ]", path);
      out.push(value([...path, out.length]));
      ws();
      if (text[i] === ",") {
        advance();
        continue;
      }
      if (text[i] === "]") {
        advance();
        return out;
      }
      fail(`expected "," or "]" in the array, found ${describe(text[i])}`, path);
    }
  }

  if (text.charCodeAt(0) === 0xfeff) advance();
  const v = value([]);
  ws();
  if (i < text.length) fail(`unexpected ${describe(text[i])} after the top-level value`);
  return { value: v, pos };
}
