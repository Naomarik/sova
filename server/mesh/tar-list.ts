// A tar header reader (§mesh.links/transfer, the receiver's pre-scan): the members' names and types
// of a ustar, pax or GNU archive, data skipped, never written anywhere. Concatenated archives read as
// one, as `tar --ignore-zeros` extracts them: zero blocks between them are skipped. It is for checking
// what an extraction would touch, not for extracting.

export type TarMemberType = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarMember {
  name: string;
  type: TarMemberType;
  /** The target of a symlink or a hard link. */
  linkname?: string;
  size: number;
}

const BLOCK = 512;

/** Reads exact byte counts from a chunk stream, skipping without copying. */
class Blocks {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(private readonly it: AsyncIterator<Buffer | Uint8Array | string>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(r.value)]) : Buffer.from(r.value);
    }
    return this.buf.length >= n;
  }

  /** The next `n` bytes, null at a clean end (nothing left); throws on a partial read. */
  async read(n: number): Promise<Buffer | null> {
    if (!(await this.fill(n))) {
      if (!this.buf.length) return null;
      throw new Error(`truncated archive: ${this.buf.length} of ${n} bytes`);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async skip(n: number): Promise<void> {
    while (n > 0) {
      if (!this.buf.length && !(await this.fill(1))) throw new Error("truncated archive: data cut short");
      const k = Math.min(n, this.buf.length);
      this.buf = this.buf.subarray(k);
      n -= k;
    }
  }
}

const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

function cstr(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString("utf8");
}

/** An octal field, or GNU base-256 (the high bit of the first byte set) for a large size. */
function num(b: Buffer, off: number, len: number): number {
  const f = b.subarray(off, off + len);
  if (f[0]! & 0x80) {
    let v = f[0]! & 0x7f;
    for (let i = 1; i < f.length; i++) v = v * 256 + f[i]!;
    return v;
  }
  const s = f.toString("latin1").replace(/\0.*$/s, "").trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`bad numeric field "${s}"`);
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  try {
    return num(h, 148, 8) === sum;
  } catch {
    return false;
  }
}

/** pax extended header records: "<len> <key>=<value>\n". */
function paxRecords(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < b.length) {
    const sp = b.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(b.subarray(i, sp).toString("latin1"), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > b.length) throw new Error("bad pax record");
    const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

function typeOf(flag: string): TarMemberType {
  if (flag === "0" || flag === "\0" || flag === "7") return "file";
  if (flag === "5") return "dir";
  if (flag === "2") return "symlink";
  if (flag === "1") return "hardlink";
  return "other";
}

/**
 * Every member of the archive `src` yields (decompressed bytes), in order. Throws on a bad header
 * checksum or a truncated archive.
 */
export async function* tarMembers(src: AsyncIterable<Buffer | Uint8Array | string>): AsyncGenerator<TarMember> {
  const r = new Blocks(src[Symbol.asyncIterator]());
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (;;) {
    const h = await r.read(BLOCK);
    if (!h) return;
    if (h.every((x) => x === 0)) continue; // end-of-archive blocks, or between concatenated archives
    if (!checksumOk(h)) throw new Error("not a tar header (checksum mismatch)");
    const flag = String.fromCharCode(h[156]!);
    const size = num(h, 124, 12);
    if (flag === "L" || flag === "K" || flag === "x") {
      const body = await r.read(padded(size));
      if (!body) throw new Error("truncated archive: extended header cut short");
      const data = body.subarray(0, size);
      if (flag === "L") longName = cstr(data, 0, data.length);
      else if (flag === "K") longLink = cstr(data, 0, data.length);
      else pax = { ...pax, ...paxRecords(data) };
      continue;
    }
    if (flag === "g") {
      await r.skip(padded(size)); // global pax header: nothing here names a member
      continue;
    }
    const magic = h.subarray(257, 263).toString("latin1");
    const prefix = magic.startsWith("ustar") && magic !== "ustar " ? cstr(h, 345, 155) : "";
    const base = cstr(h, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    const link = pax.linkpath ?? longLink ?? cstr(h, 157, 100);
    const realSize = pax.size !== undefined ? Number(pax.size) : size;
    const type = typeOf(flag);
    longName = longLink = undefined;
    pax = {};
    yield { name, type, ...(type === "symlink" || type === "hardlink" ? { linkname: link } : {}), size: realSize };
    // Links, directories and devices carry no data whatever the size field says (GNU writes 0).
    if (type === "file" || type === "other") await r.skip(padded(realSize));
  }
}
