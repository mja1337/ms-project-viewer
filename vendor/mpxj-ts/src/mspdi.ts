/**
 * Project's XML format (MSPDI, "Save As > XML" in Microsoft Project, and
 * what ProjectLibre and GanttProject exchange with it), read into the same
 * model as .mpp files. Written from Microsoft's published schema.
 */

import { Assignment, CalendarDay, CalendarException, Duration, Project, ProjectCalendar, Relation, RelationType, Resource, Task, TimeUnit, WorkWeek, WorkingTime, emptyTask, rateFromHours, updateStructure } from './model';
import { Recurrence, describe, occurrences, standardWeek } from './calendars';
import { XmlNode, child, children, parseXml, text } from './xml';

const UNITS: Record<number, TimeUnit> = { 3: 'm', 4: 'em', 5: 'h', 6: 'eh', 7: 'd', 8: 'ed', 9: 'w', 10: 'ew', 11: 'mo', 12: 'emo', 19: '%', 20: 'e%' };
const RELATIONS: RelationType[] = ['FF', 'FS', 'SF', 'SS'];
const CONSTRAINTS = ['As Soon As Possible', 'As Late As Possible', 'Must Start On', 'Must Finish On', 'Start No Earlier Than', 'Start No Later Than', 'Finish No Earlier Than', 'Finish No Later Than'];

export function isMspdi(src: string): boolean {
  return /<Project[\s>][\s\S]{0,400}schemas\.microsoft\.com\/project/.test(src.slice(0, 2000)) || /^\s*(<\?xml[^>]*>\s*)?<Project[\s>]/.test(src.slice(0, 500));
}

export function readMspdi(src: string): Project {
  const doc = parseXml(src);
  const p = children(doc, 'Project')[0];
  if (!p) throw new Error('This XML file is not a Microsoft Project XML file.');
  const minutesPerDay = Number(text(p, 'MinutesPerDay')) || 480;
  const minutesPerWeek = Number(text(p, 'MinutesPerWeek')) || 2400;
  const daysPerMonth = Number(text(p, 'DaysPerMonth')) || 20;
  const defaultUnits = UNITS[Number(text(p, 'DurationFormat'))] ?? 'd';
  const cal = { minutesPerDay, minutesPerWeek, daysPerMonth };

  /** "PT40H0M0S" (or P1DT2H) as a duration in the given units. */
  const duration = (v: string, format: number | null): Duration | null => {
    const m = /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v);
    if (!m) return null;
    const neg = v.startsWith('-') ? -1 : 1;
    const hours = neg * ((Number(m[3] ?? 0) * 24) + Number(m[4] ?? 0) + Number(m[5] ?? 0) / 60 + Number(m[6] ?? 0) / 3600);
    const units = (format !== null && UNITS[format & ~32]) || defaultUnits;
    return { value: inUnits(hours, units, cal), units };
  };
  const hours = (v: string) => {
    const d = duration(v, 5);
    return d ? d.value : null;
  };
  const date = (v: string): number | null => {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?/.exec(v);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
  };
  const num = (v: string) => (v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const bool = (v: string) => v === '1' || v.toLowerCase() === 'true';

  const project: Project = {
    format: 'Microsoft Project XML',
    title: text(p, 'Title') || text(p, 'Name').replace(/\.xml$/i, ''),
    subject: text(p, 'Subject'),
    author: text(p, 'Author'),
    manager: text(p, 'Manager'),
    company: text(p, 'Company'),
    comments: text(p, 'Comments'),
    start: date(text(p, 'StartDate')),
    finish: date(text(p, 'FinishDate')),
    statusDate: date(text(p, 'StatusDate')),
    currencySymbol: text(p, 'CurrencySymbol'),
    minutesPerDay,
    minutesPerWeek,
    daysPerMonth,
    summary: null,
    tasks: [],
    resources: [],
    assignments: [],
    calendars: readCalendars(p),
    calendar: null,
    warnings: [],
  };
  const projectCalendar = num(text(p, 'CalendarUID'));
  project.calendar = project.calendars.some((c) => c.uniqueId === projectCalendar) ? projectCalendar : project.calendars.find((c) => c.parent === null)?.uniqueId ?? null;

  const tasks: Task[] = [];
  for (const x of children(child(p, 'Tasks'), 'Task')) {
    const t = emptyTask(Number(text(x, 'UID')));
    t.id = Number(text(x, 'ID')) || 0;
    t.blank = bool(text(x, 'IsNull'));
    if (t.blank) {
      // Project writes blank rows with placeholder dates; they are empty lines.
      t.id = Number(text(x, 'ID')) || 0;
      tasks.push(t);
      continue;
    }
    t.name = text(x, 'Name');
    t.outlineLevel = Number(text(x, 'OutlineLevel')) || 1;
    t.wbs = text(x, 'WBS');
    t.start = date(text(x, 'Start'));
    t.finish = date(text(x, 'Finish'));
    const fmt = num(text(x, 'DurationFormat'));
    t.manual = bool(text(x, 'Manual'));
    t.duration = duration(t.manual && text(x, 'ManualDuration') ? text(x, 'ManualDuration') : text(x, 'Duration'), fmt);
    t.estimated = bool(text(x, 'Estimated'));
    t.actualStart = date(text(x, 'ActualStart'));
    t.actualFinish = date(text(x, 'ActualFinish'));
    t.percentComplete = num(text(x, 'PercentComplete')) ?? 0;
    t.work = hours(text(x, 'Work'));
    const cost = num(text(x, 'Cost'));
    t.cost = cost === null ? null : cost / 100;
    t.milestone = bool(text(x, 'Milestone'));
    t.critical = bool(text(x, 'Critical'));
    t.active = text(x, 'Active') === '' ? true : bool(text(x, 'Active'));
    t.constraint = CONSTRAINTS[Number(text(x, 'ConstraintType'))] ?? '';
    t.constraintDate = date(text(x, 'ConstraintDate'));
    t.priority = num(text(x, 'Priority'));
    t.notes = text(x, 'Notes');
    for (const b of children(x, 'Baseline')) {
      if (text(b, 'Number') !== '0') continue;
      t.baselineStart = date(text(b, 'Start'));
      t.baselineFinish = date(text(b, 'Finish'));
    }
    for (const l of children(x, 'PredecessorLink')) {
      const lagTenths = Number(text(l, 'LinkLag')) || 0;
      const lagFormat = num(text(l, 'LagFormat'));
      const lagUnits = (lagFormat !== null && UNITS[lagFormat & ~32]) || 'd';
      const rel: Relation = { task: Number(text(l, 'PredecessorUID')), type: RELATIONS[Number(text(l, 'Type') || 1)] ?? 'FS', lag: lagTenths ? { value: inUnits(lagTenths / 600, lagUnits, cal), units: lagUnits } : null };
      if (rel.task !== t.uniqueId && !t.predecessors.some((x) => x.task === rel.task && x.type === rel.type)) t.predecessors.push(rel);
    }
    const extra: Record<string, string | number | boolean> = {};
    for (const k of ['Contact', 'Hyperlink', 'Deadline', 'FreeSlack', 'TotalSlack', 'EarlyStart', 'EarlyFinish', 'LateStart', 'LateFinish', 'ActualWork', 'RemainingWork', 'ActualCost']) {
      const v = text(x, k);
      if (v) extra[k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()] = v;
    }
    t.extra = extra;
    tasks.push(t);
  }
  updateStructure(tasks);

  const resources: Resource[] = [];
  for (const x of children(child(p, 'Resources'), 'Resource')) {
    if (bool(text(x, 'IsNull'))) continue;
    const type = bool(text(x, 'IsCostResource')) ? '2' : text(x, 'Type');
    const rateUnits = (({ 1: 'm', 2: 'h', 3: 'd', 4: 'w', 5: 'mo', 7: 'y' } as Record<string, TimeUnit>)[text(x, 'StandardRateFormat')] ?? 'h') as TimeUnit;
    const rate = num(text(x, 'StandardRate'));
    const cost = num(text(x, 'Cost'));
    resources.push({
      uniqueId: Number(text(x, 'UID')),
      id: Number(text(x, 'ID')) || 0,
      name: text(x, 'Name'),
      initials: text(x, 'Initials'),
      group: text(x, 'Group'),
      email: text(x, 'EmailAddress'),
      type: type === '0' ? 'Material' : type === '2' ? 'Cost' : 'Work',
      maxUnits: type === '1' || type === '' ? num(text(x, 'MaxUnits')) : null,
      standardRate: rate === null ? null : Math.round(rateFromHours(rate, type === '1' || type === '' ? rateUnits : 'h', cal) * 10000) / 10000,
      rateUnits: type === '1' || type === '' ? rateUnits : 'h',
      cost: cost === null ? null : cost / 100,
      work: hours(text(x, 'Work')),
      notes: text(x, 'Notes'),
      calendar: num(text(x, 'CalendarUID')),
    });
  }
  // A resource's calendar is its own: note which resource each belongs to.
  for (const r of resources) {
    const c = project.calendars.find((x) => x.uniqueId === r.calendar);
    if (!c) r.calendar = null;
    else if (c.parent !== null) c.resource = r.uniqueId;
  }
  project.resources = resources.filter((r) => r.id > 0 || r.name).sort((a, b) => a.id - b.id);

  const byRes = new Map(resources.map((r) => [r.uniqueId, r]));
  const byUid = new Map(tasks.map((t) => [t.uniqueId, t]));
  for (const x of children(child(p, 'Assignments'), 'Assignment')) {
    const resource = Number(text(x, 'ResourceUID'));
    const task = Number(text(x, 'TaskUID'));
    if (!byRes.has(resource) || !byUid.has(task)) continue;
    const cost = num(text(x, 'Cost'));
    const a: Assignment = { task, resource, units: num(text(x, 'Units')), work: hours(text(x, 'Work')), cost: cost === null ? null : cost / 100, start: date(text(x, 'Start')), finish: date(text(x, 'Finish')) };
    project.assignments.push(a);
    const t = byUid.get(task)!;
    const r = byRes.get(resource)!;
    const label = r.name + (a.units !== null && Math.abs(a.units - 1) > 0.001 && r.type === 'Work' ? `[${Math.round(a.units * 100)}%]` : '');
    t.resourceNames = t.resourceNames ? `${t.resourceNames}, ${label}` : label;
  }
  project.summary = tasks.find((t) => t.id === 0) ?? null;
  project.tasks = tasks.filter((t) => t.id !== 0);
  if (!project.title && project.summary?.name) project.title = project.summary.name;
  return project;
}

/** Hours of work time as a duration in the given units, using the project's day, week and month. */
export function inUnits(hours: number, units: TimeUnit, cal: { minutesPerDay: number; minutesPerWeek: number; daysPerMonth: number }): number {
  const minutes = hours * 60;
  switch (units) {
    case 'm': case 'em': return minutes;
    case 'h': case 'eh': return hours;
    case 'd': return minutes / cal.minutesPerDay;
    case 'ed': return hours / 24;
    case 'w': return minutes / cal.minutesPerWeek;
    case 'ew': return hours / 168;
    case 'mo': return minutes / (cal.minutesPerDay * cal.daysPerMonth);
    case 'emo': return hours / 720;
    default: return hours;
  }
}

/* ── Calendars (from MPXJ's MSPDIReader.readCalendar) ─────────────────── */

const RECURRENCE_TYPES: (Recurrence['type'] | null)[] = [null, 'daily', 'yearly', 'yearly', 'monthly', 'monthly', 'weekly', 'daily'];
const RECURRENCE_RELATIVE = [false, false, false, true, false, true];

/** "08:00:00" as minutes from midnight; "00:00:00" as an end time is midnight at the end of the day. */
function clock(v: string, end: boolean): number | null {
  const m = /^(\d\d):(\d\d)/.exec(v);
  if (!m) return null;
  const t = +m[1] * 60 + +m[2];
  return end && t === 0 ? 1440 : t;
}

function workingTimes(x: XmlNode | undefined): WorkingTime[] {
  const out: WorkingTime[] = [];
  for (const w of children(child(x, 'WorkingTimes'), 'WorkingTime')) {
    const start = clock(text(w, 'FromTime'), false);
    const end = clock(text(w, 'ToTime'), true);
    if (start !== null && end !== null) out.push({ start, end });
  }
  return out;
}

function weekDays(x: XmlNode | undefined, base: boolean): { days: CalendarDay[]; dayExceptions: CalendarException[] } {
  const days: CalendarDay[] = base ? standardWeek() : Array.from({ length: 7 }, () => ({ type: 'default' as const, hours: [] }));
  const dayExceptions: CalendarException[] = [];
  for (const d of children(child(x, 'WeekDays'), 'WeekDay')) {
    const type = Number(text(d, 'DayType'));
    const working = text(d, 'DayWorking') === '1' || text(d, 'DayWorking').toLowerCase() === 'true';
    if (type >= 1 && type <= 7) {
      days[type - 1] = working ? { type: 'working', hours: workingTimes(d) } : { type: 'nonworking', hours: [] };
    } else if (type === 0) {
      // Project 2003 and earlier wrote exceptions as day type 0 with a time period.
      const tp = child(d, 'TimePeriod');
      const from = dayOf(text(tp, 'FromDate'));
      const to = dayOf(text(tp, 'ToDate'));
      if (from !== null && to !== null) dayExceptions.push({ name: '', from, to, hours: working ? workingTimes(d) : [], recurrence: '', dates: null });
    }
  }
  return { days, dayExceptions };
}

function dayOf(v: string): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(v);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

function readCalendars(p: XmlNode): ProjectCalendar[] {
  const out: ProjectCalendar[] = [];
  for (const c of children(child(p, 'Calendars'), 'Calendar')) {
    const uid = Number(text(c, 'UID'));
    const baseUid = text(c, 'BaseCalendarUID');
    const isBase = text(c, 'IsBaseCalendar') === '1' || text(c, 'IsBaseCalendar').toLowerCase() === 'true' || baseUid === '' || Number(baseUid) < 0;
    const { days, dayExceptions } = weekDays(c, isBase);
    const exceptions: CalendarException[] = [];
    for (const e of children(child(c, 'Exceptions'), 'Exception')) {
      const tp = child(e, 'TimePeriod');
      const from = dayOf(text(tp, 'FromDate'));
      const to = dayOf(text(tp, 'ToDate'));
      if (from === null || to === null) continue;
      const working = text(e, 'DayWorking') === '1' || text(e, 'DayWorking').toLowerCase() === 'true';
      const code = Number(text(e, 'Type')) || 0;
      const type = RECURRENCE_TYPES[code] ?? null;
      let rule: Recurrence | null = null;
      if (type) {
        const relative = RECURRENCE_RELATIVE[code] ?? false;
        const period = Number(text(e, 'Period')) || 1;
        rule = { type, relative, start: from, finish: to, occurrences: Number(text(e, 'Occurrences')) || 1, frequency: period };
        const dow = (((Number(text(e, 'MonthItem')) - 3) % 7) + 7) % 7;
        if (type === 'daily' && period === 1) rule = null;
        else if (type === 'weekly') {
          const mask = Number(text(e, 'DaysOfWeek')) || 0;
          rule.days = Array.from({ length: 7 }, (_, i) => (mask & (1 << i)) !== 0);
        } else if (type === 'monthly') {
          if (relative) {
            rule.dayOfWeek = dow;
            rule.dayNumber = Number(text(e, 'MonthPosition')) + 1;
          } else rule.dayNumber = Number(text(e, 'MonthDay')) || 1;
        } else if (type === 'yearly') {
          rule.frequency = 1;
          if (relative) {
            rule.dayOfWeek = dow;
            rule.dayNumber = Number(text(e, 'MonthPosition')) + 1;
          } else rule.dayNumber = Number(text(e, 'MonthDay')) || 1;
          rule.month = Number(text(e, 'Month')) + 1;
        }
      }
      const dates = rule ? occurrences(rule) : null;
      // A rule that falls on no day at all is dropped, as MPXJ does.
      if (dates && !dates.length) continue;
      exceptions.push({ name: text(e, 'Name'), from, to, hours: working ? workingTimes(e) : [], recurrence: rule ? describe(rule) : '', dates });
    }
    const weeks: WorkWeek[] = [];
    for (const w of children(child(c, 'WorkWeeks'), 'WorkWeek')) {
      const tp = child(w, 'TimePeriod');
      weeks.push({ name: text(w, 'Name'), from: dayOf(text(tp, 'FromDate')), to: dayOf(text(tp, 'ToDate')), days: weekDays(w, false).days });
    }
    out.push({ uniqueId: uid, name: text(c, 'Name'), parent: isBase ? null : Number(baseUid), resource: null, days, exceptions: exceptions.length ? exceptions : dayExceptions, weeks });
  }
  // A derived calendar whose base is missing is dropped.
  return out.filter((c) => c.parent === null || out.some((b) => b.uniqueId === c.parent));
}
