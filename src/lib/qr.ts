/** Local QR Model 2 encoder, ISO/IEC 18004: byte mode, ECC M, versions 1–40.
 * Original implementation; no runtime dependencies. The caller supplies the quiet zone.
 * UTF-8 bytes without ECI (pairing URLs are ASCII). */
const ECC = [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28];
const BLOCKS = [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49];
export interface QrOptions { version?: number; mask?: number }
export interface QrResult { matrix: boolean[][]; version: number; mask: number }

// Symbol capacity: function patterns remove modules from the data region.
function rawModules(v: number): number {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const align = Math.floor(v / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}
function capacity(v: number): number { return Math.floor(rawModules(v) / 8) - ECC[v - 1]! * BLOCKS[v - 1]!; }

// Reed–Solomon over GF(256), primitive polynomial x^8+x^4+x^3+x^2+1.
function multiply(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result;
}
function parity(data: number[], degree: number): number[] {
  const generator = Array<number>(degree).fill(0);
  generator[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      generator[j] = multiply(generator[j]!, root) ^ (generator[j + 1] ?? 0);
    }
    root = multiply(root, 2);
  }
  const remainder = Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < degree; i++) remainder[i] = remainder[i]! ^ multiply(generator[i]!, factor);
  }
  return remainder;
}
function codewords(bytes: Uint8Array, v: number): number[] {
  // Byte indicator, character count, data, terminator, zero alignment, alternating pads.
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  const size = capacity(v);
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, size * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let pad = 0; data.length < size; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  // Short blocks precede long blocks; interleave data, then correction codewords.
  const count = BLOCKS[v - 1]!, degree = ECC[v - 1]!;
  const short = Math.floor(size / count), longCount = size % count;
  const blocks: number[][] = [], checks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const length = short + (i >= count - longCount ? 1 : 0);
    const block = data.slice(offset, offset + length);
    offset += length; blocks.push(block); checks.push(parity(block, degree));
  }
  const result: number[] = [];
  for (let i = 0; i <= short; i++) for (const block of blocks) if (i < block.length) result.push(block[i]!);
  for (let i = 0; i < degree; i++) for (const block of checks) result.push(block[i]!);
  return result;
}
const masks = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => (x * y) % 2 + (x * y) % 3 === 0,
  (x: number, y: number) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x: number, y: number) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];
function draw(v: number, words: number[], mask: number): boolean[][] {
  const size = v * 4 + 17;
  const matrix = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fixed = matrix.map(row => row.slice());
  const set = (x: number, y: number, dark: boolean) => {
    if (x >= 0 && y >= 0 && x < size && y < size) { matrix[y]![x] = dark; fixed[y]![x] = true; }
  };
  // Finder patterns + separators, timing patterns, alignment patterns.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, d !== 2 && d !== 4);
    }
  }
  if (v > 1) {
    const count = Math.floor(v / 7) + 2;
    const step = v === 32 ? 26 : Math.floor((v * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    const positions = [6];
    for (let p = size - 7; positions.length < count; p -= step) positions.splice(1, 0, p);
    for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
      if ((i === 0 && (j === 0 || j === count - 1)) || (i === count - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        set(positions[i]! + dx, positions[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // BCH format information (M=00), XOR format mask, and version information.
  let remainder = mask;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const format = ((mask << 10) | remainder) ^ 0x5412;
  const bit = (n: number) => ((format >>> n) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const version = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3, b = Math.floor(i / 3), dark = ((version >>> i) & 1) !== 0;
      set(a, b, dark); set(b, a, dark);
    }
  }
  // Two-column zigzag placement; mask only data and remainder modules.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let row = 0; row < size; row++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - row : row;
      for (let col = 0; col < 2; col++) {
        const x = right - col;
        if (fixed[y]![x]) continue;
        const dark = index < words.length * 8 && ((words[index >>> 3]! >>> (7 - (index & 7))) & 1) !== 0;
        matrix[y]![x] = dark !== masks[mask]!(x, y); index++;
      }
    }
  }
  return matrix;
}

/** Mask evaluation: N1 runs, N2 blocks, N3 finder-like sequences, N4 dark balance. */
export function qrPenalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0, dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (matrix[y]![x]) dark++;
    if (x && y && matrix[y]![x] === matrix[y - 1]![x] && matrix[y]![x] === matrix[y]![x - 1] && matrix[y]![x] === matrix[y - 1]![x - 1]) score += 3;
  }
  for (let axis = 0; axis < 2; axis++) for (let i = 0; i < size; i++) {
    const row = axis ? matrix.map(r => r[i]!) : matrix[i]!;
    let run = 1;
    for (let j = 1; j <= size; j++) {
      if (j < size && row[j] === row[j - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    for (let j = 0; j <= size - 11; j++) {
      const pattern = row.slice(j, j + 11).map(b => b ? "1" : "0").join("");
      if (pattern === "10111010000" || pattern === "00001011101") score += 40;
    }
  }
  return score + Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
}

export function encodeQr(text: string, options: QrOptions = {}): QrResult {
  const bytes = new TextEncoder().encode(text);
  if (options.version !== undefined && (!Number.isInteger(options.version) || options.version < 1 || options.version > 40)) throw new RangeError("QR version must be 1–40");
  if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) throw new RangeError("QR mask must be 0–7");
  let version = options.version ?? 1;
  while (4 + (version < 10 ? 8 : 16) + bytes.length * 8 > capacity(version) * 8) {
    if (options.version !== undefined || version === 40) throw new RangeError("Payload is too long for this QR version");
    version++;
  }
  const words = codewords(bytes, version);
  let mask = options.mask ?? 0;
  let matrix = draw(version, words, mask);
  if (options.mask === undefined) {
    let best = qrPenalty(matrix);
    for (let candidate = 1; candidate < 8; candidate++) {
      const next = draw(version, words, candidate), penalty = qrPenalty(next);
      if (penalty < best) { best = penalty; matrix = next; mask = candidate; }
    }
  }
  return { matrix, version, mask };
}
export function qrMatrix(text: string, options?: QrOptions): boolean[][] { return encodeQr(text, options).matrix; }
