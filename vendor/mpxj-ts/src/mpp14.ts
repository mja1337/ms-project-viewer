/**
 * Microsoft Project 2000-2024 files (.mpp, "MPP9", "MPP12" and "MPP14";
 * Project 98's "MPP8" is in src/mpp8.ts),
 * ported from MPXJ's MPPReader, MPP9Reader, MPP12Reader, MPP14Reader,
 * ConstraintFactory, ResourceAssignmentFactory and ProjectPropertiesReader
 * (LGPL-2.1, https://github.com/joniles/mpxj). Project 2007's format is
 * Project 2010's with other stream names and record sizes, and no manual
 * scheduling; Project 2000-2003's (readMpp9) keeps one fixed-data record per
 * task, a smaller variable-data index, and often no field map of its own.
 *
 * Inside the compound file, "   114" ("   112") holds the project: Props (properties
 * and the field maps), and one folder each for tasks (TBkndTask),
 * resources (TBkndRsc), assignments (TBkndAssn) and links (TBkndCons).
 * The working-time calendars are in TBkndCal (src/calendars.ts). Timephased
 * data, views and custom-field value lists are not read: the page shows the
 * plan, not how work spreads over each day.
 */

import { Cfb } from './cfb';
import { finishCalendars, readMppCalendars } from './calendars';
import { readMpp8 } from './mpp8';
import { FixedData, FixedMeta, Props, Var2Data, VarMeta, VarMeta9 } from './blocks';
import { ASSIGNMENT_DEFAULTS_9, DefaultItem, RESOURCE_DEFAULTS_9, TASK_DEFAULTS_9 } from './fieldmap9';
import { durationUnits, adjustedDuration, i32, i64big, u16, unicode } from './bytes';
import { FieldClass, FieldMap, Value } from './fieldmap';
import { Assignment, Duration, Project, Relation, RelationType, Resource, Task, TimeUnit, emptyTask, rateFromHours, updateStructure } from './model';

export class ProjectFileError extends Error {
  constructor(message: string, readonly code: 'password' | 'version' | 'format') {
    super(message);
  }
}

const KEY = {
  PASSWORD_FLAG: 893386752, ENCRYPTION_CODE: 893386759, PROTECTION_PASSWORD_HASH: 893386756,
  TASK_FIELD_MAP: 131092, TASK_FIELD_MAP2: 50331668, RESOURCE_FIELD_MAP: 131093, RESOURCE_FIELD_MAP2: 50331669, ASSIGNMENT_FIELD_MAP: 131095, ASSIGNMENT_FIELD_MAP2: 50331671,
  PROJECT_START_DATE: 37748738, PROJECT_FINISH_DATE: 37748739, STATUS_DATE: 37748805, DURATION_UNITS: 37748757, MINUTES_PER_DAY: 37748765, MINUTES_PER_WEEK: 37748766, DAYS_PER_MONTH: 37753743,
  CURRENCY_SYMBOL: 37748752, TITLE: 37748744, SUBJECT: 37748745, AUTHOR: 37748748, COMMENTS: 37748741, MANAGER: 37748737, COMPANY: 37748736,
};

const PROJECT_2010 = 14;
const PROJECT_2007 = 12;
const RELATION_TYPES: RelationType[] = ['FF', 'FS', 'SF', 'SS'];
const NULL_TASK_BLOCK_SIZE = 16;
const NULL_RESOURCE = -65535;

/** Opens an .mpp file, or throws ProjectFileError saying why it cannot be read. */
export function readMpp(bytes: Uint8Array): Project {
  const cfb = new Cfb(bytes);
  const comp = compObj(cfb.stream('\u0001CompObj'));
  const fm = /^MSProject\.(?:MPP|MPT|GLOBAL)(\d+)$/.exec(comp.format);
  const fileVersion = fm ? Number(fm[1]) : 0;
  if (fileVersion === 9) return readMpp9(cfb);
  if (fileVersion === 8) return readMpp8(cfb, { summary: propertySet(cfb.stream('\u0005SummaryInformation')), docSummary: propertySet(cfb.stream('\u0005DocumentSummaryInformation')) });
  if (fileVersion !== 14 && fileVersion !== 12) {
    throw new ProjectFileError(`This is not a Microsoft Project file this page can read (${comp.format || 'unknown format'}).`, 'version');
  }
  const v12 = fileVersion === 12;
  const appVersion = v12 ? PROJECT_2007 : (comp.version ?? 16);

  const rootProps = new Props(cfb.stream(v12 ? 'Props12' : 'Props14'));
  const passwordFlag = rootProps.byte(KEY.PASSWORD_FLAG);
  if (passwordFlag & 1 && rootProps.bytes(KEY.PROTECTION_PASSWORD_HASH)) throw new ProjectFileError('This project is password protected.', 'password');
  const code = rootProps.byte(KEY.ENCRYPTION_CODE);
  const mask = passwordFlag !== 0 ? (code === 0 ? 0 : 0xff - code) : 0;
  /** Some streams are lightly obfuscated (each byte XORed) in files with a write password. */
  const xored = (...path: string[]) => {
    const s = cfb.stream(...path);
    if (!s || !mask) return s;
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] ^ mask;
    return out;
  };

  const P = v12 ? '   112' : '   114';
  const props = new Props(xored(P, 'Props'));
  const minutesPerDay = props.int(KEY.MINUTES_PER_DAY) || 480;
  const minutesPerWeek = props.int(KEY.MINUTES_PER_WEEK) || 2400;
  const daysPerMonth = props.short(KEY.DAYS_PER_MONTH) || 20;
  const defaultUnits = durationUnits(props.short(KEY.DURATION_UNITS));
  const cal = { minutesPerDay, minutesPerWeek, daysPerMonth, defaultUnits };
  const summary = propertySet(cfb.stream('\u0005SummaryInformation'));
  const docSummary = propertySet(cfb.stream('\u0005DocumentSummaryInformation'));

  const project: Project = {
    format: `Microsoft Project ${({ 12: '2007', 14: '2010', 15: '2013', 16: '2016 or later' } as Record<number, string>)[appVersion] ?? ''} (.mpp)`.replace('  ', ' '),
    title: summary.get(2) || props.string(KEY.TITLE),
    subject: summary.get(3) || props.string(KEY.SUBJECT),
    author: summary.get(4) || props.string(KEY.AUTHOR),
    comments: summary.get(6) || props.string(KEY.COMMENTS),
    manager: docSummary.get(14) || props.string(KEY.MANAGER),
    company: docSummary.get(15) || props.string(KEY.COMPANY),
    start: props.timestamp(KEY.PROJECT_START_DATE),
    finish: props.timestamp(KEY.PROJECT_FINISH_DATE),
    statusDate: props.timestamp(KEY.STATUS_DATE),
    currencySymbol: props.string(KEY.CURRENCY_SYMBOL) || '',
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

  const fieldMap = (...keys: number[]) => {
    const fm = new FieldMap(cal, { mpp14: !v12 });
    for (const k of keys) {
      const d = props.bytes(k);
      if (d) {
        fm.load(d);
        return fm;
      }
    }
    throw new ProjectFileError('The project’s field map is missing: the file may be damaged.', 'format');
  };

  /* ── Calendars (MPP14Reader.processCalendarData) ─────────────────────── */

  const calendars = readMppCalendars({
    stream: (name) => (name === 'FixedData' ? xored(P, 'TBkndCal', name) : cfb.stream(P, 'TBkndCal', name)),
    props,
    format: v12 ? 12 : 14,
    appVersion,
  });
  project.calendars = calendars.calendars;
  project.calendar = calendars.calendar;

  /* ── Tasks (MPP14Reader.processTaskData) ────────────────────────────── */

  const tfm = fieldMap(KEY.TASK_FIELD_MAP, KEY.TASK_FIELD_MAP2);
  const taskVarMeta = new VarMeta(cfb.stream(P, 'TBkndTask', 'VarMeta'));
  const taskVar = new Var2Data(taskVarMeta, cfb.stream(P, 'TBkndTask', 'Var2Data'));
  const taskFixedMeta = new FixedMeta(cfb.stream(P, 'TBkndTask', 'FixedMeta'), [47]);
  const taskFixed = FixedData.fromMeta(taskFixedMeta, cfb.stream(P, 'TBkndTask', 'FixedData'), tfm.maxFixedSize[0]);
  const taskFixed2Meta = new FixedMeta(cfb.stream(P, 'TBkndTask', 'Fixed2Meta'), v12 ? [86] : [92, 93, 94, 95, 96], taskFixed);
  const taskFixed2 = FixedData.fromMeta(taskFixed2Meta, cfb.stream(P, 'TBkndTask', 'Fixed2Data'));

  // Unique ID -> record index, newest record winning (MPP14Reader.createTaskMap).
  const taskMap = new Map<number, number | null>();
  const uidOffset = tfm.offset('task', 'UNIQUE_ID');
  for (let loop = taskFixedMeta.adjustedCount - 1; loop > 2; loop--) {
    const data = taskFixed.item(loop);
    const data2 = taskFixed2.item(loop);
    if (!data || !data2) continue;
    const flags = i32(taskFixedMeta.item(loop)!, 0);
    if (flags & 0x02) {
      const uid = u16(data, 0);
      if (!taskMap.has(uid)) taskMap.set(uid, null);
    } else if (data.length === NULL_TASK_BLOCK_SIZE) {
      const uid = i32(data, 0);
      if (!taskMap.has(uid)) taskMap.set(uid, loop);
    } else {
      const max = tfm.maxFixedSize[0];
      if (max === 0 || Math.trunc((data.length * 100) / max) > 75) {
        const uid = i32(data, uidOffset);
        if (!taskMap.has(uid) || taskVarMeta.types(uid).length) {
          if (!taskMap.has(uid) || (flags & 0x04) === 0) taskMap.set(uid, loop);
        }
      }
    }
  }

  let metaFlags: { milestone: [number, number] };
  let meta2Flags: { active: [number, number]; manual: [number, number] };
  if (appVersion <= PROJECT_2010) {
    metaFlags = { milestone: [8, 0x20] };
    meta2Flags = { active: [8, 0x04], manual: [8, 0x08] };
  } else {
    metaFlags = { milestone: [10, 0x02] };
    meta2Flags = { active: [8, 0x40], manual: [8, 0x80] };
  }
  const bit = (d: Uint8Array | null, [o, m]: [number, number]) => !!d && (i32(d, o) & m) !== 0;

  const byUid = new Map<number, Task>();
  const byId = new Map<number, Task>();
  const taskOrder: [bigint, number][] = [];
  const nullTaskOrder = new Map<number, number>();
  const addBlank = (data: Uint8Array) => {
    const id = i32(data, 4);
    if (nullTaskOrder.has(id)) return;
    const t = emptyTask(i32(data, 0));
    t.id = id;
    t.blank = true;
    byUid.set(t.uniqueId, t);
    byId.set(id, t);
    nullTaskOrder.set(id, t.uniqueId);
  };
  const remove = (t: Task) => {
    byUid.delete(t.uniqueId);
    if (byId.get(t.id) === t) byId.delete(t.id);
  };

  for (const uid of [...taskMap.keys()].sort((a, b) => a - b)) {
    const offset = taskMap.get(uid);
    if (!taskFixed.isValid(offset)) continue;
    let data = taskFixed.item(offset)!;
    const metaData = taskFixedMeta.item(offset!)!;
    const id = i32(data, tfm.offset('task', 'ID'));
    if (data.length === NULL_TASK_BLOCK_SIZE) {
      addBlank(data);
      continue;
    }
    if (data.length < tfm.maxFixedSize[0]) {
      const padded = new Uint8Array(tfm.maxFixedSize[0] + 8);
      padded.set(data);
      data = padded;
    }
    const metaData2 = taskFixed2Meta.item(offset!);
    const data2 = taskFixed2.item(offset);
    const existing = byId.get(id);
    if (existing) {
      if (!taskVarMeta.has(uid)) continue;
      if (!existing.name) remove(existing);
    }
    const f = tfm.readAll('task', uid, [data, data2], taskVar);
    const t = emptyTask(uid);
    t.id = id;
    // Manual scheduling and inactive tasks arrived with Project 2010.
    t.manual = !v12 && bit(metaData2, meta2Flags.manual);
    t.active = v12 || !metaData2 || bit(metaData2, meta2Flags.active) || f.get('ACTIVE') === true;
    t.milestone = bit(metaData, metaFlags.milestone);
    t.estimated = (u16(data, tfm.offset('task', 'ACTUAL_DURATION_UNITS')) & 0x20) !== 0;
    if (!fillTask(t, f)) {
      addBlank(data);
      continue;
    }
    if (byUid.has(uid)) remove(byUid.get(uid)!);
    byUid.set(uid, t);
    byId.set(id, t);
    if (!data2 || data2.length < 24) nullTaskOrder.set(t.id, uid);
    else taskOrder.push([i64big(data2, 16), uid]);
  }

  // Task IDs come from the order of the records, with blank rows slotted in (MPP14Reader.postProcessTasks).
  const ordered = new Map<number, number>();
  const step = (Math.floor(nullTaskOrder.size / 1000) + 1) * 2000;
  let nextId = byUid.has(0) ? 0 : step;
  taskOrder.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [, uid] of taskOrder) {
    ordered.set(nextId, uid);
    nextId += step;
  }
  let inserted = 0;
  const offsets = new Map<number, number>();
  for (const [idValue, uid] of [...nullTaskOrder.entries()].sort((a, b) => a[0] - b[0])) {
    const base = (idValue - inserted) * step;
    let target = base;
    const previous = offsets.get(base);
    let off = previous === undefined ? 0 : previous + 1;
    inserted++;
    while (ordered.has(target)) {
      off++;
      if (off === step) throw new ProjectFileError('The task order could not be worked out: the file may be damaged.', 'format');
      target = base - (step - off);
    }
    offsets.set(base, off);
    ordered.set(target, uid);
  }
  nextId = byUid.has(0) ? 0 : 1;
  for (const [, uid] of [...ordered.entries()].sort((a, b) => a[0] - b[0])) {
    const t = byUid.get(uid);
    if (t) t.id = nextId;
    nextId++;
  }

  /* ── Links between tasks (ConstraintFactory) ────────────────────────── */

  const consMeta = new FixedMeta(cfb.stream(P, 'TBkndCons', 'FixedMeta'), [10]);
  const consData = FixedData.fromMetaFixedSize(consMeta, 20, xored(P, 'TBkndCons', 'FixedData'));
  const durOffset = appVersion > PROJECT_2010 ? 14 : 16;
  const unitsOffset = appVersion > PROJECT_2010 ? 18 : 14;
  for (let loop = 0; loop < consMeta.adjustedCount; loop++) {
    const m = consMeta.item(loop);
    if (!m || u16(m, 0) !== 0) continue;
    const index = consData.indexOfOffset(i32(m, 4));
    const d = index === -1 ? null : consData.item(index);
    if (!d || d.length < 14) continue;
    const from = i32(d, 4);
    const to = i32(d, 8);
    if (!from || !to || from === to) continue;
    const pred = byUid.get(from);
    const succ = byUid.get(to);
    if (!pred || !succ || pred.blank || succ.blank) continue;
    const rel: Relation = { task: from, type: RELATION_TYPES[u16(d, 12)] ?? 'FS', lag: adjustedDuration(cal, i32(d, durOffset), durationUnits(u16(d, unitsOffset))) };
    if (!succ.predecessors.some((r) => r.task === rel.task && r.type === rel.type)) succ.predecessors.push(rel);
  }

  /* ── Resources (MPP14Reader.processResourceData) ─────────────────────── */

  const rfm = fieldMap(KEY.RESOURCE_FIELD_MAP, KEY.RESOURCE_FIELD_MAP2);
  const rscVarMeta = new VarMeta(cfb.stream(P, 'TBkndRsc', 'VarMeta'));
  const rscVar = new Var2Data(rscVarMeta, cfb.stream(P, 'TBkndRsc', 'Var2Data'));
  const rscFixedMeta = new FixedMeta(cfb.stream(P, 'TBkndRsc', 'FixedMeta'), [37]);
  const rscFixed = FixedData.fromMeta(rscFixedMeta, xored(P, 'TBkndRsc', 'FixedData'));
  const rscFixed2Meta = new FixedMeta(cfb.stream(P, 'TBkndRsc', 'Fixed2Meta'), v12 ? [49] : [50, 51], rscFixed);
  const rscFixed2 = FixedData.fromMeta(rscFixed2Meta, xored(P, 'TBkndRsc', 'Fixed2Data'));
  const rscMap = new Map<number, number>();
  const rscUidOffset = rfm.offset('resource', 'UNIQUE_ID');
  for (let loop = 0; loop < rscFixedMeta.adjustedCount; loop++) {
    const d = rscFixed.item(loop);
    if (!d || d.length < rfm.maxFixedSize[0]) continue;
    const uid = u16(d, rscUidOffset);
    if (!rscMap.has(uid)) rscMap.set(uid, loop);
  }
  const [typeOffset, typeMask] = appVersion > PROJECT_2010 ? [12, 0x10] : [9, 0x02];
  const resources = new Map<number, Resource>();
  for (const uid of rscVarMeta.ids()) {
    const offset = rscMap.get(uid);
    if (offset === undefined) continue;
    const data = rscFixed.item(offset)!;
    const metaData = rscFixedMeta.item(offset)!;
    const metaData2 = rscFixed2Meta.item(offset);
    const f = rfm.readAll('resource', uid, [data, rscFixed2.item(offset)], rscVar);
    const type: Resource['type'] = metaData[typeOffset] & typeMask ? 'Work' : metaData2 && metaData2[8] & 0x10 ? 'Cost' : 'Material';
    const maxUnits = type === 'Work' ? num(f.get('MAX_UNITS')) : null;
    // Rates are stored per hour; Project shows them per the resource's own unit (elapsed minutes means a flat rate).
    let rateUnits = (f.get('STANDARD_RATE_UNITS') as TimeUnit | null) ?? 'h';
    if (rateUnits === 'em' || type !== 'Work') rateUnits = 'h';
    const rate = num(f.get('STANDARD_RATE'));
    const r: Resource = {
      uniqueId: uid,
      id: i32(data, rfm.offset('resource', 'ID')),
      name: str(f.get('NAME')),
      initials: str(f.get('INITIALS')),
      group: str(f.get('GROUP')),
      email: str(f.get('EMAIL_ADDRESS')),
      type,
      maxUnits: maxUnits === null ? null : maxUnits / 100,
      standardRate: rate === null ? null : Math.round(rateFromHours(rate, rateUnits, cal) * 10000) / 10000,
      rateUnits,
      cost: num(f.get('COST')),
      work: num(f.get('WORK')),
      notes: str(f.get('NOTES')),
      calendar: calendars.byResource.get(uid) ?? null,
    };
    if (!r.name && !r.id) continue;
    resources.set(uid, r);
  }
  project.resources = [...resources.values()].filter((r) => r.id > 0 || r.name).sort((a, b) => a.id - b.id);
  finishCalendars(project);

  /* ── Assignments (ResourceAssignmentFactory) ────────────────────────── */

  const afm = fieldMap(KEY.ASSIGNMENT_FIELD_MAP, KEY.ASSIGNMENT_FIELD_MAP2);
  const assnVarMeta = new VarMeta(cfb.stream(P, 'TBkndAssn', 'VarMeta'));
  const assnVar = new Var2Data(assnVarMeta, cfb.stream(P, 'TBkndAssn', 'Var2Data'));
  const assnMeta = new FixedMeta(cfb.stream(P, 'TBkndAssn', 'FixedMeta'), [34]);
  // Project 2007 sizes assignment records from their metadata; 2010 and later use a fixed 110 bytes.
  const assnFixed = v12 ? FixedData.fromMeta(assnMeta, xored(P, 'TBkndAssn', 'FixedData')) : FixedData.uniform(110, xored(P, 'TBkndAssn', 'FixedData'));
  const assnFixed2 = FixedData.uniform(48, xored(P, 'TBkndAssn', 'Fixed2Data'));
  const seen = new Set<string>();
  for (let loop = 0; loop < assnMeta.adjustedCount; loop++) {
    const m = assnMeta.item(loop);
    if (!m || m[0] !== 0) continue;
    const index = assnFixed.indexOfOffset(i32(m, 4));
    let data = assnFixed.item(index);
    if (!data) continue;
    if (data.length < afm.maxFixedSize[0]) {
      const padded = new Uint8Array(afm.maxFixedSize[0]);
      padded.set(data);
      data = padded;
    }
    const id = i32(data, afm.offset('assignment', 'UNIQUE_ID'));
    if (!assnVarMeta.has(id)) continue;
    const taskUid = i32(data, afm.offset('assignment', 'TASK_UNIQUE_ID'));
    const resourceUid = i32(data, afm.offset('assignment', 'RESOURCE_UNIQUE_ID'));
    if (!byUid.has(taskUid) || resourceUid === NULL_RESOURCE || !resources.has(resourceUid)) continue;
    const key = `${taskUid}/${resourceUid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = afm.readAll('assignment', id, [data, assnFixed2.item(index)], assnVar);
    const units = num(f.get('ASSIGNMENT_UNITS'));
    const a: Assignment = { task: taskUid, resource: resourceUid, units: units === null ? null : units / 100, work: num(f.get('WORK')), cost: num(f.get('COST')), start: date(f.get('START')), finish: date(f.get('FINISH')) };
    project.assignments.push(a);
  }

  /* ── The outline ─────────────────────────────────────────────────────── */

  const all = [...byUid.values()];
  updateStructure(all);
  for (const a of project.assignments) {
    const t = byUid.get(a.task);
    const r = resources.get(a.resource);
    if (!t || !r) continue;
    const label = r.name + (a.units !== null && Math.abs(a.units - 1) > 0.001 && r.type === 'Work' ? `[${Math.round(a.units * 100)}%]` : '');
    t.resourceNames = t.resourceNames ? `${t.resourceNames}, ${label}` : label;
  }
  project.summary = all.find((t) => t.id === 0) ?? null;
  project.tasks = all.filter((t) => t.id !== 0);
  if (!project.title && project.summary?.name) project.title = project.summary.name;
  return project;
}

/**
 * A task's values from its fields, as MPP9Reader, MPP12Reader and
 * MPP14Reader set them. Returns false for a record that is really a blank
 * row: no name, and no dates or creation date.
 */
function fillTask(t: Task, f: Map<string, Value>): boolean {
  t.name = str(f.get('NAME'));
  t.outlineLevel = num(f.get('OUTLINE_LEVEL')) ?? 1;
  t.wbs = str(f.get('WBS'));
  t.start = date(f.get('START'));
  t.finish = date(f.get('FINISH'));
  t.duration = dur(f.get('DURATION'));
  const auto = !t.manual;
  if (t.start === null || (f.get('SCHEDULED_START') != null && auto)) t.start = date(f.get('SCHEDULED_START')) ?? t.start;
  if (t.finish === null || (f.get('SCHEDULED_FINISH') != null && auto)) t.finish = date(f.get('SCHEDULED_FINISH')) ?? t.finish;
  if (t.duration === null || (f.get('SCHEDULED_DURATION') != null && auto)) t.duration = dur(f.get('SCHEDULED_DURATION')) ?? t.duration;
  t.constraint = str(f.get('CONSTRAINT_TYPE'));
  t.constraintDate = date(f.get('CONSTRAINT_DATE'));
  const lateStart = date(f.get('LATE_START'));
  const lateFinish = date(f.get('LATE_FINISH'));
  if (t.constraint === 'As Late As Possible') {
    if (lateStart !== null && (t.start === null || t.start < lateStart)) t.start = lateStart;
    if (lateFinish !== null && (t.finish === null || t.finish < lateFinish)) t.finish = lateFinish;
  } else if ((t.constraint === 'Start No Later Than' || t.constraint === 'Finish No Later Than') && t.finish !== null && t.start !== null && t.finish < t.start) {
    t.finish = lateFinish;
  }
  if (t.manual) t.duration = dur(f.get('MANUAL_DURATION')) ?? t.duration;
  t.actualStart = date(f.get('ACTUAL_START'));
  t.actualFinish = date(f.get('ACTUAL_FINISH'));
  // Project 2010 keeps the baseline in its "estimated baseline" fields (MPPReader.copyEstimatedBaselineFields).
  t.baselineStart = date(f.get('BASELINE_START')) ?? date(f.get('BASELINE_ESTIMATED_START'));
  t.baselineFinish = date(f.get('BASELINE_FINISH')) ?? date(f.get('BASELINE_ESTIMATED_FINISH'));
  t.percentComplete = num(f.get('PERCENT_COMPLETE')) ?? 0;
  t.work = num(f.get('WORK'));
  t.cost = num(f.get('COST'));
  t.priority = num(f.get('PRIORITY'));
  t.notes = str(f.get('NOTES'));
  // Project works "critical" out from the slack; with no stored flag, a task that cannot finish any later is critical.
  t.critical = f.get('CRITICAL') === true || (t.percentComplete < 100 && lateFinish !== null && t.finish !== null && lateFinish <= t.finish);
  const created = date(f.get('CREATED'));
  if (!t.name && (t.start === null || t.finish === null || created === null)) return false;
  t.extra = extras(f, TASK_MODELLED);
  return true;
}

/* ── Project 2000-2003 (MPP9Reader) ──────────────────────────────────── */

const MPP9_NULL_TASK_BLOCK_SIZE = 8;

function readMpp9(cfb: Cfb): Project {
  const rootProps = new Props(cfb.stream('Props9'));
  const passwordFlag = rootProps.byte(KEY.PASSWORD_FLAG);
  if (passwordFlag & 1 && rootProps.bytes(KEY.PROTECTION_PASSWORD_HASH)) throw new ProjectFileError('This project is password protected.', 'password');
  const code = rootProps.byte(KEY.ENCRYPTION_CODE);
  const mask = passwordFlag !== 0 ? (code === 0 ? 0 : 0xff - code) : 0;
  const xored = (...path: string[]) => {
    const s = cfb.stream(...path);
    if (!s || !mask) return s;
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] ^ mask;
    return out;
  };

  const P = '   19';
  const props = new Props(xored(P, 'Props'));
  if (!props.map.size) throw new ProjectFileError('The project’s properties are missing: the file may be damaged.', 'format');
  const minutesPerDay = props.int(KEY.MINUTES_PER_DAY) || 480;
  const minutesPerWeek = props.int(KEY.MINUTES_PER_WEEK) || 2400;
  const daysPerMonth = props.short(KEY.DAYS_PER_MONTH) || 20;
  const defaultUnits = durationUnits(props.short(KEY.DURATION_UNITS));
  const cal = { minutesPerDay, minutesPerWeek, daysPerMonth, defaultUnits };
  const summary = propertySet(cfb.stream('\u0005SummaryInformation'));
  const docSummary = propertySet(cfb.stream('\u0005DocumentSummaryInformation'));
  const project: Project = {
    format: 'Microsoft Project 2000 to 2003 (.mpp)',
    title: summary.get(2) || props.string(KEY.TITLE),
    subject: summary.get(3) || props.string(KEY.SUBJECT),
    author: summary.get(4) || props.string(KEY.AUTHOR),
    comments: summary.get(6) || props.string(KEY.COMMENTS),
    manager: docSummary.get(14) || props.string(KEY.MANAGER),
    company: docSummary.get(15) || props.string(KEY.COMPANY),
    start: props.timestamp(KEY.PROJECT_START_DATE),
    finish: props.timestamp(KEY.PROJECT_FINISH_DATE),
    statusDate: props.timestamp(KEY.STATUS_DATE),
    currencySymbol: props.string(KEY.CURRENCY_SYMBOL) || '',
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

  const calendars = readMppCalendars({
    stream: (name) => (name === 'FixedData' ? xored(P, 'TBkndCal', name) : cfb.stream(P, 'TBkndCal', name)),
    props,
    format: 9,
    appVersion: 9,
  });
  project.calendars = calendars.calendars;
  project.calendar = calendars.calendar;

  // The file's own field map when it has one, otherwise FieldMap9's layout.
  const fieldMap = (cls: FieldClass, defaults: readonly DefaultItem[], ...keys: number[]) => {
    const map = new FieldMap(cal, { mpp14: false, typeAsVarKey: false });
    for (const k of keys) {
      const d = props.bytes(k);
      if (d) {
        map.load(d);
        return map;
      }
    }
    map.loadDefaults(cls, defaults);
    return map;
  };

  /* Tasks (MPP9Reader.processTaskData): one fixed-data record each, IDs as stored. */
  const tfm = fieldMap('task', TASK_DEFAULTS_9, KEY.TASK_FIELD_MAP, KEY.TASK_FIELD_MAP2);
  const taskVarMeta = new VarMeta9(cfb.stream(P, 'TBkndTask', 'VarMeta'));
  const taskVar = new Var2Data(taskVarMeta, cfb.stream(P, 'TBkndTask', 'Var2Data'));
  const taskFixedMeta = new FixedMeta(cfb.stream(P, 'TBkndTask', 'FixedMeta'), [47]);
  const taskFixed = FixedData.fromMeta(taskFixedMeta, xored(P, 'TBkndTask', 'FixedData'), 768, tfm.maxFixedSize[0]);

  const taskMap = new Map<number, number | null>();
  const uidOffset = Math.max(0, tfm.offset('task', 'UNIQUE_ID'));
  for (let loop = taskFixedMeta.adjustedCount - 1; loop > 2; loop--) {
    const data = taskFixed.item(loop);
    if (!data) continue;
    const flags = i32(taskFixedMeta.item(loop)!, 0);
    if (flags & 0x02) {
      const uid = u16(data, 0);
      if (!taskMap.has(uid)) taskMap.set(uid, null);
    } else if (data.length === MPP9_NULL_TASK_BLOCK_SIZE) {
      const uid = i32(data, 0);
      if (!taskMap.has(uid)) taskMap.set(uid, loop);
    } else {
      const max = tfm.maxFixedSize[0];
      if (max === 0 || Math.trunc((data.length * 100) / max) > 75) {
        const uid = i32(data, uidOffset);
        if (!taskMap.has(uid) || taskVarMeta.types(uid).length) taskMap.set(uid, loop);
      }
    }
  }

  const byUid = new Map<number, Task>();
  const byId = new Map<number, Task>();
  const addBlank = (uid: number, id: number) => {
    const t = emptyTask(uid);
    t.id = id;
    t.blank = true;
    byUid.set(uid, t);
    byId.set(id, t);
  };
  const idOffset = tfm.offset('task', 'ID');
  const unitsOffset = tfm.offset('task', 'ACTUAL_DURATION_UNITS');
  for (const uid of [...taskMap.keys()].sort((a, b) => a - b)) {
    const offset = taskMap.get(uid);
    if (!taskFixed.isValid(offset)) continue;
    const data = taskFixed.item(offset)!;
    if (data.length === MPP9_NULL_TASK_BLOCK_SIZE) {
      addBlank(u16(data, 0), u16(data, 4));
      continue;
    }
    if (data.length < tfm.maxFixedSize[0] || idOffset < 0 || data.length < idOffset + 4) continue;
    if (uid !== 0 && !taskVarMeta.has(uid)) continue;
    const id = i32(data, idOffset);
    const existing = byId.get(id);
    if (existing) {
      if (!taskVarMeta.has(uid)) continue;
      if (!existing.name) {
        byUid.delete(existing.uniqueId);
        byId.delete(id);
      }
    }
    const metaData = taskFixedMeta.item(offset!)!;
    const f = tfm.readAll('task', uid, [data], taskVar);
    const t = emptyTask(uid);
    t.id = id;
    t.milestone = (metaData[8] & 0x20) !== 0;
    t.estimated = unitsOffset >= 0 && (u16(data, unitsOffset) & 0x20) !== 0;
    if (!fillTask(t, f)) {
      addBlank(i32(data, 0), i32(data, 4));
      continue;
    }
    byUid.set(uid, t);
    byId.set(id, t);
  }

  /* Links (ConstraintFactory). */
  const consMeta = new FixedMeta(cfb.stream(P, 'TBkndCons', 'FixedMeta'), [10]);
  const consData = FixedData.fromMetaFixedSize(consMeta, 20, xored(P, 'TBkndCons', 'FixedData'));
  for (let loop = 0; loop < consMeta.adjustedCount; loop++) {
    const m = consMeta.item(loop);
    if (!m || u16(m, 0) !== 0) continue;
    const index = consData.indexOfOffset(i32(m, 4));
    const d = index === -1 ? null : consData.item(index);
    if (!d || d.length < 14) continue;
    const from = i32(d, 4);
    const to = i32(d, 8);
    if (!from || !to || from === to) continue;
    const pred = byUid.get(from);
    const succ = byUid.get(to);
    if (!pred || !succ || pred.blank || succ.blank) continue;
    const rel: Relation = { task: from, type: RELATION_TYPES[u16(d, 12)] ?? 'FS', lag: adjustedDuration(cal, i32(d, 16), durationUnits(u16(d, 14))) };
    if (!succ.predecessors.some((r) => r.task === rel.task && r.type === rel.type)) succ.predecessors.push(rel);
  }

  /* Resources (MPP9Reader.processResourceData). */
  const rfm = fieldMap('resource', RESOURCE_DEFAULTS_9, KEY.RESOURCE_FIELD_MAP, KEY.RESOURCE_FIELD_MAP2);
  const rscVarMeta = new VarMeta9(cfb.stream(P, 'TBkndRsc', 'VarMeta'));
  const rscVar = new Var2Data(rscVarMeta, cfb.stream(P, 'TBkndRsc', 'Var2Data'));
  const rscFixedMeta = new FixedMeta(cfb.stream(P, 'TBkndRsc', 'FixedMeta'), [37]);
  const rscFixed = FixedData.fromMeta(rscFixedMeta, xored(P, 'TBkndRsc', 'FixedData'));
  const rscMap = new Map<number, number>();
  for (let loop = 0; loop < rscFixedMeta.adjustedCount; loop++) {
    const d = rscFixed.item(loop);
    if (!d || d.length < Math.max(8, rfm.maxFixedSize[0])) continue;
    if (i32(rscFixedMeta.item(loop)!, 0) & 0x02) continue;
    rscMap.set(u16(d, 0), loop);
  }
  const resources = new Map<number, Resource>();
  for (const uid of rscVarMeta.ids()) {
    const offset = rscMap.get(uid);
    if (offset === undefined) continue;
    const data = rscFixed.item(offset)!;
    const metaData = rscFixedMeta.item(offset)!;
    const f = rfm.readAll('resource', uid, [data], rscVar);
    // Project 2000-2003 has work and material resources only; cost resources came with 2007.
    const type: Resource['type'] = metaData[9] & 0x02 ? 'Work' : 'Material';
    const maxUnits = type === 'Work' ? num(f.get('MAX_UNITS')) : null;
    let rateUnits = (f.get('STANDARD_RATE_UNITS') as TimeUnit | null) ?? 'h';
    if (rateUnits === 'em' || type !== 'Work') rateUnits = 'h';
    const rate = num(f.get('STANDARD_RATE'));
    const r: Resource = {
      uniqueId: uid,
      id: i32(data, 4),
      name: str(f.get('NAME')),
      initials: str(f.get('INITIALS')),
      group: str(f.get('GROUP')),
      email: str(f.get('EMAIL_ADDRESS')),
      type,
      maxUnits: maxUnits === null ? null : maxUnits / 100,
      standardRate: rate === null ? null : Math.round(rateFromHours(rate, rateUnits, cal) * 10000) / 10000,
      rateUnits,
      cost: num(f.get('COST')),
      work: num(f.get('WORK')),
      notes: str(f.get('NOTES')),
      calendar: calendars.byResource.get(uid) ?? null,
    };
    if (!r.name && !r.id) continue;
    resources.set(uid, r);
  }
  project.resources = [...resources.values()].filter((r) => r.id > 0 || r.name).sort((a, b) => a.id - b.id);
  finishCalendars(project);

  /* Assignments (MPP9Reader.processAssignmentData, ResourceAssignmentFactory). */
  const afm = fieldMap('assignment', ASSIGNMENT_DEFAULTS_9, KEY.ASSIGNMENT_FIELD_MAP, KEY.ASSIGNMENT_FIELD_MAP2);
  const assnVarMeta = new VarMeta9(cfb.stream(P, 'TBkndAssn', 'VarMeta'));
  const assnVar = new Var2Data(assnVarMeta, cfb.stream(P, 'TBkndAssn', 'Var2Data'));
  const assnMeta = new FixedMeta(cfb.stream(P, 'TBkndAssn', 'FixedMeta'), [34]);
  let assnFixed = FixedData.uniform(142, xored(P, 'TBkndAssn', 'FixedData'));
  if (assnFixed.count !== assnMeta.adjustedCount) assnFixed = FixedData.fromMeta(assnMeta, xored(P, 'TBkndAssn', 'FixedData'));
  const seen = new Set<string>();
  for (let loop = 0; loop < assnMeta.adjustedCount; loop++) {
    const m = assnMeta.item(loop);
    if (!m || m[0] !== 0) continue;
    const index = assnFixed.indexOfOffset(i32(m, 4));
    let data = assnFixed.item(index);
    if (!data) continue;
    if (data.length < afm.maxFixedSize[0]) {
      const padded = new Uint8Array(afm.maxFixedSize[0]);
      padded.set(data);
      data = padded;
    }
    const id = i32(data, Math.max(0, afm.offset('assignment', 'UNIQUE_ID')));
    if (!assnVarMeta.has(id)) continue;
    const taskUid = i32(data, afm.offset('assignment', 'TASK_UNIQUE_ID'));
    const resourceUid = i32(data, afm.offset('assignment', 'RESOURCE_UNIQUE_ID'));
    if (!byUid.has(taskUid) || resourceUid === NULL_RESOURCE || !resources.has(resourceUid)) continue;
    const key = `${taskUid}/${resourceUid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = afm.readAll('assignment', id, [data], assnVar);
    const units = num(f.get('ASSIGNMENT_UNITS'));
    project.assignments.push({ task: taskUid, resource: resourceUid, units: units === null ? null : units / 100, work: num(f.get('WORK')), cost: num(f.get('COST')), start: date(f.get('START')), finish: date(f.get('FINISH')) });
  }

  const all = [...byUid.values()];
  updateStructure(all);
  for (const a of project.assignments) {
    const t = byUid.get(a.task);
    const r = resources.get(a.resource);
    if (!t || !r) continue;
    const label = r.name + (a.units !== null && Math.abs(a.units - 1) > 0.001 && r.type === 'Work' ? `[${Math.round(a.units * 100)}%]` : '');
    t.resourceNames = t.resourceNames ? `${t.resourceNames}, ${label}` : label;
  }
  project.summary = all.find((t) => t.id === 0) ?? null;
  project.tasks = all.filter((t) => t.id !== 0);
  if (!project.title && project.summary?.name) project.title = project.summary.name;
  return project;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

const TASK_MODELLED = new Set(['NAME', 'ID', 'UNIQUE_ID', 'OUTLINE_LEVEL', 'OUTLINE_NUMBER', 'WBS', 'START', 'FINISH', 'DURATION', 'ACTUAL_START', 'ACTUAL_FINISH', 'BASELINE_START', 'BASELINE_FINISH', 'PERCENT_COMPLETE', 'WORK', 'COST', 'PRIORITY', 'NOTES', 'CRITICAL', 'CONSTRAINT_TYPE', 'CONSTRAINT_DATE', 'SCHEDULED_START', 'SCHEDULED_FINISH', 'SCHEDULED_DURATION', 'MANUAL_DURATION', 'ACTIVE', 'SUMMARY', 'MILESTONE']);

/** Custom and other fields worth offering in "all columns" and CSV: text, numbers, flags, dates, durations, costs. */
function extras(f: Map<string, Value>, skip: Set<string>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of f) {
    if (skip.has(k) || v === null || v === '' || /_UNITS$|^TASK_FIELD_|_DATA$|GUID$/.test(k)) continue;
    if (!/^(TEXT|NUMBER|FLAG|DATE|START|FINISH|DURATION|COST|OUTLINE_CODE)\d+$|^(CONTACT|HYPERLINK|SUBJECT|DEADLINE|BASELINE_COST|BASELINE_WORK|BASELINE_DURATION|ACTUAL_COST|ACTUAL_WORK|REMAINING_DURATION|REMAINING_WORK|FREE_SLACK|TOTAL_SLACK|EARLY_START|EARLY_FINISH|LATE_START|LATE_FINISH|CREATED|TYPE|CALENDAR_UNIQUE_ID)$/.test(k)) continue;
    if (typeof v === 'object') {
      if (!v.value) continue;
      out[k] = `${Math.round(v.value * 100) / 100}${v.units}`;
    } else if (typeof v === 'number' && /DATE|START|FINISH|CREATED|DEADLINE/.test(k)) {
      out[k] = new Date(v).toISOString().slice(0, 16).replace('T', ' ');
    } else if (v !== false && v !== 0) out[k] = v;
  }
  return out;
}

function str(v: Value | undefined): string {
  return typeof v === 'string' ? v : '';
}

function num(v: Value | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function date(v: Value | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function dur(v: Value | undefined): Duration | null {
  return v && typeof v === 'object' && 'units' in v ? (v as Duration) : null;
}

/** \1CompObj: the application name ("Microsoft Project 16.0") and the file format ("MSProject.MPP14"). */
function compObj(d: Uint8Array | null): { app: string; version: number | null; format: string } {
  if (!d || d.length < 36) return { app: '', version: null, format: '' };
  let p = 28;
  const lenString = () => {
    const n = i32(d, p);
    p += 4;
    if (n <= 0 || p + n > d.length) return '';
    const s = new TextDecoder('latin1').decode(d.subarray(p, p + n - 1));
    p += n;
    return s;
  };
  const app = lenString();
  const m = /Microsoft.Project.(\d+)\.0/.exec(app);
  const format = lenString();
  return { app, version: m ? Number(m[1]) : null, format };
}

/** String properties of an OLE property set (SummaryInformation, DocumentSummaryInformation) by property ID. */
function propertySet(d: Uint8Array | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!d || d.length < 48) return out;
  const sectionOffset = i32(d, 44);
  if (sectionOffset <= 0 || sectionOffset + 8 > d.length) return out;
  const count = i32(d, sectionOffset + 4);
  let codepage = 1252;
  const entries: [number, number][] = [];
  for (let i = 0; i < count && sectionOffset + 8 + i * 8 + 8 <= d.length; i++) {
    entries.push([i32(d, sectionOffset + 8 + i * 8), i32(d, sectionOffset + 12 + i * 8)]);
  }
  for (const [pid, off] of entries) {
    if (pid === 1 && u16(d, sectionOffset + off) === 2) codepage = u16(d, sectionOffset + off + 4);
  }
  for (const [pid, off] of entries) {
    const at = sectionOffset + off;
    if (at + 8 > d.length) continue;
    const type = i32(d, at);
    const len = i32(d, at + 4);
    if (type === 0x1e && len > 0 && at + 8 + len <= d.length) {
      const raw = d.subarray(at + 8, at + 8 + len);
      let s: string;
      try {
        s = codepage === 1200 ? unicode(raw, 0) : codepage === 65001 ? new TextDecoder('utf-8').decode(raw) : new TextDecoder(`windows-${codepage}`).decode(raw);
      } catch {
        s = new TextDecoder('windows-1252').decode(raw);
      }
      out.set(pid, s.replace(/\u0000.*$/s, '').trim());
    } else if (type === 0x1f && len > 0) {
      out.set(pid, unicode(d.subarray(at + 8, at + 8 + len * 2), 0).trim());
    }
  }
  return out;
}

