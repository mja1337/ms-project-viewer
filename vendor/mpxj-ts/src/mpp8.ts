/**
 * Microsoft Project 98 files (.mpp, "MPP8"), ported from MPXJ's MPP8Reader,
 * FixFix, FixDeferFix, ExtendedData and Props8 (LGPL-2.1,
 * https://github.com/joniles/mpxj).
 *
 * Project 98 has no field maps: each task, resource, assignment, link and
 * calendar is a record of fixed size in a "FixFix   0" stream, with fields
 * at known offsets, and its text in a "FixDeferFix   0" stream of chained
 * 32-byte blocks. Values with no fixed place (WBS, notes, custom fields) sit
 * in an "extended data" list of typed entries, also in the deferred stream.
 * Everything is in the folder "   1".
 */

import { Cfb } from './cfb';
import { finishCalendars, standardWeek } from './calendars';
import { Props } from './blocks';
import { adjustedDuration, durationUnits, f64, i32, simpleDuration, timestamp, u16 } from './bytes';
import { CalendarException, Project, ProjectCalendar, Relation, RelationType, Resource, Task, WorkingTime, emptyTask, updateStructure } from './model';
import { rtfToText } from './rtf';

const EPOCH = Date.UTC(1983, 11, 31);
const DAY = 86400000;
const CONSTRAINTS = ['As Soon As Possible', 'As Late As Possible', 'Must Start On', 'Must Finish On', 'Start No Earlier Than', 'Start No Later Than', 'Finish No Earlier Than', 'Finish No Later Than'];
const RELATION_TYPES: RelationType[] = ['FF', 'FS', 'SF', 'SS'];

// Extended data types (MPP8Reader's constants).
const TASK_WBS = 104;
const TASK_CONTACT = 105;
const TASK_TEXT = [106, 107, 108, 109, 110];
const TASK_NOTES = 247;
const RESOURCE_GROUP = 61;
const RESOURCE_EMAIL = 63;
const RESOURCE_NOTES = 169;
const CALENDAR_DATA = 8;

const KEY = {
  PROJECT_START_DATE: 37748738, PROJECT_FINISH_DATE: 37748739, STATUS_DATE: 37748805, DURATION_UNITS: 37748757, MINUTES_PER_DAY: 37748765, MINUTES_PER_WEEK: 37748766, DAYS_PER_MONTH: 37753743,
  CURRENCY_SYMBOL: 37748752, TITLE: 37748744, SUBJECT: 37748745, AUTHOR: 37748748, COMMENTS: 37748741, MANAGER: 37748737, COMPANY: 37748736, DEFAULT_CALENDAR_NAME: 37748750,
};

/** Props8: a 16-byte header, then entries whose size is in the first or third word. */
class Props8 extends Props {
  constructor(data: Uint8Array | null) {
    super(null);
    if (!data || data.length < 16) return;
    const count = u16(data, 12);
    let p = 16;
    for (let i = 0; i < count; i++) {
      if (p + 12 > data.length) break;
      const a1 = i32(data, p);
      const key = i32(data, p + 4);
      const a3 = data[p + 6];
      const a5 = i32(data, p + 8);
      p += 12;
      let size = a3 === 64 ? a1 : a5;
      if (a5 === 65536) size = 4;
      if (size <= 0 || p + size > data.length) break;
      this.map.set(key, data.subarray(p, p + size));
      p += size;
      if (size % 2) p++;
    }
  }
}

/** FixFix: back-to-back records of one size; `diff` is what is left over (a sign of the wrong size). */
function fixFix(data: Uint8Array | null, size: number): { items: Uint8Array[]; diff: number; size: number } {
  const buf = data ?? new Uint8Array(0);
  const items: Uint8Array[] = [];
  for (let p = 0; p + size <= buf.length; p += size) items.push(buf.subarray(p, p + size));
  return { items, diff: buf.length % size, size: buf.length };
}

/** FixDeferFix: values in chained blocks (28 bytes in the first, 32 in each next), found by offset. */
class Deferred {
  constructor(private data: Uint8Array) {}

  bytes(offset: number): Uint8Array | null {
    const d = this.data;
    if (!(offset > 0 && offset + 8 <= d.length)) return null;
    let next = i32(d, offset);
    let p = offset + 8;
    const size = i32(d, offset + 4);
    if (!(size > 0 && size < d.length)) return null;
    let block = 28;
    if (next === -1 && size > block) return null;
    const out = new Uint8Array(size);
    let at = 0;
    let left = size;
    let guard = 0;
    while (next !== -1 && guard++ < 100000) {
      if (p + block > d.length || at + block > size) return null;
      out.set(d.subarray(p, p + block), at);
      at += block;
      p += block;
      left -= block;
      if (p !== next) p = next;
      if (p + 4 > d.length) return null;
      next = i32(d, p);
      p += 4;
      block = 32;
    }
    if (left < 0 || p + left > d.length) return null;
    out.set(d.subarray(p, p + left), at);
    return out;
  }

  /** Text stored as UTF-16. */
  unicode(offset: number): string {
    const b = this.bytes(offset);
    if (!b) return '';
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Text stored as single bytes (notes, which are RTF). */
  ansi(offset: number): string {
    const b = this.bytes(offset);
    return b ? new TextDecoder('windows-1252').decode(b).replace(/\0+$/, '') : '';
  }
}

/** ExtendedData: [size, type, value] entries; text values hold an offset into the deferred stream. */
class Extended {
  private map = new Map<number, Uint8Array>();

  constructor(private deferred: Deferred, offset: number) {
    const d = deferred.bytes(offset);
    if (!d) return;
    let i = 0;
    while (i + 8 <= d.length) {
      const size = i32(d, i);
      const type = i32(d, i + 4);
      i += 8;
      if (size < 0 || i + size > d.length) break;
      this.map.set(type, d.subarray(i, i + size));
      i += size;
    }
  }

  int(type: number): number {
    const v = this.map.get(type);
    return v && v.length >= 4 ? i32(v, 0) : 0;
  }

  unicode(type: number): string {
    const v = this.map.get(type);
    return v && v.length >= 4 ? this.deferred.unicode(-1 - i32(v, 0)) : '';
  }

  ansi(type: number): string {
    const v = this.map.get(type);
    return v && v.length >= 4 ? this.deferred.ansi(-1 - i32(v, 0)) : '';
  }
}

const offsetAt = (d: Uint8Array, o: number) => -1 - i32(d, o);
/** MPPUtility.getLong6: six bytes, little-endian. */
const long6 = (d: Uint8Array, o: number) => {
  let v = 0;
  for (let i = 5; i >= 0; i--) v = v * 256 + d[o + i];
  // A negative value has its top bit set.
  return d[o + 5] & 0x80 ? v - 2 ** 48 : v;
};
/** Work: six bytes in hundredths of tenths of a minute (MPPUtility.getDuration(long6 / 100, HOURS)). */
const hoursOf = (d: Uint8Array, o: number) => Math.round((long6(d, o) / 60000) * 100) / 100;
const time = (d: Uint8Array, o: number) => Math.floor(u16(d, o) / 10) % 1440;
const date = (d: Uint8Array, o: number) => (u16(d, o) === 65535 ? null : EPOCH + u16(d, o) * DAY);

export interface Mpp8Context {
  summary: Map<number, string>;
  docSummary: Map<number, string>;
}

export function readMpp8(cfb: Cfb, ctx: Mpp8Context): Project {
  const P = '   1';
  const props = new Props8(cfb.stream(P, 'Props'));
  const minutesPerDay = props.int(KEY.MINUTES_PER_DAY) || 480;
  const minutesPerWeek = props.int(KEY.MINUTES_PER_WEEK) || 2400;
  const daysPerMonth = props.short(KEY.DAYS_PER_MONTH) || 20;
  const defaultUnits = durationUnits(props.short(KEY.DURATION_UNITS));
  const cal = { minutesPerDay, minutesPerWeek, daysPerMonth };
  const string = (k: number) => props.string(k);
  const project: Project = {
    format: 'Microsoft Project 98 (.mpp)',
    title: ctx.summary.get(2) || string(KEY.TITLE),
    subject: ctx.summary.get(3) || string(KEY.SUBJECT),
    author: ctx.summary.get(4) || string(KEY.AUTHOR),
    comments: ctx.summary.get(6) || string(KEY.COMMENTS),
    manager: ctx.docSummary.get(14) || string(KEY.MANAGER),
    company: ctx.docSummary.get(15) || string(KEY.COMPANY),
    start: props.timestamp(KEY.PROJECT_START_DATE),
    finish: props.timestamp(KEY.PROJECT_FINISH_DATE),
    statusDate: props.timestamp(KEY.STATUS_DATE),
    currencySymbol: string(KEY.CURRENCY_SYMBOL),
    minutesPerDay,
    minutesPerWeek,
    daysPerMonth,
    summary: null,
    tasks: [],
    resources: [],
    assignments: [],
    calendars: [],
    calendar: null,
    warnings: [],
  };
  const deferred = (folder: string) => new Deferred(cfb.stream(P, folder, 'FixDeferFix   0') ?? new Uint8Array(0));

  /* ── Calendars (processCalendarData) ────────────────────────────────── */

  const calFixed = fixFix(cfb.stream(P, 'TBkndCal', 'FixFix   0'), 36);
  const calVar = deferred('TBkndCal');
  const calById = new Map<number, ProjectCalendar>();
  const derived: [ProjectCalendar, number][] = [];
  for (const base of calFixed.items) {
    const id = i32(base, 0);
    const baseId = i32(base, 4);
    if (id < 0) continue;
    const name = calVar.unicode(offsetAt(base, 20));
    const ext = new Extended(calVar, offsetAt(base, 32));
    const offset = -1 - ext.int(CALENDAR_DATA);
    const c: ProjectCalendar = { uniqueId: id, name: baseId > 0 ? '' : name, parent: null, resource: null, days: [], exceptions: [], weeks: [] };
    const data = offset === -1 ? null : calVar.bytes(offset);
    if (!data) c.days = baseId > 0 ? Array.from({ length: 7 }, () => ({ type: 'default' as const, hours: [] })) : standardWeek();
    else {
      for (let i = 0; i < 7; i++) {
        const o = 4 + 40 * i;
        if (o + 4 > data.length) break;
        const flag = u16(data, o);
        // A default day is the standard one in a base calendar, and the base's in a resource's.
        if (flag === 1) c.days.push(baseId > 0 ? { type: 'default', hours: [] } : standardWeek()[i]);
        else {
          const n = u16(data, o + 2);
          const hours: WorkingTime[] = [];
          for (let p = 0; p < n && p < 3; p++) {
            const start = time(data, o + 8 + p * 2);
            hours.push({ start, end: Math.min(1440, start + u16(data, o + 16 + p * 4) / 10) });
          }
          c.days.push(hours.length ? { type: 'working', hours } : { type: 'nonworking', hours: [] });
        }
      }
      while (c.days.length < 7) c.days.push(standardWeek()[c.days.length]);
      const count = data.length >= 2 ? u16(data, 0) : 0;
      for (let i = 0; i < count; i++) {
        const o = 4 + 40 * 7 + i * 44;
        if (o + 44 > data.length) break;
        const from = date(data, o);
        const to = date(data, o + 2);
        if (from === null || to === null) continue;
        const n = u16(data, o + 6);
        const hours: WorkingTime[] = [];
        for (let p = 0; p < n && p < 3; p++) {
          const start = time(data, o + 12 + p * 2);
          hours.push({ start, end: Math.min(1440, start + u16(data, o + 20 + p * 4) / 10) });
        }
        const e: CalendarException = { name: '', from, to, hours, recurrence: '', dates: null };
        c.exceptions.push(e);
      }
    }
    if (baseId > 0) derived.push([c, baseId]);
    calById.set(id, c);
    project.calendars.push(c);
  }
  for (const [c, baseId] of derived) if (calById.has(baseId)) c.parent = baseId;
  const defaultName = string(KEY.DEFAULT_CALENDAR_NAME);
  project.calendar = (project.calendars.find((c) => c.parent === null && c.name === defaultName) ?? project.calendars.find((c) => c.parent === null))?.uniqueId ?? null;

  /* ── Resources (processResourceData) ─────────────────────────────────── */

  const rscFixed = fixFix(cfb.stream(P, 'TBkndRsc', 'FixFix   0'), 196);
  const rscVar = deferred('TBkndRsc');
  const resources = new Map<number, Resource>();
  for (const d of rscFixed.items) {
    const uid = i32(d, 0);
    if (uid < 1 || d[8] & 0x01 || u16(d, 164) !== 0) continue;
    const ext = new Extended(rscVar, offsetAt(d, 192));
    const calId = i32(d, 24);
    const notes = ext.ansi(RESOURCE_NOTES);
    const r: Resource = {
      uniqueId: uid,
      id: i32(d, 4),
      name: rscVar.unicode(offsetAt(d, 156)),
      initials: rscVar.unicode(offsetAt(d, 160)),
      group: ext.unicode(RESOURCE_GROUP),
      email: ext.unicode(RESOURCE_EMAIL),
      type: 'Work',
      // Stored as a percentage times 100 (10000 is 100%).
      maxUnits: i32(d, 52) / 10000,
      standardRate: Math.round(f64(d, 36) * 10000) / 10000,
      rateUnits: 'h',
      cost: long6(d, 120) / 100,
      work: hoursOf(d, 56),
      notes: notes ? rtfToText(notes) : '',
      calendar: calById.has(calId) ? calId : null,
    };
    const c = r.calendar === null ? null : calById.get(r.calendar)!;
    if (c && c.parent !== null) c.resource = uid;
    resources.set(uid, r);
  }
  project.resources = [...resources.values()].filter((r) => r.id > 0 || r.name).sort((a, b) => a.id - b.id);
  finishCalendars(project);

  /* ── Tasks (processTaskData) ─────────────────────────────────────────── */

  let taskFixed = fixFix(cfb.stream(P, 'TBkndTask', 'FixFix   0'), 316);
  if (taskFixed.diff !== 0) taskFixed = fixFix(cfb.stream(P, 'TBkndTask', 'FixFix   0'), 366);
  const taskVar = deferred('TBkndTask');
  const byUid = new Map<number, Task>();
  for (const d of taskFixed.items) {
    const uid = i32(d, 0);
    if (uid < 1) continue;
    const deleted = u16(d, 272);
    if ((deleted & 0xc0) === 0 && (deleted & 0x03) !== 0 && deleted !== 0x0031 && deleted !== 0x203d) continue;
    if (d[8] & 0x01) continue;
    const ext = new Extended(taskVar, offsetAt(d, 312));
    const t = emptyTask(uid);
    t.id = i32(d, 4);
    t.name = taskVar.unicode(offsetAt(d, 264));
    const units = durationUnits(u16(d, 72), defaultUnits);
    t.duration = adjustedDuration(cal, i32(d, 68), units);
    t.start = timestamp(d, 96);
    t.finish = timestamp(d, 20);
    t.actualStart = timestamp(d, 104);
    t.actualFinish = timestamp(d, 108);
    t.baselineStart = timestamp(d, 112);
    t.baselineFinish = timestamp(d, 116);
    t.constraintDate = timestamp(d, 120);
    t.constraint = CONSTRAINTS[u16(d, 88)] ?? '';
    const pct = u16(d, 130);
    t.percentComplete = pct <= 100 ? pct : 0;
    t.priority = (u16(d, 128) + 1) * 100;
    t.milestone = (d[12] & 0x01) !== 0;
    t.outlineLevel = u16(d, 48) || 1;
    t.work = hoursOf(d, 168);
    t.cost = long6(d, 222) / 100;
    t.wbs = ext.unicode(TASK_WBS);
    // Project 98 stores no critical flag: a task that cannot finish any later is critical.
    const lateFinish = timestamp(d, 160);
    t.critical = t.percentComplete < 100 && lateFinish !== null && t.finish !== null && lateFinish <= t.finish;
    let notes = ext.ansi(TASK_NOTES);
    if (!notes && d.length === 366) {
      const o = taskVar.bytes(offsetAt(d, 362));
      if (o && o.length >= 12) {
        const n = taskVar.ansi(offsetAt(o, 8));
        if (n.includes('{')) notes = n;
      }
    }
    t.notes = notes ? rtfToText(notes) : '';
    const extra: Record<string, string> = {};
    const contact = ext.unicode(TASK_CONTACT);
    if (contact) extra.CONTACT = contact;
    TASK_TEXT.forEach((type, i) => {
      const v = ext.unicode(type);
      if (v) extra[`TEXT${i + 1}`] = v;
    });
    t.extra = extra;
    // A row with no name and no dates is a blank line.
    if (!t.name && t.start === null) t.blank = true;
    byUid.set(uid, t);
  }

  /* ── Links (processConstraintData) ───────────────────────────────────── */

  for (const d of fixFix(cfb.stream(P, 'TBkndCons', 'FixFix   0'), 36).items) {
    if (i32(d, 28) !== 0) continue;
    const from = i32(d, 12);
    const to = i32(d, 16);
    if (from === to) continue;
    const succ = byUid.get(to);
    if (!succ || !byUid.has(from)) continue;
    const lagUnits = durationUnits(u16(d, 22));
    const lagTenths = i32(d, 24);
    const rel: Relation = { task: from, type: RELATION_TYPES[u16(d, 20)] ?? 'FS', lag: lagTenths ? simpleDuration(lagTenths, lagUnits) : null };
    if (!succ.predecessors.some((x) => x.task === from && x.type === rel.type)) succ.predecessors.push(rel);
  }

  /* ── Assignments (processAssignmentData) ─────────────────────────────── */

  const assnData = cfb.stream(P, 'TBkndAssn', 'FixFix   0');
  let assn = fixFix(assnData, 204);
  const known = (items: Uint8Array[]) => items.every((d) => byUid.has(i32(d, 16)) || resources.has(i32(d, 20)));
  if (assn.diff !== 0 || (assn.size % 238 === 0 && !known(assn.items))) assn = fixFix(assnData, 238);
  const seen = new Set<string>();
  for (const d of assn.items) {
    if (d[168] === 0x02) continue;
    const task = i32(d, 16);
    const resource = i32(d, 20);
    if (!byUid.has(task) || !resources.has(resource)) continue;
    const key = `${task}/${resource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    project.assignments.push({ task, resource, units: u16(d, 80) / 10000, work: hoursOf(d, 84), cost: long6(d, 132) / 100, start: timestamp(d, 24), finish: timestamp(d, 28) });
  }

  const all = [...byUid.values()];
  updateStructure(all);
  for (const a of project.assignments) {
    const t = byUid.get(a.task)!;
    const r = resources.get(a.resource)!;
    const label = r.name + (a.units !== null && Math.abs(a.units - 1) > 0.001 ? `[${Math.round(a.units * 100)}%]` : '');
    t.resourceNames = t.resourceNames ? `${t.resourceNames}, ${label}` : label;
  }
  project.summary = all.find((t) => t.id === 0) ?? null;
  project.tasks = all.filter((t) => t.id !== 0);
  if (!project.title && project.summary?.name) project.title = project.summary.name;
  return project;
}

