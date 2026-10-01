import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { encodeQr, qrMatrix, qrPenalty } from "./qr";

const python = `
import json, sys, qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE, lost_point
results = []
for case in json.load(sys.stdin):
    qr = qrcode.QRCode(version=case['version'], error_correction=qrcode.constants.ERROR_CORRECT_M, mask_pattern=case['mask'], border=0)
    qr.add_data(QRData(case['text'].encode('utf-8'), mode=MODE_8BIT_BYTE))
    qr.make(fit=False)
    matrix = qr.get_matrix()
    results.append({'matrix': matrix, 'penalty': lost_point(matrix)})
json.dump(results, sys.stdout)
`;

test("Python qrcode cross-check: exact byte-mode modules and independent mask penalties", () => {
  const payloads = [
    "https://example.test/",
    `https://pairing-example.ts.net:8443/#c=${"aB2_-".repeat(8)}xyz`,
    `https://example.test/${"long-path/".repeat(45)}#c=${"a".repeat(43)}`,
    "https://example.test/é/手机",
    "",
  ];
  const cases: { text: string; version: number; mask: number }[] = [];
  for (const text of payloads) {
    const chosen = encodeQr(text);
    for (let mask = 0; mask < 8; mask++) cases.push({ text, version: chosen.version, mask });
  }
  // Cover every alignment arrangement, RS block split, and version-information layout.
  for (let version = 1; version <= 40; version++) cases.push({ text: "x", version, mask: version % 8 });
  const result = spawnSync("python3", ["-c", python], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, "python3 and qrcode are required, not an optional skipped check");
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(result.stdout) as { matrix: boolean[][]; penalty: number }[];
  assert.equal(expected.length, cases.length);
  cases.forEach((c, i) => {
    const matrix = qrMatrix(c.text, c);
    const reference = expected[i]!;
    assert.equal(matrix.length, reference.matrix.length);
    matrix.forEach((row, y) => assert.equal(row.map(Number).join(""), reference.matrix[y]!.map(Number).join(""), `version ${c.version}, mask ${c.mask}, row ${y}: every module matches Python`));
    assert.equal(qrPenalty(matrix), reference.penalty, `version ${c.version}, mask ${c.mask}: independent penalty`);
  });
  payloads.forEach((text, i) => {
    const chosen = encodeQr(text);
    const penalties = expected.slice(i * 8, i * 8 + 8).map(r => r.penalty);
    assert.equal(chosen.mask, penalties.indexOf(Math.min(...penalties)), "auto mask has minimum independent penalty; ties take first");
    if (chosen.version > 1) assert.throws(() => encodeQr(text, { version: chosen.version - 1 }), RangeError, "auto version is smallest that fits");
  });
  assert.ok(encodeQr(payloads[2]!).version >= 10, "long link crosses the byte-count and version-information boundaries");
  console.log(`Python qrcode cross-check passed: ${cases.length} exact matrices, all 40 versions; automatic masks match independent minimum penalties.`);
});

test("QR rejects oversized payloads and invalid overrides", () => {
  assert.throws(() => qrMatrix("x".repeat(2400)), RangeError);
  for (const version of [0, 41, 1.5, NaN]) assert.throws(() => qrMatrix("x", { version }), RangeError);
  for (const mask of [-1, 8, 0.5, NaN]) assert.throws(() => qrMatrix("x", { mask }), RangeError);
  const matrix = qrMatrix("x");
  assert.equal(matrix.length, 21, "no quiet zone: caller supplies it");
  assert.ok(matrix.every(row => row.length === 21 && row.every(cell => typeof cell === "boolean")));
});
