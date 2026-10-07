import test from "node:test";
import assert from "node:assert/strict";
import { encodeQr, qrMatrix, qrPenalty } from "./qr";
import { matrixDigest, PAYLOADS, readReference, referenceCases, runPython } from "./qr-reference";

// Runs Python's qrcode itself (python3 with qrcode is required); qr.test.ts checks the same cases
// against the recorded qr-reference.json, which this test also holds to Python's answer.
test("Python qrcode cross-check: exact byte-mode modules and independent mask penalties", () => {
  const cases = referenceCases();
  const expected = runPython(cases);
  assert.equal(expected.length, cases.length);
  cases.forEach((c, i) => {
    const matrix = qrMatrix(c.text, c);
    const reference = expected[i]!;
    assert.equal(matrix.length, reference.matrix.length);
    matrix.forEach((row, y) => assert.equal(row.map(Number).join(""), reference.matrix[y]!.map(Number).join(""), `version ${c.version}, mask ${c.mask}, row ${y}: every module matches Python`));
    assert.equal(qrPenalty(matrix), reference.penalty, `version ${c.version}, mask ${c.mask}: independent penalty`);
  });
  PAYLOADS.forEach((text, i) => {
    const chosen = encodeQr(text);
    const penalties = expected.slice(i * 8, i * 8 + 8).map(r => r.penalty);
    assert.equal(chosen.mask, penalties.indexOf(Math.min(...penalties)), "auto mask has minimum independent penalty; ties take first");
    if (chosen.version > 1) assert.throws(() => encodeQr(text, { version: chosen.version - 1 }), RangeError, "auto version is smallest that fits");
  });
  assert.ok(encodeQr(PAYLOADS[2]!).version >= 10, "long link crosses the byte-count and version-information boundaries");
  assert.deepEqual(readReference().map(r => [r.digest, r.penalty]), expected.map(r => [matrixDigest(r.matrix), r.penalty]), "qr-reference.json still records Python's answer");
});
