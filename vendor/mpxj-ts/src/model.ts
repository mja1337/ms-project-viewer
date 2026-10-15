/**
 * What a project file is read into: plain objects, so they cross from this
 * module to the page unchanged. Dates are "wall clock" times as Project
 * shows them, held as milliseconds of a UTC date with the same digits
 * (Project stores no time zone); format them with timeZone 'UTC'.
 */

export type TimeUnit = 'm' | 'em' | 'h' | 'eh' | 'd' | 'ed' | 'w' | 'ew' | 'mo' | 'emo' | 'y' | 'ey' | '%' | 'e%';

export interface Duration {
  value: number;
  units: TimeUnit;
}

export type RelationType = 'FS' | 'SS' | 'FF' | 'SF';

export interface Relation {
  /** Unique ID of the task this one depends on. */
  task: number;
  type: RelationType;
  lag: Duration | null;
}

export interface Task {
  uniqueId: number;
  id: number;
  name: string;
  outlineLevel: number;
  outlineNumber: string;
  wbs: string;
  start: number | null;
  finish: number | null;
  duration: Duration | null;
  actualStart: number | null;
  actualFinish: number | null;
  baselineStart: number | null;
  baselineFinish: number | null;
  percentComplete: number;
  /** Hours. */
  work: number | null;
  cost: number | null;
  milestone: boolean;
  summary: boolean;
  critical: boolean;
  active: boolean;
  manual: boolean;
  estimated: boolean;
  constraint: string;
  constraintDate: number | null;
  priority: number | null;
  notes: string;
  predecessors: Relation[];
  resourceNames: string;
  /** Unique ID of the parent summary task, or null at the top level. */
  parent: number | null;
  /** A blank row (Project allows empty lines in the task list). */
  blank: boolean;
  /** Every other field read, by MPXJ's field name (TEXT1, NUMBER3, FLAG2...). */
  extra: Record<string, string | number | boolean>;
}

export interface Resource {
  uniqueId: number;
  id: number;
  name: string;
  initials: string;
  group: string;
  email: string;
  type: 'Work' | 'Material' | 'Cost';
  /** 1 = 100%. */
  maxUnits: number | null;
  /** In rateUnits (per hour, per day...), as Project shows it; per unit for material resources. */
  standardRate: number | null;
  rateUnits: TimeUnit;
  cost: number | null;
  /** Hours. */
  work: number | null;
  notes: string;
  /** The resource's own calendar (its unique ID), which holds its time off. */
  calendar: number | null;
}

/** A stretch of working time, in minutes from midnight (an end of 1440 is midnight). */
export interface WorkingTime {
  start: number;
  end: number;
}

/** One weekday in a calendar: working (with its hours), not working, or as the base calendar has it. */
export interface CalendarDay {
  type: 'working' | 'nonworking' | 'default';
  hours: WorkingTime[];
}

/** Days off (no hours) or different hours, on a run of dates or on dates that repeat. */
export interface CalendarException {
  name: string;
  /** The first and last day, as UTC midnights. */
  from: number;
  to: number;
  /** Empty: not working. */
  hours: WorkingTime[];
  /** "Every year on 25 December", for an exception that repeats; empty otherwise. */
  recurrence: string;
  /** The days a repeating exception falls on (UTC midnights); null for a plain run of dates. */
  dates: number[] | null;
}

/** A named period with its own working week ("Summer hours"), between two dates. */
export interface WorkWeek {
  name: string;
  from: number | null;
  to: number | null;
  /** Sunday first. */
  days: CalendarDay[];
}

export interface ProjectCalendar {
  uniqueId: number;
  name: string;
  /** The base calendar this one is derived from; null for a base calendar. */
  parent: number | null;
  /** For a resource's calendar, the resource's unique ID. */
  resource: number | null;
  /** Sunday first. */
  days: CalendarDay[];
  exceptions: CalendarException[];
  weeks: WorkWeek[];
}

export interface Assignment {
  task: number;
  resource: number;
  /** 1 = 100%. */
  units: number | null;
  /** Hours. */
  work: number | null;
  cost: number | null;
  start: number | null;
  finish: number | null;
}

export interface Project {
  /** "Microsoft Project 2016 (MPP14)", "MSPDI XML", "MPX". */
  format: string;
  title: string;
  subject: string;
  author: string;
  manager: string;
  company: string;
  comments: string;
  start: number | null;
  finish: number | null;
  statusDate: number | null;
  currencySymbol: string;
  minutesPerDay: number;
  minutesPerWeek: number;
  daysPerMonth: number;
  /** The project summary task (ID 0), when the file has one. */
  summary: Task | null;
  tasks: Task[];
  resources: Resource[];
  assignments: Assignment[];
  /** Working-time calendars: base calendars, and each resource's own. */
  calendars: ProjectCalendar[];
  /** The project's calendar (its unique ID). */
  calendar: number | null;
  /** Things read in part, worth telling the reader about. */
  warnings: string[];
}

export function emptyTask(uniqueId: number): Task {
  return {
    uniqueId, id: 0, name: '', outlineLevel: 1, outlineNumber: '', wbs: '', start: null, finish: null, duration: null, actualStart: null, actualFinish: null,
    baselineStart: null, baselineFinish: null, percentComplete: 0, work: null, cost: null, milestone: false, summary: false, critical: false, active: true,
    manual: false, estimated: false, constraint: '', constraintDate: null, priority: null, notes: '', predecessors: [], resourceNames: '', parent: null, blank: false, extra: {},
  };
}

/**
 * Builds the outline from the tasks in ID order and their outline levels:
 * each task's parent is the nearest task above it one level up. Sets
 * parent, summary (has children) and outline numbers (1, 1.1, 1.2, 2...).
 */
export function updateStructure(tasks: Task[]): void {
  tasks.sort((a, b) => a.id - b.id);
  const stack: Task[] = [];
  const counters: number[] = [];
  const hasChildren = new Set<number>();
  for (const t of tasks) {
    // ID 0 is the project summary task: above the outline, not in it.
    if (t.blank || t.id === 0) continue;
    const level = Math.max(1, t.outlineLevel || 1);
    while (stack.length >= level) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    t.parent = parent ? parent.uniqueId : null;
    if (parent) hasChildren.add(parent.uniqueId);
    counters.length = Math.min(counters.length, stack.length + 1);
    counters[stack.length] = (counters[stack.length] ?? 0) + 1;
    t.outlineNumber = counters.slice(0, stack.length + 1).join('.');
    t.outlineLevel = stack.length + 1;
    stack.push(t);
  }
  for (const t of tasks) t.summary = hasChildren.has(t.uniqueId);
  // A summary task is critical when any task under it is.
  const byUid = new Map(tasks.map((t) => [t.uniqueId, t]));
  for (const t of tasks) {
    if (!t.critical || t.summary) continue;
    for (let p = t.parent; p !== null; p = byUid.get(p)?.parent ?? null) {
      const parent = byUid.get(p);
      if (!parent) break;
      parent.critical = true;
    }
  }
}

/** A rate stored per hour, as an amount per the units Project shows it in. */
export function rateFromHours(perHour: number, units: TimeUnit, cal: { minutesPerDay: number; minutesPerWeek: number; daysPerMonth: number }): number {
  switch (units) {
    case 'm': return perHour / 60;
    case 'd': return (perHour * cal.minutesPerDay) / 60;
    case 'w': return (perHour * cal.minutesPerWeek) / 60;
    case 'mo': return (perHour * cal.minutesPerDay * cal.daysPerMonth) / 60;
    case 'y': return (perHour * cal.minutesPerWeek * 52) / 60;
    default: return perHour;
  }
}

/** "5 days", "2 wks", "1.5 hrs" as Project writes them. */
export function formatDuration(d: Duration | null): string {
  if (!d) return '';
  const v = Math.round(d.value * 100) / 100;
  const one = v === 1;
  const names: Record<TimeUnit, [string, string]> = {
    m: ['min', 'mins'], em: ['emin', 'emins'], h: ['hr', 'hrs'], eh: ['ehr', 'ehrs'], d: ['day', 'days'], ed: ['eday', 'edays'],
    w: ['wk', 'wks'], ew: ['ewk', 'ewks'], mo: ['mon', 'mons'], emo: ['emon', 'emons'], y: ['yr', 'yrs'], ey: ['eyr', 'eyrs'], '%': ['%', '%'], 'e%': ['e%', 'e%'],
  };
  const n = names[d.units] ?? ['', ''];
  return `${v} ${one ? n[0] : n[1]}`.replace(' %', '%');
}
