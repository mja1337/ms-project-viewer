/**
 * MPX, the text exchange format of Project 4 to 98 (and still written by
 * some tools): one record per line, the record number first, fields
 * separated by a delimiter (usually a comma). Tasks and resources list
 * their fields in the order given by the "model" records 41 and 61.
 * Record and field numbers follow the MPX 4.0 specification, as used in
 * MPXJ's MPXReader (LGPL-2.1). Calendars are records 20, 25 and 26 (a base
 * calendar, its hours, its exceptions), and 55, 56 and 57 for the resource
 * before them.
 */

import { Assignment, CalendarDay, Duration, Project, ProjectCalendar, Relation, RelationType, Resource, Task, TimeUnit, WorkingTime, emptyTask, updateStructure } from './model';
import { STANDARD_HOURS } from './calendars';

const TASK_FIELD: Record<number, string> = {
  1: 'NAME', 2: 'WBS', 3: 'OUTLINE_LEVEL', 14: 'NOTES', 20: 'WORK', 30: 'COST', 40: 'DURATION', 44: 'PERCENT_COMPLETE', 50: 'START', 51: 'FINISH', 56: 'BASELINE_START', 57: 'BASELINE_FINISH',
  58: 'ACTUAL_START', 59: 'ACTUAL_FINISH', 68: 'CONSTRAINT_DATE', 70: 'PREDECESSORS', 72: 'RESOURCE_NAMES', 74: 'UNIQUE_ID_PREDECESSORS', 81: 'MILESTONE', 82: 'CRITICAL', 90: 'ID',
  91: 'CONSTRAINT_TYPE', 95: 'PRIORITY', 98: 'UNIQUE_ID', 99: 'OUTLINE_NUMBER', 120: 'SUMMARY', 15: 'CONTACT', 4: 'TEXT1', 5: 'TEXT2', 6: 'TEXT3', 7: 'TEXT4', 8: 'TEXT5',
};
const RESOURCE_FIELD: Record<number, string> = { 1: 'NAME', 2: 'INITIALS', 3: 'GROUP', 11: 'EMAIL_ADDRESS', 20: 'WORK', 30: 'COST', 40: 'ID', 41: 'MAX_UNITS', 42: 'STANDARD_RATE', 49: 'UNIQUE_ID' };
const CONSTRAINTS = ['As Soon As Possible', 'As Late As Possible', 'Must Start On', 'Must Finish On', 'Start No Earlier Than', 'Start No Later Than', 'Finish No Earlier Than', 'Finish No Later Than'];
// English, and the German, French and Spanish abbreviations localised copies of Project write.
const UNIT_WORDS: Record<string, TimeUnit> = {
  m: 'm', min: 'm', mins: 'm', em: 'em', h: 'h', hr: 'h', hrs: 'h', eh: 'eh', d: 'd', day: 'd', days: 'd', ed: 'ed', w: 'w', wk: 'w', wks: 'w', ew: 'ew', mo: 'mo', mon: 'mo', emo: 'emo', y: 'y', ey: 'ey',
  t: 'd', ft: 'ed', fh: 'eh', fmin: 'em', wo: 'w', fw: 'ew', mt: 'mo', j: 'd', jr: 'd', s: 'w', sem: 'w', ms: 'mo', di: 'd', dia: 'd', dias: 'd',
};
const YES = /^(yes|1|true|ja|oui|si|sí|sim|da)$/i;

export function isMpx(src: string): boolean {
  return /^MPX[,;\t]/.test(src);
}

export function readMpx(src: string): Project {
  const delim = src[3];
  const lines = src.split(/\r?\n/);
  let dateOrder = 0; // 0 month-day-year, 1 day-month-year, 2 year-month-day
  let decimal = '.';
  let dayStart = 480;
  let minutesPerDay = 480;
  let minutesPerWeek = 2400;
  let defaultUnits: TimeUnit = 'd';
  let taskModel: string[] = [];
  let resourceModel: string[] = [];
  const project: Project = {
    format: 'MPX', title: '', subject: '', author: '', manager: '', company: '', comments: '', start: null, finish: null, statusDate: null, currencySymbol: '',
    minutesPerDay, minutesPerWeek, daysPerMonth: 20, summary: null, tasks: [], resources: [], assignments: [], calendars: [], calendar: null, warnings: [],
  };
  const tasks: Task[] = [];
  const resources: Resource[] = [];
  const pendingAssignments: { task: Task; resourceId: number; units: number | null; work: Duration | null; start: number | null; finish: number | null; cost: number | null }[] = [];
  let lastTask: Task | null = null;
  let lastResource: Resource | null = null;
  let lastCalendar: ProjectCalendar | null = null;
  let projectCalendarName = '';
  const calendarBases = new Map<ProjectCalendar, string>();

  /** "8:00", "08:00", "8:00 AM", "17:00": minutes from midnight; an end of 0:00 or 24:00 is midnight. */
  const clock = (v: string | undefined, end: boolean): number | null => {
    const m = /^(\d{1,2})[:.](\d{2})\s*([ap])?/i.exec((v ?? '').trim());
    if (!m) return null;
    let h = +m[1];
    if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
    const t = h * 60 + +m[2];
    return end && (t === 0 || t === 1440) ? 1440 : t % 1440;
  };
  const periods = (f: string[], from: number): WorkingTime[] => {
    const out: WorkingTime[] = [];
    for (let i = from; i + 1 < from + 6; i += 2) {
      const start = clock(f[i], false);
      const end = clock(f[i + 1], true);
      if (start !== null && end !== null) out.push({ start, end });
    }
    return out;
  };
  /** Day types 0 (not working), 1 (working) and 2 (as the base calendar), Sunday first. */
  const dayTypes = (f: string[], base: boolean): CalendarDay[] =>
    Array.from({ length: 7 }, (_, i) => {
      const v = f[i + 2] ?? '';
      if (v === '1') return { type: 'working', hours: [] };
      if (v === '0') return { type: 'nonworking', hours: [] };
      return base ? (i === 0 || i === 6 ? { type: 'nonworking', hours: [] } : { type: 'working', hours: [] }) : { type: 'default', hours: [] };
    });
  const dayStartOf = (v: string | undefined) => {
    const ms = date(v ?? '');
    return ms === null ? null : Math.floor(ms / 86400000) * 86400000;
  };

  /**
   * "Mon 16/06/08", "Di 07.01.03 08:00", "1/2/2006 8:00am": an optional weekday, the date, an optional time.
   * Files saved with dates only put starts at the working day's start and finishes at its end.
   */
  const date = (v: string, end = false): number | null => {
    const m = /^(?:[^\d\s]+\.?\s+)?(\d{1,4})[^\d](\d{1,2})[^\d](\d{1,4})(?:\s+(\d{1,2})[:.](\d{2})\s*([ap]m?)?)?/i.exec(v.trim());
    if (!m) return null;
    let [y, mo, d] = dateOrder === 1 ? [+m[3], +m[2], +m[1]] : dateOrder === 2 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[1], +m[2]];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (m[4] === undefined) return Date.UTC(y, mo - 1, d) + (end ? Math.max(dayStart + minutesPerDay + 60, 17 * 60) : dayStart) * 60000;
    let h = +m[4];
    if (m[6]) h = (h % 12) + (/^p/i.test(m[6]) ? 12 : 0);
    return Date.UTC(y, mo - 1, d, h, +(m[5] ?? 0));
  };
  const duration = (v: string): Duration | null => {
    const m = /^(-?[\d.,]+)\s*([a-z]*)\??$/i.exec(v.trim());
    if (!m) return null;
    return { value: number(m[1]) ?? 0, units: UNIT_WORDS[m[2].toLowerCase()] ?? defaultUnits };
  };
  const hoursOf = (d: Duration | null): number | null => {
    if (!d) return null;
    const perDay = minutesPerDay / 60;
    const f: Partial<Record<TimeUnit, number>> = { m: 1 / 60, em: 1 / 60, h: 1, eh: 1, d: perDay, ed: 24, w: minutesPerWeek / 60, ew: 168, mo: perDay * 20, emo: 720 };
    return d.value * (f[d.units] ?? 1);
  };
  /** A number written with the file's decimal separator, ignoring currency signs and thousands separators. */
  const number = (v: string): number | null => {
    let clean = '';
    for (const c of v) if ((c >= '0' && c <= '9') || c === '-') clean += c;
    else if (c === decimal) clean += '.';
    const n = Number(clean);
    return v.trim() === '' || clean === '' || Number.isNaN(n) ? null : n;
  };
  const money = number;
  /** Units are fractions (0.5 = 50%) unless written with a percent sign. */
  const units = (v: string): number | null => {
    const n = number(v);
    return n === null ? null : /%/.test(v) ? n / 100 : n;
  };
  const idOf = (v: string | undefined, fallback: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : fallback);

  for (const line of lines) {
    if (!line.trim()) continue;
    const f = splitRecord(line, delim);
    const rec = Number(f[0]);
    if (f[0] === 'MPX') continue;
    switch (rec) {
      case 11:
        defaultUnits = UNIT_WORDS[['m', 'h', 'd', 'w'][Number(f[1])] ?? 'd'] ?? 'd';
        minutesPerDay = Math.round((number(f[4] ?? '') || 8) * 60);
        minutesPerWeek = Math.round((number(f[5] ?? '') || 40) * 60);
        break;
      case 12:
        dateOrder = Number(f[1]) || 0;
        if (Number(f[3])) dayStart = Number(f[3]);
        break;
      case 10:
        project.currencySymbol = f[1] ?? '';
        decimal = f[5] || '.';
        break;
      case 20:
      case 55: {
        const base = rec === 20;
        if (!base && !lastResource) break;
        const c: ProjectCalendar = { uniqueId: project.calendars.length + 1, name: base ? f[1] ?? '' : lastResource!.name, parent: null, resource: base ? null : lastResource!.uniqueId, days: dayTypes(f, base), exceptions: [], weeks: [] };
        if (!base) {
          calendarBases.set(c, f[1] ?? '');
          lastResource!.calendar = c.uniqueId;
        }
        project.calendars.push(c);
        lastCalendar = c;
        break;
      }
      case 25:
      case 56: {
        const day = Number(f[1]);
        if (!lastCalendar || !(day >= 1 && day <= 7)) break;
        const hours = periods(f, 2);
        lastCalendar.days[day - 1] = hours.length ? { type: 'working', hours } : { type: 'nonworking', hours: [] };
        break;
      }
      case 26:
      case 57: {
        if (!lastCalendar) break;
        const from = dayStartOf(f[1]);
        // A one-day exception is sometimes written with only its first date.
        const to = dayStartOf(f[2]) ?? from;
        if (from === null || to === null) break;
        lastCalendar.exceptions.push({ name: '', from, to, hours: f[3] === '1' ? periods(f, 4) : [], recurrence: '', dates: null });
        break;
      }
      case 30:
        projectCalendarName = f[4] ?? '';
        project.title = f[1] ?? '';
        project.company = f[2] ?? '';
        project.manager = f[3] ?? '';
        project.start = date(f[5] ?? '');
        project.finish = date(f[6] ?? '', true);
        project.comments = f[9] ?? '';
        break;
      case 41:
        resourceModel = f.slice(1).map((x) => RESOURCE_FIELD[Number(x)] ?? '');
        break;
      case 61:
        taskModel = f.slice(1).map((x) => TASK_FIELD[Number(x)] ?? '');
        break;
      case 50: {
        const v = fields(resourceModel, f);
        lastResource = {
          uniqueId: idOf(v['UNIQUE_ID'] ?? v['ID'], resources.length + 1),
          id: idOf(v['ID'], resources.length + 1),
          name: v['NAME'] ?? '',
          initials: v['INITIALS'] ?? '',
          group: v['GROUP'] ?? '',
          email: v['EMAIL_ADDRESS'] ?? '',
          type: 'Work',
          maxUnits: units(v['MAX_UNITS'] ?? ''),
          standardRate: money(v['STANDARD_RATE'] ?? ''),
          rateUnits: (UNIT_WORDS[(/\/([a-z]+)/i.exec(v['STANDARD_RATE'] ?? '')?.[1] ?? 'h').toLowerCase()] ?? 'h') as TimeUnit,
          cost: money(v['COST'] ?? ''),
          work: hoursOf(duration(v['WORK'] ?? '')),
          notes: '',
          calendar: null,
        };
        resources.push(lastResource);
        break;
      }
      case 51:
        if (lastResource) lastResource.notes = (f[1] ?? '').replace(/\x7f/g, '\n');
        break;
      case 70: {
        const v = fields(taskModel, f);
        const t = emptyTask(idOf(v['UNIQUE_ID'] ?? v['ID'], tasks.length + 1));
        t.id = idOf(v['ID'], tasks.length + 1);
        t.name = v['NAME'] ?? '';
        t.wbs = v['WBS'] ?? '';
        t.outlineLevel = Number(v['OUTLINE_LEVEL']) || 1;
        t.duration = duration(v['DURATION'] ?? '');
        t.estimated = /\?$/.test(v['DURATION'] ?? '');
        t.start = date(v['START'] ?? '');
        t.finish = date(v['FINISH'] ?? '', true);
        // A zero-length task (a milestone) finishes when it starts.
        if (t.duration && t.duration.value === 0 && t.start !== null && t.finish !== null && t.finish > t.start && t.finish - t.start < 86400000) t.finish = t.start;
        t.baselineStart = date(v['BASELINE_START'] ?? '');
        t.baselineFinish = date(v['BASELINE_FINISH'] ?? '', true);
        t.actualStart = date(v['ACTUAL_START'] ?? '');
        t.actualFinish = date(v['ACTUAL_FINISH'] ?? '', true);
        t.percentComplete = number(v['PERCENT_COMPLETE'] ?? '') ?? 0;
        t.work = hoursOf(duration(v['WORK'] ?? ''));
        t.cost = money(v['COST'] ?? '');
        t.milestone = YES.test(v['MILESTONE'] ?? '');
        t.critical = YES.test(v['CRITICAL'] ?? '');
        const ct = v['CONSTRAINT_TYPE'] ?? '';
        t.constraint = /^\d+$/.test(ct) ? CONSTRAINTS[Number(ct)] ?? '' : ct;
        t.constraintDate = date(v['CONSTRAINT_DATE'] ?? '');
        t.priority = v['PRIORITY'] ? Number(v['PRIORITY']) * 100 || null : null;
        t.notes = (v['NOTES'] ?? '').replace(/\x7f/g, '\n');
        t.resourceNames = v['RESOURCE_NAMES'] ?? '';
        // Predecessors as "2FS+1d,3SS": by unique ID when that column is there, else by ID (resolved below).
        const byUnique = !!v['UNIQUE_ID_PREDECESSORS'];
        for (const p of (v['UNIQUE_ID_PREDECESSORS'] || v['PREDECESSORS'] || '').split(/[,;]/)) {
          const m = /^\s*(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*[\d.]+\s*[a-z]*)?/i.exec(p);
          if (!m) continue;
          const rel: Relation & { byId?: boolean } = { task: Number(m[1]), type: (m[2]?.toUpperCase() as RelationType) || 'FS', lag: m[3] ? duration(m[3].replace(/\s/g, '').replace(/^\+/, '')) : null };
          if (!byUnique) rel.byId = true;
          t.predecessors.push(rel);
        }
        const extra: Record<string, string> = {};
        for (const k of ['CONTACT', 'TEXT1', 'TEXT2', 'TEXT3', 'TEXT4', 'TEXT5']) if (v[k]) extra[k] = v[k];
        t.extra = extra;
        tasks.push(t);
        lastTask = t;
        break;
      }
      case 71:
        if (lastTask) lastTask.notes = (f[1] ?? '').replace(/\x7f/g, '\n');
        break;
      case 75:
        if (lastTask) {
          pendingAssignments.push({ task: lastTask, resourceId: Number(f[1]), units: units(f[2] ?? ''), work: duration(f[3] ?? ''), cost: money(f[7] ?? ''), start: date(f[10] ?? ''), finish: date(f[11] ?? '', true) });
        }
        break;
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const r of t.predecessors as (Relation & { byId?: boolean })[]) {
      if (r.byId) {
        r.task = byId.get(r.task)?.uniqueId ?? r.task;
        delete r.byId;
      }
    }
  }
  updateStructure(tasks);
  const resById = new Map(resources.map((r) => [r.id, r]));
  // Tasks without a Resource Names column are named from their assignments.
  const named = new Set(tasks.filter((t) => t.resourceNames).map((t) => t.uniqueId));
  for (const a of pendingAssignments) {
    const r = resById.get(a.resourceId);
    if (!r) continue;
    const asg: Assignment = { task: a.task.uniqueId, resource: r.uniqueId, units: a.units, work: hoursOf(a.work), cost: a.cost, start: a.start, finish: a.finish };
    project.assignments.push(asg);
    const label = r.name + (a.units !== null && Math.abs(a.units - 1) > 0.001 ? `[${Math.round(a.units * 100)}%]` : '');
    if (!named.has(a.task.uniqueId)) a.task.resourceNames = a.task.resourceNames ? `${a.task.resourceNames}, ${label}` : label;
  }
  // A working day given no hours works the standard day; resource calendars find their base by name.
  for (const c of project.calendars) {
    for (const d of c.days) if (d.type === 'working' && !d.hours.length) d.hours = STANDARD_HOURS.map((h) => ({ ...h }));
    const baseName = calendarBases.get(c);
    if (baseName !== undefined) c.parent = project.calendars.find((b) => b.resource === null && b.name === baseName)?.uniqueId ?? project.calendars.find((b) => b.resource === null)?.uniqueId ?? null;
  }
  project.calendar = (project.calendars.find((c) => c.resource === null && c.name === projectCalendarName) ?? project.calendars.find((c) => c.resource === null))?.uniqueId ?? null;
  Object.assign(project, { minutesPerDay, minutesPerWeek });
  project.resources = resources;
  project.summary = tasks.find((t) => t.id === 0) ?? null;
  project.tasks = tasks.filter((t) => t.id !== 0);
  return project;
}

function fields(model: string[], f: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  model.forEach((name, i) => {
    if (name && f[i + 1] !== undefined && f[i + 1] !== '') out[name] = f[i + 1];
  });
  return out;
}

/** One record's fields: delimited, with "quoted" fields that may contain the delimiter. */
function splitRecord(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}
