import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPRESS_WORK_KEY, compressWork, parseCompressWork, readCompressWork, readStoredCompressWork, setCompressWork, writeCompressWork } from "./work-compression";
import { rowEstimate } from "./tail-render";

const values = new Map<string, string>();
const storage = {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
} as Storage;

test("compression defaults on; only exactly false selects cards", () => {
  for (const raw of [null, "", "true", "0", "1", "False", " false ", "null", "{}", "garbage"]) {
    assert.equal(parseCompressWork(raw), true, String(raw));
  }
  assert.equal(parseCompressWork("false"), false);
  values.clear();
  assert.equal(readCompressWork(storage), true);
  writeCompressWork(storage, false);
  assert.equal(values.get(COMPRESS_WORK_KEY), "false");
  assert.equal(readCompressWork(storage), false);
  writeCompressWork(storage, true);
  assert.equal(values.get(COMPRESS_WORK_KEY), "true");
  assert.equal(readCompressWork(storage), true);
});

test("compression survives unavailable, blocked and full storage with a live in-memory choice", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    assert.equal(readStoredCompressWork(), true);
    setCompressWork(false);
    assert.equal(compressWork(), false);
    const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } } as unknown as Storage;
    assert.equal(readCompressWork(blocked), true);
    assert.doesNotThrow(() => writeCompressWork(blocked, false));
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: blocked });
    setCompressWork(true);
    assert.equal(compressWork(), true);
    setCompressWork(false);
    assert.equal(compressWork(), false);
    Reflect.deleteProperty(globalThis, "localStorage");
    assert.equal(readStoredCompressWork(), true);
    assert.doesNotThrow(() => setCompressWork(true));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("compression changes the shared signal and stores both choices immediately", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    values.clear();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    setCompressWork(false);
    assert.equal(compressWork(), false);
    assert.equal(readStoredCompressWork(), false);
    setCompressWork(true);
    assert.equal(compressWork(), true);
    assert.equal(readStoredCompressWork(), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("cards retain master estimates; timeline heads and folds reserve measured heights", () => {
  for (const kind of ["thinking", "tool-call", "tool-result"]) {
    const item = { kind };
    const master = kind === "thinking" ? "calc(36px)" : "calc(46px)";
    assert.equal(rowEstimate(item, undefined, "tool", false, false), master);
    assert.equal(rowEstimate(item, undefined, "tool", false, true), master);
    assert.equal(rowEstimate(item, undefined, "tool", true, false), "calc(32px)");
    assert.equal(rowEstimate(item, undefined, "tool", true, false, true), "calc(76px)");
    assert.equal(rowEstimate(item, undefined, "tool", true, true), "calc(44px)");
    assert.equal(rowEstimate(item, undefined, "tool", true, true, true), "calc(44px)");
    assert.equal(rowEstimate(item, undefined, "tool", false, true, true), master);
    const images = ["data:image/png;base64,AA=="];
    assert.equal(rowEstimate(item, images, "tool", true, true, true), "calc(44px)");
    assert.equal(rowEstimate(item, images, "tool", false, true), rowEstimate(item, images, "tool"));
  }
  for (const kind of ["assistant-text", "user", "info", "report", "worktree-merge", "unknown"]) {
    const item = { kind, text: "unchanged" };
    assert.equal(rowEstimate(item, undefined, "user", true, true), rowEstimate(item));
  }
});
