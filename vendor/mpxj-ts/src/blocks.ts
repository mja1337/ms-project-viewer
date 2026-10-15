/**
 * The storage blocks inside an .mpp file, ported from MPXJ (LGPL-2.1):
 * Props14 (keyed properties), FixedMeta/FixedData (one fixed-size record per
 * task or resource, located by a meta table) and VarMeta12/Var2Data
 * (variable-length values by unique ID and field key).
 */

import { f64, i32, timestamp, u16, u8, unicode } from './bytes';

const MAGIC = 0xfadfadba | 0;

/** Keyed property blocks: a 16-byte header, then [size, key, -] + data entries. */
export class Props {
  readonly map = new Map<number, Uint8Array>();

  constructor(data: Uint8Array | null) {
    if (!data || data.length < 16) return;
    const count = u16(data, 12);
    let p = 16;
    for (let found = 0; found < count; found++) {
      if (data.length - p < 12) break;
      const size = i32(data, p);
      const key = i32(data, p + 4);
      p += 12;
      if (size < 1 || data.length - p < size) break;
      this.map.set(key, data.subarray(p, p + size));
      p += size;
      if (size % 2) p++; // two-byte alignment
    }
  }

  bytes(key: number): Uint8Array | null {
    return this.map.get(key) ?? null;
  }

  byte(key: number): number {
    const d = this.map.get(key);
    return d ? u8(d, 0) : 0;
  }

  short(key: number): number {
    const d = this.map.get(key);
    return d ? u16(d, 0) : 0;
  }

  int(key: number): number {
    const d = this.map.get(key);
    return d ? i32(d, 0) : 0;
  }

  double(key: number): number {
    const d = this.map.get(key);
    return d ? f64(d, 0) : 0;
  }

  bool(key: number): boolean {
    const d = this.map.get(key);
    return !!d && u16(d, 0) !== 0;
  }

  timestamp(key: number): number | null {
    const d = this.map.get(key);
    return d ? timestamp(d, 0) : null;
  }

  string(key: number): string {
    return unicode(this.map.get(key) ?? null, 0);
  }
}

export class FixedMeta {
  readonly itemCount: number;
  readonly items: Uint8Array[] = [];

  /** `sizes`: one item size, or candidates chosen to agree with another block's count (as MPXJ does for Fixed2Meta). */
  constructor(data: Uint8Array | null, sizes: number[], other?: FixedData) {
    if (!data || data.length < 16) {
      this.itemCount = 0;
      return;
    }
    if (i32(data, 0) !== MAGIC) throw new Error('bad FixedMeta block');
    this.itemCount = i32(data, 8);
    const available = data.length - 16;
    let itemSize = sizes[0];
    if (other && sizes.length > 1) {
      let distance = -Infinity;
      for (const s of sizes) {
        if (available % s !== 0) continue;
        if (available / s === other.count) {
          itemSize = s;
          break;
        }
        const d = this.itemCount * s - available;
        if (d <= 0 && d > distance) {
          itemSize = s;
          distance = d;
        }
      }
    }
    const n = Math.floor(available / itemSize);
    for (let i = 0; i < n; i++) this.items.push(data.subarray(16 + i * itemSize, 16 + (i + 1) * itemSize));
  }

  get adjustedCount(): number {
    return this.items.length;
  }

  item(i: number): Uint8Array | null {
    return this.items[i] ?? null;
  }
}

export class FixedData {
  private items: (Uint8Array | null)[] = [];
  private offsets: number[] = [];

  /** Records located by their meta entries' offsets (bytes 4-7); sizes from the gaps between them. */
  static fromMeta(meta: FixedMeta, buffer: Uint8Array | null, maxExpectedSize = 0, minSize = 0): FixedData {
    const f = new FixedData();
    const buf = buffer ?? new Uint8Array(0);
    const n = meta.adjustedCount;
    for (let i = 0; i < n; i++) {
      const m = meta.item(i)!;
      const off = i32(m, 4);
      f.items.push(null);
      f.offsets.push(-1);
      if (off < 0 || off > buf.length) continue;
      let size = i + 1 === n ? buf.length - off : i32(meta.item(i + 1)!, 4) - off;
      if (size === 0) size = minSize;
      const available = buf.length - off;
      if (size < 0 || size > available) size = maxExpectedSize === 0 ? available : Math.min(maxExpectedSize, available);
      if (maxExpectedSize !== 0 && size > maxExpectedSize) size = maxExpectedSize;
      if (size > 0) {
        f.items[i] = buf.subarray(off, off + size);
        f.offsets[i] = off;
      }
    }
    return f;
  }

  /** Records located by their meta entries' offsets, all `itemSize` long. */
  static fromMetaFixedSize(meta: FixedMeta, itemSize: number, buffer: Uint8Array | null): FixedData {
    const f = new FixedData();
    const buf = buffer ?? new Uint8Array(0);
    for (let i = 0; i < meta.adjustedCount; i++) {
      const off = i32(meta.item(i)!, 4);
      f.items.push(null);
      f.offsets.push(-1);
      if (off < 0 || off > buf.length) continue;
      const size = itemSize < 0 ? buf.length - off : Math.min(itemSize, buf.length - off);
      f.items[i] = buf.subarray(off, off + size);
      f.offsets[i] = off;
    }
    return f;
  }

  /** Back-to-back records of one size. */
  static uniform(itemSize: number, buffer: Uint8Array | null): FixedData {
    const f = new FixedData();
    const buf = buffer ?? new Uint8Array(0);
    const n = Math.floor(buf.length / itemSize);
    for (let i = 0; i < n; i++) {
      f.items.push(buf.subarray(i * itemSize, (i + 1) * itemSize));
      f.offsets.push(i * itemSize);
    }
    return f;
  }

  get count(): number {
    return this.items.length;
  }

  item(i: number | null | undefined): Uint8Array | null {
    return i === null || i === undefined ? null : this.items[i] ?? null;
  }

  isValid(i: number | null | undefined): boolean {
    return i !== null && i !== undefined && i >= 0 && i < this.items.length;
  }

  indexOfOffset(offset: number): number {
    return this.offsets.indexOf(offset);
  }
}

/** Where each unique ID's variable-length values are: id -> field key -> offset in Var2Data. */
export class VarMeta {
  readonly table = new Map<number, Map<number, number>>();
  readonly offsets: number[] = [];

  constructor(data: Uint8Array | null) {
    if (!data || data.length < 24) return;
    const magic = i32(data, 0);
    if (magic !== 0 && magic !== MAGIC) throw new Error('bad VarMeta block');
    const count = i32(data, 8);
    let p = 24;
    for (let i = 0; i < count && data.length - p >= 12; i++) {
      const id = i32(data, p);
      const offset = i32(data, p + 4);
      const type = u16(data, p + 8);
      p += 12;
      let m = this.table.get(id);
      if (!m) this.table.set(id, (m = new Map()));
      m.set(type, offset);
      this.offsets.push(offset);
    }
  }

  ids(): number[] {
    return [...this.table.keys()].sort((a, b) => a - b);
  }

  has(id: number): boolean {
    return this.table.has(id);
  }

  types(id: number): number[] {
    return [...(this.table.get(id)?.keys() ?? [])];
  }

  offset(id: number, type: number | null | undefined): number | undefined {
    return type === null || type === undefined ? undefined : this.table.get(id)?.get(type);
  }
}

/**
 * Project 2000-2003's variable-data index (MPXJ's VarMeta9): the same table
 * as VarMeta, with a three-byte unique ID and a one-byte type per entry.
 */
export class VarMeta9 extends VarMeta {
  constructor(data: Uint8Array | null) {
    super(null);
    if (!data || data.length < 24) return;
    if (i32(data, 0) !== MAGIC) throw new Error('bad VarMeta block');
    const count = i32(data, 8);
    let p = 24;
    for (let i = 0; i < count && data.length - p >= 8; i++) {
      const id = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
      const type = data[p + 3];
      const offset = i32(data, p + 4);
      p += 8;
      let m = this.table.get(id);
      if (!m) this.table.set(id, (m = new Map()));
      m.set(type, offset);
      this.offsets.push(offset);
    }
  }
}

export class Var2Data {
  private cache = new Map<number, Uint8Array | null>();

  constructor(readonly meta: VarMeta, private data: Uint8Array | null) {}

  /** The value at an offset: a 4-byte size, then the bytes. */
  private at(offset: number | undefined): Uint8Array | null {
    if (offset === undefined || !this.data) return null;
    let v = this.cache.get(offset);
    if (v !== undefined) return v;
    v = null;
    if (offset >= 0 && offset + 4 <= this.data.length) {
      const size = i32(this.data, offset);
      if (size >= 0 && offset + 4 + size <= this.data.length) v = this.data.subarray(offset + 4, offset + 4 + size);
    }
    this.cache.set(offset, v);
    return v;
  }

  bytes(id: number, type: number | null | undefined): Uint8Array | null {
    return this.at(this.meta.offset(id, type));
  }

  string(id: number, type: number | null | undefined): string | null {
    const b = this.bytes(id, type);
    return b ? unicode(b, 0) : null;
  }

  short(id: number, type: number | null | undefined): number {
    const b = this.bytes(id, type);
    return b && b.length >= 2 ? u16(b, 0) : 0;
  }

  byte(id: number, type: number | null | undefined): number {
    const b = this.bytes(id, type);
    return b && b.length ? b[0] : 0;
  }

  int(id: number, type: number | null | undefined): number {
    const b = this.bytes(id, type);
    return b && b.length >= 4 ? i32(b, 0) : 0;
  }

  double(id: number, type: number | null | undefined): number {
    const b = this.bytes(id, type);
    return b && b.length >= 8 ? f64(b, 0) : 0;
  }
}
