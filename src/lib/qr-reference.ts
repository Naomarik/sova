// Test support for qr.test.ts and qr.integration.test.ts: the cases checked against Python's
// qrcode package, the reference run itself, and the committed results (qr-reference.json).
// Regenerate the file (python3 with qrcode installed): bun src/lib/qr-reference.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeQr } from "./qr";

const PYTHON = `
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

export const PAYLOADS = [
  "https://example.test/",
  `https://pairing-example.ts.net:8443/#c=${"aB2_-".repeat(8)}xyz`,
  `https://example.test/${"long-path/".repeat(45)}#c=${"a".repeat(43)}`,
  "https://example.test/é/手机",
  "",
];

export interface QrCase { text: string; version: number; mask: number }

/** Every mask of each payload at its chosen version, then every version once. */
export function referenceCases(): QrCase[] {
  const cases: QrCase[] = [];
  for (const text of PAYLOADS) {
    const chosen = encodeQr(text);
    for (let mask = 0; mask < 8; mask++) cases.push({ text, version: chosen.version, mask });
  }
  // Cover every alignment arrangement, RS block split, and version-information layout.
  for (let version = 1; version <= 40; version++) cases.push({ text: "x", version, mask: version % 8 });
  return cases;
}

export function runPython(cases: QrCase[]): { matrix: boolean[][]; penalty: number }[] {
  const result = spawnSync("python3", ["-c", PYTHON], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error("python3 and qrcode are required, not an optional skipped check", { cause: result.error });
  if (result.status !== 0) throw new Error(`python3 exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** One line per row of 0/1 modules, hashed: equal digests are equal matrices. */
export const matrixDigest = (matrix: boolean[][]) =>
  createHash("sha256").update(matrix.map(row => row.map(Number).join("")).join("\n")).digest("hex");

export interface QrReference extends QrCase { size: number; digest: string; penalty: number }

const FILE = join(import.meta.dirname, "qr-reference.json");

export const readReference = (): QrReference[] => JSON.parse(readFileSync(FILE, "utf8"));

if (import.meta.main) {
  const cases = referenceCases();
  const out: QrReference[] = runPython(cases).map((r, i) => ({ ...cases[i]!, size: r.matrix.length, digest: matrixDigest(r.matrix), penalty: r.penalty }));
  writeFileSync(FILE, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${out.length} reference matrices to ${FILE}`);
}
