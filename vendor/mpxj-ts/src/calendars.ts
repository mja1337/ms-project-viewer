/**
 * Working-time calendars in .mpp files, ported from MPXJ's
 * AbstractCalendarFactory, AbstractCalendarAndExceptionFactory,
 * MPP9CalendarFactory, MPP12CalendarFactory and MPP14CalendarFactory, and
 * the date rules of its RecurringData (LGPL-2.1,
 * https://github.com/joniles/mpxj).
 *
 * The calendars are in the project folder's TBkndCal: a 12-byte fixed record
 * per calendar (its unique ID, its base calendar's, its resource's) and, in
 * the variable data, its name and a block of hours: 7 x 60 bytes, one per
 * weekday from Sunday, then the exceptions (64 bytes each in Project
 * 2000-2003; from 2007, 92 bytes and a name, which may repeat), then from
 * 2010 the named work weeks.
 */

import { FixedData, FixedMeta, Props, Var2Data, VarMeta, VarMeta9 } from './blocks';
import { i32, u16 } from './bytes';
import { CalendarDay, CalendarException, ProjectCalendar, WorkWeek, WorkingTime } from './model';

const EPOCH = Date.UTC(1983, 11, 31);
const DAY = 86400000;
const DEFAULT_CALENDAR_HOURS = 37753736;
const DEFAULT_CALENDAR_NAME = 37748750;

/** Project's standard day: 8:00 to 12:00 and 13:00 to 17:00. */
export const STANDARD_HOURS: WorkingTime[] = [
  { start: 480, end: 720 },
  { start: 780, end: 1020 },
];

/** Monday to Friday, the standard day; Saturday and Sunday off. Sunday first. */
export function standardWeek(): CalendarDay[] {
  return Array.from({ length: 7 }, (_, i) => (i === 0 || i === 6 ? { type: 'nonworking', hours: [] } : { type: 'working', hours: STANDARD_HOURS.map((h) => ({ ...h })) }));
}

/** MPPUtility.getDate: days since the epoch, or null. */
function date(d: Uint8Array, o: number): number | null {
  if (o + 2 > d.length) return null;
  const days = u16(d, o);
  return days === 65535 ? null : EPOCH + days * DAY;
}

/** MPPUtility.getTime: tenths of a minute since midnight, to whole minutes. */
function time(d: Uint8Array, o: number): number {
  return (Math.floor(u16(d, o) / 10)) % 1440;
}

/** MPPUtility.getDuration: tenths of a minute (two bytes), as minutes. */
function minutes(d: Uint8Array, o: number): number {
  return u16(d, o) / 10;
}

function range(start: number, length: number): WorkingTime {
  return { start, end: Math.min(1440, start + length) };
}

export interface MppCalendarSource {
  /** A stream in the project's TBkndCal folder. */
  stream: (name: string) => Uint8Array | null;
  props: Props;
  /** 9 for Project 2000-2003, 12 for 2007, 14 for 2010 on. */
  format: 9 | 12 | 14;
  /** Project 2013 and later swap the order of the IDs in each fixed record. */
  appVersion: number;
}

export interface MppCalendars {
  calendars: ProjectCalendar[];
  /** The project's calendar. */
  calendar: number | null;
  /** Resource unique ID -> its calendar's unique ID. */
  byResource: Map<number, number>;
}

/** AbstractCalendarFactory.processCalendarData. */
export function readMppCalendars(src: MppCalendarSource): MppCalendars {
  const out: MppCalendars = { calendars: [], calendar: null, byResource: new Map() };
  const varMetaData = src.stream('VarMeta');
  if (!varMetaData) return out;
  const v9 = src.format === 9;
  const varMeta = v9 ? new VarMeta9(varMetaData) : new VarMeta(varMetaData);
  const varData = new Var2Data(varMeta, src.stream('Var2Data'));
  const fixedMeta = new FixedMeta(src.stream('FixedMeta'), [10]);
  const fixed = FixedData.fromMeta(fixedMeta, src.stream('FixedData'), 12);
  const late = src.format === 14 && src.appVersion > 14;
  const idAt = late ? 8 : 0;
  const baseAt = late ? 0 : 4;
  const resourceAt = late ? 4 : 8;
  const hoursAt = v9 ? 4 : 0;
  const NAME = 1;
  const DATA = v9 ? 3 : 8;

  const defaultData = src.props.bytes(DEFAULT_CALENDAR_HOURS);
  const defaultWeek = defaultData ? readWeek(defaultData, hoursAt, null, true) : standardWeek();
  const byId = new Map<number, ProjectCalendar>();
  const derived: [ProjectCalendar, number][] = [];

  for (let loop = 0; loop < fixed.count; loop++) {
    const f = fixed.item(loop);
    if (!f || f.length < 8) continue;
    for (let offset = 0; offset + 12 <= f.length; offset += 12) {
      const id = i32(f, offset + idAt);
      const baseId = i32(f, offset + baseAt);
      if (id <= 0 || byId.has(id)) continue;
      let data = varData.bytes(id, DATA);
      const isBase = baseId <= 0 || baseId === id;
      const cal: ProjectCalendar = { uniqueId: id, name: '', parent: null, resource: null, days: [], exceptions: [], weeks: [] };
      const resource = i32(f, offset + resourceAt);
      if (isBase) {
        if (!data) data = defaultData;
        cal.name = varData.string(id, NAME) ?? '';
        // Base calendars should not belong to a resource, but some files have one that does.
        if (resource > 0 && !out.byResource.has(resource)) out.byResource.set(resource, id);
      } else {
        derived.push([cal, baseId]);
        out.byResource.set(resource, id);
        cal.resource = resource;
      }
      if (!data) cal.days = isBase ? standardWeek() : Array.from({ length: 7 }, () => ({ type: 'default' as const, hours: [] }));
      else {
        cal.days = readWeek(data, hoursAt, defaultWeek, isBase);
        if (v9) cal.exceptions = exceptions9(data);
        else {
          const { list, weeks } = exceptions12(data);
          cal.exceptions = list;
          cal.weeks = weeks;
        }
      }
      byId.set(id, cal);
      out.calendars.push(cal);
    }
  }
  // Derived calendars may come before their base; one whose base is missing is dropped, as MPXJ does.
  for (const [cal, baseId] of derived) {
    const base = byId.get(baseId);
    if (base && base.name) cal.parent = baseId;
    else out.calendars.splice(out.calendars.indexOf(cal), 1);
  }
  const name = src.props.string(DEFAULT_CALENDAR_NAME);
  const found = out.calendars.find((c) => c.parent === null && c.name === name) ?? out.calendars.find((c) => c.parent === null);
  out.calendar = found?.uniqueId ?? null;
  for (const [res, calId] of [...out.byResource]) if (!byId.has(calId) || !out.calendars.includes(byId.get(calId)!)) out.byResource.delete(res);
  return out;
}

/** AbstractCalendarFactory.processCalendarHours: the seven weekday blocks, Sunday first. */
function readWeek(data: Uint8Array, at: number, defaults: CalendarDay[] | null, isBase: boolean): CalendarDay[] {
  const days: CalendarDay[] = [];
  for (let i = 0; i < 7; i++) {
    const o = at + 60 * i;
    const flag = o + 2 <= data.length ? u16(data, o) : 1;
    if (flag === 1) {
      if (!isBase) days.push({ type: 'default', hours: [] });
      else if (defaults) days.push({ type: defaults[i].type === 'working' ? 'working' : 'nonworking', hours: defaults[i].hours.map((h) => ({ ...h })) });
      else days.push(standardWeek()[i]);
      continue;
    }
    const count = o + 4 <= data.length ? u16(data, o + 2) : 0;
    const hours: WorkingTime[] = [];
    for (let p = 0; p < count && p < 5; p++) {
      if (o + 20 + p * 4 + 2 > data.length) break;
      hours.push(range(time(data, o + 8 + p * 2), minutes(data, o + 20 + p * 4)));
    }
    days.push(hours.length ? { type: 'working', hours } : { type: 'nonworking', hours: [] });
  }
  return days;
}

/** MPP9CalendarFactory.processCalendarExceptions: 64-byte records after the week. */
function exceptions9(data: Uint8Array): CalendarException[] {
  const out: CalendarException[] = [];
  const count = data.length >= 2 ? u16(data, 0) : 0;
  for (let i = 0; i < count; i++) {
    const o = 4 + 60 * 7 + i * 64;
    if (o + 64 > data.length) break;
    const from = date(data, o);
    const to = date(data, o + 2);
    if (from === null || to === null) continue;
    const n = u16(data, o + 6);
    const hours: WorkingTime[] = [];
    for (let p = 0; p < n && p < 5; p++) hours.push(range(time(data, o + 12 + p * 2), minutes(data, o + 24 + p * 4)));
    out.push({ name: '', from, to, hours, recurrence: '', dates: null });
  }
  return out;
}

/** AbstractCalendarAndExceptionFactory: exceptions from offset 420, then the work weeks. */
function exceptions12(data: Uint8Array): { list: CalendarException[]; weeks: WorkWeek[] } {
  const list: CalendarException[] = [];
  const weeks: WorkWeek[] = [];
  if (data.length <= 420) return { list, weeks };
  let offset = 420;
  const count = u16(data, offset);
  offset += 4;
  for (let i = 0; i < count; i++) {
    if (offset + 92 > data.length) break;
    const from = date(data, offset);
    const to = date(data, offset + 2);
    const n = u16(data, offset + 14);
    const hours: WorkingTime[] = [];
    for (let p = 0; p < n && p < 5; p++) hours.push(range(time(data, offset + 20 + p * 2), minutes(data, offset + 32 + p * 4)));
    let nameLength = i32(data, offset + 88);
    if (nameLength % 4 !== 0) nameLength = (Math.floor(nameLength / 4) + 1) * 4;
    const name = nameLength ? utf16(data, offset + 92, nameLength) : '';
    if (from !== null && to !== null) {
      const rule = recurrenceOf(data, offset, from, to);
      list.push({ name, from, to, hours, recurrence: rule ? describe(rule) : '', dates: rule ? occurrences(rule) : null });
    }
    if (nameLength < 0) break;
    offset += 92 + nameLength;
  }
  // processWorkWeeks: a 4-byte header, then each week's seven days, dates and name.
  offset += 4;
  while (data.length >= offset + 7 * 60 + 2 + 2 + 8 + 4) {
    const days: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const o = offset + d * 60;
      const type = u16(data, o);
      if (type === 1) days.push({ type: 'default', hours: [] });
      else {
        const n = u16(data, o + 2);
        const hours: WorkingTime[] = [];
        // Work weeks store each length in units of six seconds, as four bytes.
        for (let p = 0; p < n && p < 5; p++) hours.push(range(time(data, o + 8 + p * 2), (i32(data, o + 20 + p * 4) * 6) / 60));
        days.push(hours.length ? { type: 'working', hours } : { type: 'nonworking', hours: [] });
      }
    }
    offset += 7 * 60;
    const from = date(data, offset);
    const to = date(data, offset + 2);
    offset += 2 + 2 + 8;
    let nameLength = i32(data, offset);
    if (nameLength % 4 !== 0) nameLength = (Math.floor(nameLength / 4) + 1) * 4;
    offset += 4;
    if (nameLength < 0 || offset + nameLength > data.length) break;
    const name = nameLength ? utf16(data, offset, nameLength) : '';
    offset += nameLength;
    weeks.push({ name, from, to, days });
  }
  return { list, weeks };
}

function utf16(d: Uint8Array, o: number, max: number): string {
  let s = '';
  for (let i = o; i + 1 < d.length && i < o + max; i += 2) {
    const c = d[i] | (d[i + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/* ── Repeating exceptions (RecurringData) ────────────────────────────── */

export interface Recurrence {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly';
  relative: boolean;
  start: number;
  /** The last day it may fall on, or null to stop after `occurrences`. */
  finish: number | null;
  occurrences: number;
  frequency: number;
  /** Weekly: which days, Sunday first. */
  days?: boolean[];
  /** Monthly or yearly: the day of the month, or for relative rules which one (1-4, 5 = last). */
  dayNumber?: number;
  /** Relative rules: 0 = Sunday. */
  dayOfWeek?: number;
  /** Yearly: 1-12. */
  month?: number;
}

const TYPES: (Recurrence['type'] | null)[] = [null, 'daily', 'yearly', 'yearly', 'monthly', 'monthly', 'weekly', 'daily'];
const RELATIVE = [false, false, false, true, false, true];

/** AbstractCalendarAndExceptionFactory.readRecurringData; null for an exception that does not repeat. */
function recurrenceOf(data: Uint8Array, o: number, from: number, to: number): Recurrence | null {
  const code = u16(data, o + 72);
  const type = TYPES[code] ?? null;
  if (!type) return null;
  const r: Recurrence = { type, relative: RELATIVE[code] ?? false, start: from, finish: to, occurrences: u16(data, o + 4), frequency: 1 };
  const b = (k: number) => data[o + k] ?? 0;
  switch (type) {
    case 'daily':
      r.frequency = code === 1 ? 1 : u16(data, o + 76);
      // Every day from one date to another is a plain run of dates.
      if (r.frequency === 1) return null;
      break;
    case 'weekly': {
      const mask = b(76);
      r.days = Array.from({ length: 7 }, (_, i) => (mask & (1 << i)) !== 0);
      r.frequency = u16(data, o + 78);
      break;
    }
    case 'monthly':
      if (r.relative) {
        r.dayOfWeek = (((b(77) - 3) % 7) + 7) % 7;
        r.dayNumber = b(76) + 1;
        r.frequency = u16(data, o + 78);
      } else {
        r.dayNumber = b(76);
        r.frequency = b(78);
      }
      break;
    case 'yearly':
      if (r.relative) {
        r.dayOfWeek = (((b(78) - 3) % 7) + 7) % 7;
        r.dayNumber = b(77) + 1;
      } else r.dayNumber = b(77);
      r.month = b(76) + 1;
      break;
  }
  return r;
}

const ymd = (ms: number) => {
  const d = new Date(ms);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()] as const;
};
const monthLength = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The days a rule falls on (RecurringData.getDates), capped at 5000. */
export function occurrences(r: Recurrence): number[] {
  const out: number[] = [];
  const more = (d: number) => out.length < 5000 && (r.finish === null ? out.length < Math.max(1, r.occurrences) : d <= r.finish);
  const freq = Math.max(1, r.frequency || 1);
  const nth = (y: number, m: number): number => {
    const dow = r.dayOfWeek ?? 0;
    if ((r.dayNumber ?? 1) > 4) {
      const last = Date.UTC(y, m, monthLength(y, m));
      return last - (((new Date(last).getUTCDay() - dow) + 7) % 7) * DAY;
    }
    const first = Date.UTC(y, m, 1);
    return first + (((dow - new Date(first).getUTCDay()) + 7) % 7) * DAY + 7 * ((r.dayNumber ?? 1) - 1) * DAY;
  };
  switch (r.type) {
    case 'daily':
      for (let d = r.start; more(d); d += freq * DAY) out.push(d);
      break;
    case 'weekly': {
      if (!r.days?.some(Boolean)) break;
      let week = r.start - new Date(r.start).getUTCDay() * DAY;
      for (let guard = 0; guard < 10000; guard++) {
        let stop = false;
        for (let i = 0; i < 7; i++) {
          if (!r.days[i]) continue;
          const d = week + i * DAY;
          if (!more(d)) {
            stop = true;
            break;
          }
          if (d >= r.start) out.push(d);
        }
        if (stop) break;
        week += 7 * freq * DAY;
        if (!more(week)) break;
      }
      break;
    }
    case 'monthly': {
      let [y, m] = ymd(r.start);
      if (r.relative) {
        for (let guard = 0; guard < 10000 && more(Date.UTC(y, m, 1)); guard++) {
          const d = nth(y, m);
          if (d >= r.start) {
            out.push(d);
            if (!more(d)) break;
          }
          m += freq;
        }
      } else {
        const want = r.dayNumber ?? 1;
        if (want < ymd(r.start)[2]) m += 1;
        for (let guard = 0; guard < 10000; guard++) {
          const first = Date.UTC(y, m, 1);
          if (!more(first)) break;
          const yy = new Date(first).getUTCFullYear();
          const mm = new Date(first).getUTCMonth();
          out.push(Date.UTC(yy, mm, Math.min(want, monthLength(yy, mm))));
          m += freq;
        }
      }
      break;
    }
    case 'yearly': {
      let y = ymd(r.start)[0];
      const m = (r.month ?? 1) - 1;
      for (let guard = 0; guard < 1000 && more(Date.UTC(y, m, 1)); guard++) {
        if (r.relative) {
          const d = nth(y, m);
          if (d >= r.start) {
            out.push(d);
            if (!more(d)) break;
          }
        } else {
          let d = Date.UTC(y, m, Math.min(r.dayNumber ?? 1, monthLength(y, m)));
          if (d < r.start) {
            y++;
            d = Date.UTC(y, m, Math.min(r.dayNumber ?? 1, monthLength(y, m)));
          }
          out.push(d);
        }
        y++;
      }
      break;
    }
  }
  return out;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'last'];

/** "Every 2 weeks on Monday and Friday", "Every year on the last Monday of May". */
export function describe(r: Recurrence): string {
  const every = (n: number, one: string, many: string) => (n > 1 ? `Every ${n} ${many}` : `Every ${one}`);
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');
  switch (r.type) {
    case 'daily':
      return every(r.frequency, 'day', 'days');
    case 'weekly':
      return `${every(r.frequency, 'week', 'weeks')} on ${list(DAY_NAMES.filter((_, i) => r.days?.[i]))}`;
    case 'monthly':
      return r.relative
        ? `${every(r.frequency, 'month', 'months')} on the ${ORDINAL[r.dayNumber ?? 1]} ${DAY_NAMES[r.dayOfWeek ?? 0]}`
        : `${every(r.frequency, 'month', 'months')} on day ${r.dayNumber}`;
    case 'yearly':
      return r.relative
        ? `Every year on the ${ORDINAL[r.dayNumber ?? 1]} ${DAY_NAMES[r.dayOfWeek ?? 0]} of ${MONTH_NAMES[(r.month ?? 1) - 1]}`
        : `Every year on ${r.dayNumber} ${MONTH_NAMES[(r.month ?? 1) - 1]}`;
  }
}

/**
 * After the resources are read: a resource's calendar takes its name (the
 * file stores none), and a derived calendar that belongs to no resource is
 * dropped, as Project leaves it out of its own XML.
 */
export function finishCalendars(p: { calendars: ProjectCalendar[]; resources: { uniqueId: number; name: string; calendar: number | null }[] }): void {
  const byUid = new Map(p.resources.map((r) => [r.uniqueId, r]));
  p.calendars = p.calendars.filter((c) => c.parent === null || (c.resource !== null && byUid.has(c.resource)));
  for (const c of p.calendars) if (c.parent !== null && !c.name) c.name = byUid.get(c.resource!)!.name;
  const kept = new Set(p.calendars.map((c) => c.uniqueId));
  for (const r of p.resources) if (r.calendar !== null && !kept.has(r.calendar)) r.calendar = null;
}
