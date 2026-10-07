import test from "node:test";
import assert from "node:assert/strict";
import { encodeQr, qrMatrix, qrPenalty } from "./qr";
import { matrixDigest, PAYLOADS, readReference, referenceCases } from "./qr-reference";

// The reference is Python's qrcode, recorded in qr-reference.json (bun src/lib/qr-reference.ts);
// qr.integration.test.ts runs Python itself.
test("Python qrcode reference: exact byte-mode modules and independent mask penalties", () => {
  const cases = referenceCases();
  const expected = readReference();
  assert.deepEqual(expected.map(({ text, version, mask }) => ({ text, version, mask })), cases, "the recorded cases are today's cases");
  cases.forEach((c, i) => {
    const matrix = qrMatrix(c.text, c);
    const reference = expected[i]!;
    assert.equal(matrix.length, reference.size);
    assert.equal(matrixDigest(matrix), reference.digest, `version ${c.version}, mask ${c.mask}: every module matches Python`);
    assert.equal(qrPenalty(matrix), reference.penalty, `version ${c.version}, mask ${c.mask}: independent penalty`);
  });
  PAYLOADS.forEach((text, i) => {
    const chosen = encodeQr(text);
    const penalties = expected.slice(i * 8, i * 8 + 8).map(r => r.penalty);
    assert.equal(chosen.mask, penalties.indexOf(Math.min(...penalties)), "auto mask has minimum independent penalty; ties take first");
    if (chosen.version > 1) assert.throws(() => encodeQr(text, { version: chosen.version - 1 }), RangeError, "auto version is smallest that fits");
  });
  assert.ok(encodeQr(PAYLOADS[2]!).version >= 10, "long link crosses the byte-count and version-information boundaries");
});

test("QR rejects oversized payloads and invalid overrides", () => {
  assert.throws(() => qrMatrix("x".repeat(2400)), RangeError);
  for (const version of [0, 41, 1.5, NaN]) assert.throws(() => qrMatrix("x", { version }), RangeError);
  for (const mask of [-1, 8, 0.5, NaN]) assert.throws(() => qrMatrix("x", { mask }), RangeError);
  const matrix = qrMatrix("x");
  assert.equal(matrix.length, 21, "no quiet zone: caller supplies it");
  assert.ok(matrix.every(row => row.length === 21 && row.every(cell => typeof cell === "boolean")));
});
