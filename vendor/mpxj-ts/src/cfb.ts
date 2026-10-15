/**
 * A reader for OLE compound files ("structured storage", [MS-CFB]), the
 * container .mpp files use: a little file system of storages (folders) and
 * streams (files) inside one file, laid out in sectors chained by a FAT.
 * Written from the published specification; reading only.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END = 0xfffffffe;

export interface CfbEntry {
  name: string;
  /** 1 storage, 2 stream, 5 root. */
  type: number;
  start: number;
  size: number;
  children: Map<string, CfbEntry>;
}

export class Cfb {
  readonly root: CfbEntry;
  private sectorSize: number;
  private fat: Uint32Array;
  private miniFat: Uint32Array;
  private miniStream: Uint8Array;
  private cutoff: number;

  constructor(private buf: Uint8Array) {
    for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) throw new Error('not an OLE compound file');
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // [MS-CFB] allows only 512-byte (version 3) and 4096-byte (version 4) sectors, and a 4096-byte mini-stream cutoff.
    const shift = v.getUint16(0x1e, true);
    if (shift !== 9 && shift !== 12) throw new Error('the compound file has an invalid sector size');
    this.sectorSize = 1 << shift;
    this.cutoff = 4096;
    const sectorsInFile = Math.floor(buf.length / this.sectorSize);
    const inFile = (s: number) => this.offset(s) < buf.length;

    // The FAT's own sectors are listed in the header (109) and then in a chain of DIFAT sectors.
    const fatSectors: number[] = [];
    for (let i = 0; i < 109; i++) {
      const s = v.getUint32(0x4c + i * 4, true);
      if (s !== FREE && s !== END && inFile(s)) fatSectors.push(s);
    }
    let difat = v.getUint32(0x44, true);
    const perSector = this.sectorSize / 4;
    // A damaged file can loop its DIFAT chain or point past the end; stop at either, and once there are more FAT
    // sectors than the file has sectors.
    const seenDifat = new Set<number>();
    while (difat !== END && difat !== FREE && !seenDifat.has(difat) && fatSectors.length <= sectorsInFile) {
      seenDifat.add(difat);
      const off = this.offset(difat);
      if (off + this.sectorSize > buf.length) break;
      for (let i = 0; i < perSector - 1; i++) {
        const s = v.getUint32(off + i * 4, true);
        if (s !== FREE && s !== END && inFile(s)) fatSectors.push(s);
      }
      difat = v.getUint32(off + (perSector - 1) * 4, true);
    }
    if (fatSectors.length > sectorsInFile) fatSectors.length = sectorsInFile;
    this.fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((s, i) => {
      const off = this.offset(s);
      for (let k = 0; k < perSector && off + k * 4 + 4 <= buf.length; k++) this.fat[i * perSector + k] = v.getUint32(off + k * 4, true);
    });

    const dir = this.chain(v.getUint32(0x30, true));
    const entries: (CfbEntry & { left: number; right: number; child: number })[] = [];
    for (let p = 0; p + 128 <= dir.length; p += 128) {
      const ev = new DataView(dir.buffer, dir.byteOffset + p, 128);
      const nameLen = Math.min(64, ev.getUint16(64, true));
      let name = '';
      for (let i = 0; i + 2 < nameLen; i += 2) name += String.fromCharCode(ev.getUint16(i, true));
      entries.push({ name, type: ev.getUint8(66), left: ev.getInt32(68, true), right: ev.getInt32(72, true), child: ev.getInt32(76, true), start: ev.getUint32(116, true), size: ev.getUint32(120, true), children: new Map() });
    }
    const root = entries[0];
    if (!root || root.type !== 5) throw new Error('the compound file has no root entry');
    // Children of a storage are a red-black tree hanging off its child pointer.
    const seen = new Set<number>();
    const attach = (parent: CfbEntry, id: number) => {
      if (id < 0 || id >= entries.length || seen.has(id)) return;
      seen.add(id);
      const e = entries[id];
      parent.children.set(e.name, e);
      attach(parent, e.left);
      attach(parent, e.right);
      if (e.type === 1) attach(e, e.child);
    };
    attach(root, root.child);
    this.root = root;

    this.miniStream = this.chain(root.start, Math.min(root.size, buf.length));
    const miniFatBytes = this.chain(v.getUint32(0x3c, true));
    this.miniFat = new Uint32Array(miniFatBytes.length / 4);
    const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mv.getUint32(i * 4, true);
  }

  private offset(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  /** The bytes of a FAT chain, cut to `size` when given. */
  private chain(start: number, size = -1): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let s = start; s !== END && s !== FREE && s < this.fat.length && !seen.has(s); s = this.fat[s]) {
      seen.add(s);
      const off = this.offset(s);
      if (off >= this.buf.length) break;
      const part = this.buf.subarray(off, Math.min(off + this.sectorSize, this.buf.length));
      parts.push(part);
      total += part.length;
      if (size >= 0 && total >= size) break;
    }
    return join(parts, size >= 0 ? size : total);
  }

  private miniChain(start: number, size: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let s = start; s !== END && s !== FREE && s < this.miniFat.length && !seen.has(s) && total < size; s = this.miniFat[s]) {
      seen.add(s);
      if (s * 64 >= this.miniStream.length) break;
      const part = this.miniStream.subarray(s * 64, s * 64 + 64);
      parts.push(part);
      total += part.length;
    }
    return join(parts, size);
  }

  /** An entry by path, e.g. get('   114', 'TBkndTask', 'FixedData'). */
  get(...path: string[]): CfbEntry | undefined {
    let e: CfbEntry | undefined = this.root;
    for (const name of path) e = e?.children.get(name);
    return e;
  }

  read(e: CfbEntry): Uint8Array {
    if (e.type !== 2) throw new Error(`${e.name} is not a stream`);
    return e.size < this.cutoff ? this.miniChain(e.start, e.size) : this.chain(e.start, e.size);
  }

  /** A stream by path, or null when it is not there. */
  stream(...path: string[]): Uint8Array | null {
    const e = this.get(...path);
    return e && e.type === 2 ? this.read(e) : null;
  }
}

/** The parts end to end, cut to `size`; never longer than the parts themselves, whatever size a damaged file states. */
function join(parts: Uint8Array[], size: number): Uint8Array {
  const available = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(Math.max(0, Math.min(size, available)));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const n = Math.min(p.length, out.length - at);
    out.set(p.subarray(0, n), at);
    at += n;
  }
  return out;
}
