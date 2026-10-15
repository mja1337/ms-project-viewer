/**
 * Where each field of a task, resource or assignment sits, as recorded in
 * the file itself: ported from MPXJ's FieldMap, FieldMap9, FieldMap12 and
 * FieldMap14 (LGPL-2.1). A Project 2000-2003 file without a field map falls
 * back to the layout FieldMap9 spells out (fieldmap9.ts).
 *
 * A field map is a list of 28-byte entries: the field number, and either an
 * offset into one of two fixed-data records, or a key into the variable
 * data. Values are then read according to the field's data type.
 */

import { Calendar, adjustedDuration, ascii, durationUnits, f64, guid, i32, simpleDuration, timeUnitByIndex, timestamp, u16, u8, unicode } from './bytes';
import { Var2Data } from './blocks';
import { FieldDef, ASSIGNMENT_FIELDS, ASSIGNMENT_FIELDS_ALTERNATE, RESOURCE_FIELDS, TASK_FIELDS, TASK_FIELDS_MPP14 } from './fields';
import { Duration, TimeUnit } from './model';
import { rtfToText } from './rtf';
import { DefaultItem } from './fieldmap9';

export type FieldClass = 'task' | 'resource' | 'assignment';
type Location = 'fixed' | 'var' | 'meta' | 'unknown';

interface FieldItem {
  cls: FieldClass;
  name: string;
  dataType: string;
  units: string;
  location: Location;
  block: number;
  offset: number;
  varKey: number;
}

export type Value = string | number | boolean | Duration | null;

const TASK_BASE = 0x0b40, RESOURCE_BASE = 0x0c40, ASSIGNMENT_BASE = 0x0f40;
const VALUE_LIST_WITH_ID = 0x0701, VALUE_LIST_WITHOUT_ID = 0x0401;

/**
 * The field a number in a field map stands for, or null for enterprise custom
 * fields this does not read. Project 2010 and later number a few task fields
 * differently (scheduled and estimated-baseline dates), hence mpp14.
 */
export function fieldFor(typeValue: number, mpp14 = true): { cls: FieldClass; def: FieldDef } | null {
  const prefix = (typeValue >>> 16) & 0xffff;
  const index = typeValue & 0xffff;
  const placeholder = (cls: FieldClass): FieldDef => [`${cls.toUpperCase()}_FIELD_${index}`, 'UNKNOWN', ''];
  if (index & 0x8000) return null;
  if (prefix === TASK_BASE) return { cls: 'task', def: (mpp14 ? TASK_FIELDS_MPP14[index] : undefined) ?? TASK_FIELDS[index] ?? placeholder('task') };
  if (prefix === RESOURCE_BASE) return { cls: 'resource', def: RESOURCE_FIELDS[index] ?? placeholder('resource') };
  if (prefix === ASSIGNMENT_BASE) {
    if (index & 0x4000 && ASSIGNMENT_FIELDS_ALTERNATE[index]) return { cls: 'assignment', def: ASSIGNMENT_FIELDS_ALTERNATE[index] };
    return { cls: 'assignment', def: ASSIGNMENT_FIELDS[index] ?? placeholder('assignment') };
  }
  return null;
}

function fixedSize(dataType: string): number {
  switch (dataType) {
    case 'DATE':
    case 'INTEGER':
    case 'DURATION':
      return 4;
    case 'TIME_UNITS': case 'CONSTRAINT': case 'PRIORITY': case 'PERCENTAGE': case 'TASK_TYPE': case 'ACCRUE': case 'SHORT': case 'BOOLEAN':
    case 'DELAY': case 'WORKGROUP': case 'RATE_UNITS': case 'EARNED_VALUE_METHOD': case 'RESOURCE_REQUEST_TYPE':
      return 2;
    case 'CURRENCY': case 'UNITS': case 'RATE': case 'WORK':
      return 8;
    case 'WORK_UNITS':
      return 1;
    case 'GUID':
      return 16;
    default:
      return 0;
  }
}

export const CONSTRAINTS = ['As Soon As Possible', 'As Late As Possible', 'Must Start On', 'Must Finish On', 'Start No Earlier Than', 'Start No Later Than', 'Finish No Earlier Than', 'Finish No Later Than', 'Start On', 'Finish On'];

/** Each class's fields by name, for the default layouts, which name their fields. */
let byName: Record<FieldClass, Map<string, FieldDef>> | null = null;
function defByName(cls: FieldClass, name: string): FieldDef | undefined {
  byName ??= {
    task: new Map(Object.values(TASK_FIELDS).map((d) => [d[0], d])),
    resource: new Map(Object.values(RESOURCE_FIELDS).map((d) => [d[0], d])),
    assignment: new Map(Object.values(ASSIGNMENT_FIELDS).map((d) => [d[0], d])),
  };
  return byName[cls].get(name);
}

export interface FieldMapOptions {
  /** Project 2010 and later field numbering (FieldMap14). */
  mpp14?: boolean;
  /**
   * Project 2007 and later key variable data by the field number; Project
   * 2000-2003 store the key in the entry (FieldMap9.useTypeAsVarDataKey).
   */
  typeAsVarKey?: boolean;
}

export class FieldMap {
  readonly items = new Map<string, FieldItem>();
  readonly maxFixedSize = [0, 0];
  private readonly mpp14: boolean;
  private readonly typeAsVarKey: boolean;

  constructor(private cal: Calendar & { defaultUnits: TimeUnit }, options: FieldMapOptions = {}) {
    this.mpp14 = options.mpp14 ?? true;
    this.typeAsVarKey = options.typeAsVarKey ?? true;
  }

  /** The built-in layout for files that carry no field map of their own (FieldMap.populateDefaultData). */
  loadDefaults(cls: FieldClass, defaults: readonly DefaultItem[]): void {
    for (const [name, location, block, offset, varKey] of defaults) {
      const def = defByName(cls, name);
      if (!def) continue;
      this.items.set(`${cls}:${name}`, { cls, name, dataType: def[1], units: def[2], location, block, offset, varKey });
    }
  }

  /** Reads a field map block (from the project Props); fields of other classes are kept too, as MPXJ does. */
  load(data: Uint8Array): void {
    let lastOffset = 0;
    let block = 0;
    for (let i = 0; i + 28 <= data.length; i += 28) {
      const blockOffset = u16(data, i + 4);
      const typeValue = i32(data, i + 12);
      const category = u16(data, i + 20);
      const f = fieldFor(typeValue, this.mpp14);
      if (!f) continue;
      const [name, dataType, units] = f.def;
      const varKey = this.typeAsVarKey ? typeValue & 0xffff : u8(data, i + 6);
      let location: Location;
      if (category === 0x0b || category === 0x64) location = 'meta';
      else if (blockOffset !== 65535) {
        location = 'fixed';
        if (blockOffset < lastOffset) block++;
        lastOffset = blockOffset;
        if (block < 2) this.maxFixedSize[block] = Math.max(this.maxFixedSize[block], blockOffset + fixedSize(dataType));
      } else location = varKey !== 0 ? 'var' : 'unknown';
      this.items.set(`${f.cls}:${name}`, { cls: f.cls, name, dataType, units, location, block, offset: blockOffset, varKey });
    }
  }

  offset(cls: FieldClass, name: string): number {
    return this.items.get(`${cls}:${name}`)?.offset ?? -1;
  }

  varKey(cls: FieldClass, name: string): number | null {
    return this.items.get(`${cls}:${name}`)?.varKey ?? null;
  }

  /** Every field's value of one class for one record. */
  readAll(cls: FieldClass, id: number, fixed: (Uint8Array | null)[], varData: Var2Data): Map<string, Value> {
    const out = new Map<string, Value>();
    for (const item of this.items.values()) {
      if (item.cls !== cls) continue;
      const v = this.read(item, id, fixed, varData);
      if (v !== null && v !== undefined) out.set(item.name, v);
    }
    return out;
  }

  value(cls: FieldClass, name: string, id: number, fixed: (Uint8Array | null)[], varData: Var2Data): Value {
    const item = this.items.get(`${cls}:${name}`);
    return item ? this.read(item, id, fixed, varData) : null;
  }

  private unitsOf(item: FieldItem, id: number, fixed: (Uint8Array | null)[], varData: Var2Data, fallback: TimeUnit): TimeUnit {
    const u = item.units ? this.value(item.cls, item.units, id, fixed, varData) : null;
    return typeof u === 'string' ? (u as TimeUnit) : fallback;
  }

  private read(item: FieldItem, id: number, fixed: (Uint8Array | null)[], varData: Var2Data): Value {
    if (item.location === 'fixed') {
      const d = fixed[item.block];
      if (!d || item.offset >= d.length) return null;
      return this.readFixed(item, d, id, fixed, varData);
    }
    if (item.location === 'var') return this.readVar(item, id, fixed, varData);
    return null;
  }

  private readFixed(item: FieldItem, d: Uint8Array, id: number, fixed: (Uint8Array | null)[], varData: Var2Data): Value {
    const o = item.offset;
    switch (item.dataType) {
      case 'DATE': return timestamp(d, o);
      case 'INTEGER': return i32(d, o);
      case 'DURATION': return adjustedDuration(this.cal, i32(d, o), this.unitsOf(item, id, fixed, varData, this.cal.defaultUnits));
      case 'TIME_UNITS': return durationUnits(u16(d, o), this.cal.defaultUnits);
      case 'CONSTRAINT': return CONSTRAINTS[u16(d, o)] ?? '';
      case 'PRIORITY': case 'SHORT': case 'TASK_TYPE': case 'ACCRUE': case 'WORKGROUP': case 'EARNED_VALUE_METHOD': case 'RESOURCE_REQUEST_TYPE':
        return u16(d, o);
      case 'PERCENTAGE': {
        const v = u16(d, o);
        return v <= 100 ? v : null;
      }
      case 'CURRENCY': case 'UNITS': {
        const a = f64(d, o);
        return Math.abs(a) < 0.1 ? 0 : a / 100;
      }
      case 'RATE': return f64(d, o);
      case 'WORK': {
        const w = f64(d, o);
        return Math.abs(w) < 1000 ? 0 : w / 60000;
      }
      case 'BOOLEAN': return u16(d, o) !== 0;
      case 'DELAY': return simpleDuration(u16(d, o), 'h');
      case 'WORK_UNITS': {
        const v = u8(d, o);
        return v === 0 ? null : timeUnitByIndex(v - 1);
      }
      case 'RATE_UNITS': return timeUnitByIndex(u16(d, o) - 1);
      case 'GUID': return guid(d, o) || null;
      default: return null;
    }
  }

  private readVar(item: FieldItem, id: number, fixed: (Uint8Array | null)[], varData: Var2Data): Value {
    const k = item.varKey;
    switch (item.dataType) {
      case 'DURATION': {
        const b = varData.bytes(id, k);
        if (!b) return null;
        if (b.length === 512) return unicode(b, 0);
        return b.length >= 4 ? adjustedDuration(this.cal, i32(b, 0), this.unitsOf(item, id, fixed, varData, 'h')) : null;
      }
      case 'TIME_UNITS': return durationUnits(varData.short(id, k), this.cal.defaultUnits);
      case 'CURRENCY': {
        const a = varData.double(id, k);
        return Math.abs(a) < 0.1 ? 0 : a / 100;
      }
      case 'STRING': return this.listOr(id, k, varData, () => varData.string(id, k));
      case 'DATE':
        return this.listOr(id, k, varData, () => {
          const b = varData.bytes(id, k);
          if (!b) return null;
          if (b.length === 512) return unicode(b, 0);
          return b.length >= 4 ? timestamp(b, 0) : null;
        });
      case 'NUMERIC': return this.listOr(id, k, varData, () => (varData.meta.offset(id, k) === undefined ? null : varData.double(id, k)));
      case 'INTEGER': return varData.meta.offset(id, k) === undefined ? null : varData.int(id, k);
      case 'WORK': {
        const w = varData.double(id, k);
        return Math.abs(w) < 1000 ? 0 : w / 60000;
      }
      case 'NOTES': {
        const b = varData.bytes(id, k);
        return b ? rtfToText(ascii(b, 0)) : null;
      }
      case 'DELAY': return simpleDuration(varData.short(id, k), 'h');
      case 'PERCENTAGE': case 'SHORT': case 'ACCRUE': case 'WORKGROUP': case 'EARNED_VALUE_METHOD': case 'RESOURCE_REQUEST_TYPE': case 'BOOKING_TYPE':
        return varData.meta.offset(id, k) === undefined ? null : varData.short(id, k);
      case 'BOOLEAN': return varData.meta.offset(id, k) === undefined ? null : varData.short(id, k) !== 0;
      case 'RATE_UNITS': return timeUnitByIndex(varData.short(id, k) - 1);
      case 'GUID': return guid(varData.bytes(id, k), 0) || null;
      default: return null;
    }
  }

  /** Values picked from a custom field's value list are stored by reference; those are left out here. */
  private listOr(id: number, k: number, varData: Var2Data, read: () => Value): Value {
    const flag = varData.short(id, k);
    if (flag === VALUE_LIST_WITH_ID || flag === VALUE_LIST_WITHOUT_ID) return null;
    return read();
  }
}
