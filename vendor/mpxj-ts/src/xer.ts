/**
 * Primavera P6 XER files (the export format of P6 Professional and EPPM),
 * read into the same model as Project files. An XER is tab-separated text:
 * "%T name" starts a table, "%F" names its columns, "%R" is a row, "%E" ends
 * the file. The tables used: PROJECT, CALENDAR, PROJWBS, TASK, TASKPRED,
 * RSRC, TASKRSRC, CURRTYPE and TASKMEMO. Calendars' working time is in the
 * clndr_data column as P6's "structured text".
 *
 * The meaning of the tables, codes and calendar data follows MPXJ's
 * Primavera reader (PrimaveraXERFileReader, TableProjectReader,
 * TableContextReader, StructuredTextParser): see README.md.
 */

import { Assignment, CalendarDay, CalendarException, Project, ProjectCalendar, Relation, RelationType, Resource, Task, WorkingTime, emptyTask, updateStructure } from './model';

export type XerRow = Record<string, string>;
export type XerTables = Map<string, XerRow[]>;

export function isXer(text: string): boolean {
  return /^ERMHDR\t/.test(text) || /^\s*%T\t/m.test(text.slice(0, 4000));
}

export function parseXer(text: string): XerTables {
  const tables: XerTables = new Map();
  let rows: XerRow[] | null = null;
  let fields: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    const tag = tab < 0 ? line : line.slice(0, tab);
    const rest = tab < 0 ? '' : line.slice(tab + 1);
    if (tag === '%T') {
      rows = [];
      fields = [];
      tables.set(rest.trim().toUpperCase(), rows);
    } else if (tag === '%F') {
      fields = rest.split('\t');
    } else if (tag === '%R' && rows) {
      const values = rest.split('\t');
      const row: XerRow = {};
      fields.forEach((f, i) => (row[f] = values[i] ?? ''));
      rows.push(row);
    } else if (tag === '%E') break;
  }
  return tables;
}

/* ── Structured text (clndr_data) ──────────────────────────────────────── */

export interface StRecord {
  name: string;
  attrs: Record<string, string>;
  children: StRecord[];
}

/**
 * "(0||Name(key|value|key|value)(children...))" records, as P6 writes
 * calendars. A malformed tail is dropped, keeping what was read.
 */
export function parseStructured(text: string): StRecord {
  let i = 0;
  const ws = () => {
    while (i < text.length && text.charCodeAt(i) <= 32) i++;
  };
  const list = (): StRecord[] => {
    const out: StRecord[] = [];
    for (;;) {
      ws();
      if (text[i] !== '(') return out;
      i++;
      while (i < text.length && /\d/.test(text[i])) i++;
      ws();
      if (text.slice(i, i + 2) !== '||') throw new Error('separator');
      i += 2;
      ws();
      let name = '';
      while (i < text.length && text[i] !== '(') name += text[i++];
      i++;
      const attrs: Record<string, string> = {};
      while (i < text.length && text[i] !== ')') {
        let key = '';
        while (i < text.length && text[i] !== '|') key += text[i++];
        i++;
        let value = '';
        while (i < text.length && text[i] !== '|' && text[i] !== ')') value += text[i++];
        if (text[i] === '|') i++;
        attrs[key] = value;
      }
      i++;
      ws();
      if (text[i] !== '(') throw new Error('children');
      i++;
      const children = list();
      ws();
      if (text[i] !== ')') throw new Error('end');
      i++;
      ws();
      if (text[i] === ')') i++;
      out.push({ name: name.trim(), attrs, children });
    }
  };
  try {
    const top = list();
    return top[0] ?? { name: '', attrs: {}, children: [] };
  } catch {
    return { name: '', attrs: {}, children: [] };
  }
}

const child = (r: StRecord | undefined, name: string) => r?.children.find((c) => c.name === name);

/** "08:00", "8:00 AM"; a finish of midnight is the end of the day. */
function minutes(v: string | undefined, end: boolean): number | null {
  const m = /^\s*(\d{1,2}):(\d\d)\s*(AM|PM)?/i.exec(v ?? '');
  if (!m) return null;
  let h = +m[1];
  if (m[3]) h = (h % 12) + (/pm/i.test(m[3]) ? 12 : 0);
  const t = h * 60 + +m[2];
  return end && t === 0 ? 1440 : t;
}

function hoursOf(r: StRecord | undefined): WorkingTime[] {
  const out: WorkingTime[] = [];
  for (const h of r?.children ?? []) {
    const start = minutes(h.attrs['s'], false);
    const end = minutes(h.attrs['f'], true);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Days since 30 December 1899, as P6 dates its calendar exceptions. */
const EPOCH = Date.UTC(1899, 11, 30);

export function readCalendar(row: XerRow): ProjectCalendar {
  const root = parseStructured(row['clndr_data'] ?? '');
  const week = child(root, 'DaysOfWeek');
  // Days 1-7 are Sunday to Saturday. A calendar with no week data works Monday to Friday, 8 to 4, as P6 does.
  const days: CalendarDay[] = Array.from({ length: 7 }, (_, d) => {
    if (!week) return d === 0 || d === 6 ? { type: 'nonworking', hours: [] } : { type: 'working', hours: [{ start: 480, end: 960 }] };
    const hours = hoursOf(child(week, String(d + 1)));
    return hours.length ? { type: 'working', hours } : { type: 'nonworking', hours: [] };
  });
  const exceptions: CalendarException[] = [];
  for (const e of child(root, 'Exceptions')?.children ?? []) {
    const n = Number(e.attrs['d']);
    if (!Number.isFinite(n)) continue;
    const day = EPOCH + n * 86400000;
    exceptions.push({ name: '', from: day, to: day, hours: hoursOf(e), recurrence: '', dates: null });
  }
  exceptions.sort((a, b) => a.from - b.from);
  const parent = Number(row['base_clndr_id']);
  return { uniqueId: Number(row['clndr_id']), name: row['clndr_name'] || 'Calendar', parent: Number.isFinite(parent) && row['base_clndr_id'] ? parent : null, resource: null, days, exceptions, weeks: [] };
}

/* ── The project ───────────────────────────────────────────────────────── */

const RELATIONS: Record<string, RelationType> = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
const CONSTRAINTS: Record<string, string> = {
  CS_MSO: 'Start On', CS_MSOB: 'Start No Later Than', CS_MSOA: 'Start No Earlier Than', CS_MEO: 'Finish On', CS_MEOB: 'Finish No Later Than',
  CS_MEOA: 'Finish No Earlier Than', CS_ALAP: 'As Late As Possible', CS_MANDSTART: 'Must Start On', CS_MANDFIN: 'Must Finish On',
};
const ACTIVITY_TYPES: Record<string, string> = { TT_Task: 'Task Dependent', TT_Rsrc: 'Resource Dependent', TT_LOE: 'Level of Effort', TT_Mile: 'Start Milestone', TT_FinMile: 'Finish Milestone', TT_WBS: 'WBS Summary' };
/**
 * An activity's percent complete as P6 shows it, by its percent complete
 * type: physical (entered), units (actual work of all work) or duration
 * (the default: how much of the planned duration is behind it).
 */
function percentComplete(a: XerRow): number {
  const status = a['status_code'];
  if (status === 'TK_Complete') return 100;
  if (status === 'TK_NotStart') return 0;
  const phys = num(a['phys_complete_pct']);
  let pct: number | null;
  if (a['complete_pct_type'] === 'CP_Phys') {
    pct = phys;
  } else if (a['complete_pct_type'] === 'CP_Units') {
    const act = num(a['act_work_qty']) ?? 0;
    const total = act + (num(a['remain_work_qty']) ?? 0);
    pct = total > 0 ? (act / total) * 100 : phys;
  } else {
    const target = num(a['target_drtn_hr_cnt']);
    const remain = num(a['remain_drtn_hr_cnt']);
    // A zero planned duration (a milestone) has no duration to measure by.
    pct = target && target > 0 && remain !== null ? ((target - remain) / target) * 100 : phys;
  }
  return Math.round(Math.min(100, Math.max(0, pct ?? 0)));
}

const STATUS: Record<string, string> = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Completed' };
const PRIORITY: Record<string, number> = { PT_Top: 1000, PT_High: 750, PT_Normal: 500, PT_Low: 250, PT_Lowest: 0 };

/** "2026-03-04 08:00" (or a date alone) as the model's UTC wall-clock milliseconds. */
function date(v: string | undefined): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(v ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) : null;
}
function num(v: string | undefined): number | null {
  return v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}
/** P6 memos are HTML; plain text for the notes. */
function memo(v: string | undefined): string {
  return (v ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

export function readXer(text: string): Project {
  const t = parseXer(text);
  const rowsOf = (name: string) => t.get(name) ?? [];
  const projects = rowsOf('PROJECT');
  if (!projects.length) throw new Error('This XER file holds no project.');
  // The project the user exported first; P6 marks it, and lists any others it carried along.
  const proj = projects.find((p) => p['export_flag'] === 'Y') ?? projects[0];
  const projId = proj['proj_id'];
  const warnings: string[] = [];
  if (projects.length > 1) warnings.push(`This XER file holds ${projects.length} projects; showing ${proj['proj_short_name'] || 'the first'}. The others: ${projects.filter((p) => p !== proj).map((p) => p['proj_short_name']).join(', ')}.`);
  const mine = (r: XerRow) => !r['proj_id'] || r['proj_id'] === projId;

  // Calendars: global ones and this project's; resource calendars too.
  const calendars = rowsOf('CALENDAR').filter((c) => c['clndr_type'] !== 'CA_Project' || c['proj_id'] === projId).map(readCalendar);
  const calRows = new Map(rowsOf('CALENDAR').map((c) => [c['clndr_id'], c]));
  const projCal = calRows.get(proj['clndr_id']) ?? rowsOf('CALENDAR').find((c) => c['default_flag'] === 'Y');
  const hoursPerDay = num(projCal?.['day_hr_cnt']) || 8;
  const hoursPerWeek = num(projCal?.['week_hr_cnt']) || hoursPerDay * 5;
  const hoursPerMonth = num(projCal?.['month_hr_cnt']) || hoursPerWeek * 4;
  const days = (h: number | null) => (h === null ? null : { value: h / hoursPerDay, units: 'd' as const });

  // The WBS tree (the project node itself is the project, not a row of the outline) and its activities.
  const wbsRows = rowsOf('PROJWBS').filter((w) => w['proj_id'] === projId && w['proj_node_flag'] !== 'Y');
  const wbsIds = new Set(wbsRows.map((w) => w['wbs_id']));
  const kids = new Map<string, XerRow[]>();
  for (const w of wbsRows) {
    const p = wbsIds.has(w['parent_wbs_id']) ? w['parent_wbs_id'] : '';
    const list = kids.get(p);
    if (list) list.push(w);
    else kids.set(p, [w]);
  }
  const acts = rowsOf('TASK').filter((a) => a['proj_id'] === projId);
  const actsByWbs = new Map<string, XerRow[]>();
  for (const a of acts) {
    const w = wbsIds.has(a['wbs_id']) ? a['wbs_id'] : '';
    const list = actsByWbs.get(w);
    if (list) list.push(a);
    else actsByWbs.set(w, [a]);
  }
  const memos = new Map<string, string>();
  for (const m of rowsOf('TASKMEMO')) if (mine(m)) memos.set(m['task_id'], [memos.get(m['task_id']), memo(m['task_memo'])].filter(Boolean).join('\n\n'));
  const wbsMemos = new Map<string, string>();
  for (const m of rowsOf('WBSMEMO')) if (mine(m)) wbsMemos.set(m['wbs_id'], memo(m['wbs_memo']));

  const tasks: Task[] = [];
  // WBS elements and activities share the model's unique IDs: activities keep theirs, WBS elements are numbered after the largest.
  const maxTask = acts.reduce((m, a) => Math.max(m, Number(a['task_id']) || 0), 0);
  const wbsUid = new Map(wbsRows.map((w, i) => [w['wbs_id'], maxTask + 1 + i]));
  const sep = proj['name_sep_char'] || '.';
  let id = 0;

  const addActivity = (a: XerRow, level: number, wbsCode: string) => {
    const task = emptyTask(Number(a['task_id']));
    task.id = ++id;
    task.name = a['task_name'] || a['task_code'];
    task.outlineLevel = level;
    task.wbs = wbsCode;
    const status = a['status_code'];
    task.actualStart = date(a['act_start_date']);
    task.actualFinish = date(a['act_end_date']);
    task.start = task.actualStart ?? date(a['restart_date']) ?? date(a['early_start_date']) ?? date(a['target_start_date']);
    task.finish = task.actualFinish ?? date(a['reend_date']) ?? date(a['early_end_date']) ?? date(a['target_end_date']);
    task.baselineStart = date(a['target_start_date']);
    task.baselineFinish = date(a['target_end_date']);
    const type = a['task_type'];
    task.milestone = type === 'TT_Mile' || type === 'TT_FinMile';
    // The planned (original) duration, as P6 shows it; the remaining duration is kept beside it.
    task.duration = days(num(a['target_drtn_hr_cnt']));
    const remaining = num(a['remain_drtn_hr_cnt']);
    if (remaining !== null && status !== 'TK_NotStart') task.extra['REMAINING_DURATION'] = `${Math.round((remaining / hoursPerDay) * 100) / 100} d`;
    if (task.milestone) task.duration = { value: 0, units: 'd' };
    task.percentComplete = percentComplete(a);
    const work = [a['act_work_qty'], a['remain_work_qty']].map(num);
    task.work = work[0] !== null || work[1] !== null ? (work[0] ?? 0) + (work[1] ?? 0) : num(a['target_work_qty']);
    const tf = num(a['total_float_hr_cnt']);
    task.critical = status !== 'TK_Complete' && (a['driving_path_flag'] === 'Y' || (tf !== null && tf <= 0));
    task.constraint = CONSTRAINTS[a['cstr_type']] ?? 'As Soon As Possible';
    task.constraintDate = date(a['cstr_date']);
    task.priority = PRIORITY[a['priority_type']] ?? null;
    task.notes = memos.get(a['task_id']) ?? '';
    task.extra['ACTIVITY_ID'] = a['task_code'];
    task.extra['ACTIVITY_TYPE'] = ACTIVITY_TYPES[type] ?? type;
    task.extra['ACTIVITY_STATUS'] = STATUS[status] ?? status;
    if (tf !== null) task.extra['TOTAL_FLOAT'] = `${Math.round((tf / hoursPerDay) * 100) / 100} d`;
    const ff = num(a['free_float_hr_cnt']);
    if (ff !== null) task.extra['FREE_FLOAT'] = `${Math.round((ff / hoursPerDay) * 100) / 100} d`;
    if (a['late_start_date']) task.extra['LATE_START'] = a['late_start_date'];
    if (a['late_end_date']) task.extra['LATE_FINISH'] = a['late_end_date'];
    tasks.push(task);
  };

  // Activities sort by Activity ID within their WBS element, as P6 lists them by default.
  const byCode = (a: XerRow, b: XerRow) => (a['task_code'] ?? '').localeCompare(b['task_code'] ?? '', undefined, { numeric: true });
  const walk = (parent: string, level: number, path: string) => {
    for (const a of (actsByWbs.get(parent) ?? []).sort(byCode)) addActivity(a, level, path);
    const ws = (kids.get(parent) ?? []).sort((a, b) => (num(a['seq_num']) ?? 0) - (num(b['seq_num']) ?? 0) || (a['wbs_short_name'] ?? '').localeCompare(b['wbs_short_name'] ?? ''));
    for (const w of ws) {
      const code = path ? `${path}${sep}${w['wbs_short_name']}` : `${proj['proj_short_name'] ? proj['proj_short_name'] + sep : ''}${w['wbs_short_name']}`;
      const task = emptyTask(wbsUid.get(w['wbs_id'])!);
      task.id = ++id;
      task.name = w['wbs_name'] || w['wbs_short_name'];
      task.outlineLevel = level;
      task.wbs = code;
      task.notes = wbsMemos.get(w['wbs_id']) ?? '';
      task.extra['WBS_CODE'] = w['wbs_short_name'];
      tasks.push(task);
      walk(w['wbs_id'], level + 1, code);
    }
  };
  walk('', 1, '');
  updateStructure(tasks);

  // Summary rows take their dates and work from what is under them.
  const byUid = new Map(tasks.map((x) => [x.uniqueId, x]));
  const children = new Map<number, Task[]>();
  for (const x of tasks) {
    if (x.parent === null) continue;
    const list = children.get(x.parent);
    if (list) list.push(x);
    else children.set(x.parent, [x]);
  }
  const roll = (x: Task) => {
    const cs = children.get(x.uniqueId);
    if (!cs) return;
    cs.forEach(roll);
    const starts = cs.map((c) => c.start).filter((v): v is number => v !== null);
    const ends = cs.map((c) => c.finish).filter((v): v is number => v !== null);
    x.start = starts.length ? Math.min(...starts) : null;
    x.finish = ends.length ? Math.max(...ends) : null;
    const bs = cs.map((c) => c.baselineStart).filter((v): v is number => v !== null);
    const be = cs.map((c) => c.baselineFinish).filter((v): v is number => v !== null);
    x.baselineStart = bs.length ? Math.min(...bs) : null;
    x.baselineFinish = be.length ? Math.max(...be) : null;
    x.work = cs.reduce((s, c) => s + (c.work ?? 0), 0) || null;
    const span = cs.reduce((s, c) => s + (c.duration?.value ?? 0), 0);
    x.percentComplete = span ? Math.round(cs.reduce((s, c) => s + (c.duration?.value ?? 0) * c.percentComplete, 0) / span) : 0;
    if (x.start !== null && x.finish !== null) x.duration = { value: workingDays(x.start, x.finish), units: 'd' };
  };
  // A summary's span in working days of the project calendar's week (its exceptions aside).
  const week = calendars.find((c) => c.uniqueId === Number(projCal?.['clndr_id']))?.days;
  const dayHours = (d: number) => (week ? week[d].hours.reduce((s, h) => s + (h.end - h.start) / 60, 0) : d === 0 || d === 6 ? 0 : hoursPerDay);
  function workingDays(from: number, to: number): number {
    let hours = 0;
    for (let day = Math.floor(from / 86400000) * 86400000; day <= to; day += 86400000) {
      const d = new Date(day).getUTCDay();
      const total = dayHours(d);
      if (!total) continue;
      // Part days at either end, by the share of the day's span covered.
      const a = Math.max(from, day), b = Math.min(to, day + 86400000);
      const share = from <= day && to >= day + 86400000 ? 1 : Math.min(1, Math.max(0, (b - a) / ((week?.[d].hours.length ? (week[d].hours[week[d].hours.length - 1].end - week[d].hours[0].start) : total * 60) * 60000)));
      hours += total * share;
    }
    return Math.round((hours / hoursPerDay) * 100) / 100;
  }
  for (const x of tasks) if (x.parent === null) roll(x);

  // Relationships, from the successor's side as the model keeps them.
  for (const r of rowsOf('TASKPRED')) {
    const succ = byUid.get(Number(r['task_id']));
    const pred = Number(r['pred_task_id']);
    if (!succ || !byUid.has(pred)) continue;
    const lag = num(r['lag_hr_cnt']);
    const rel: Relation = { task: pred, type: RELATIONS[r['pred_type']] ?? 'FS', lag: lag ? { value: lag / hoursPerDay, units: 'd' } : null };
    succ.predecessors.push(rel);
  }

  // Resources and assignments.
  const rsrcRows = rowsOf('RSRC');
  const resources: Resource[] = rsrcRows.map((r, i) => ({
    uniqueId: Number(r['rsrc_id']), id: i + 1, name: r['rsrc_name'] || r['rsrc_short_name'], initials: r['rsrc_short_name'] ?? '', group: '', email: r['email_addr'] ?? '',
    type: r['rsrc_type'] === 'RT_Mat' ? 'Material' : 'Work', maxUnits: num(r['def_qty_per_hr']), standardRate: null, rateUnits: 'h', cost: null, work: null,
    notes: memo(r['rsrc_notes']), calendar: num(r['clndr_id']),
  }));
  const resByUid = new Map(resources.map((r) => [r.uniqueId, r]));
  const assignments: Assignment[] = [];
  for (const a of rowsOf('TASKRSRC')) {
    if (a['proj_id'] && a['proj_id'] !== projId) continue;
    const task = byUid.get(Number(a['task_id']));
    const res = resByUid.get(Number(a['rsrc_id']));
    if (!task || !res) continue;
    const work = (num(a['act_reg_qty']) ?? 0) + (num(a['act_ot_qty']) ?? 0) + (num(a['remain_qty']) ?? 0) || num(a['target_qty']);
    const cost = (num(a['act_reg_cost']) ?? 0) + (num(a['act_ot_cost']) ?? 0) + (num(a['remain_cost']) ?? 0) || num(a['target_cost']);
    const perHr = num(a['target_qty_per_hr']);
    assignments.push({ task: task.uniqueId, resource: res.uniqueId, units: perHr, work, cost, start: date(a['act_start_date']) ?? date(a['restart_date']) ?? date(a['target_start_date']), finish: date(a['act_end_date']) ?? date(a['reend_date']) ?? date(a['target_end_date']) });
    res.work = (res.work ?? 0) + (work ?? 0);
    res.cost = (res.cost ?? 0) + (cost ?? 0);
    task.cost = (task.cost ?? 0) + (cost ?? 0);
  }
  const names = new Map<number, string[]>();
  for (const a of assignments) {
    const name = resByUid.get(a.resource)!.name;
    const list = names.get(a.task);
    if (list) list.push(name);
    else names.set(a.task, [name]);
  }
  for (const x of tasks) x.resourceNames = (names.get(x.uniqueId) ?? []).join(', ');
  for (const r of resources) if (r.calendar !== null) {
    const c = calendars.find((k) => k.uniqueId === r.calendar);
    if (c && calRows.get(String(c.uniqueId))?.['clndr_type'] === 'CA_Rsrc') c.resource = r.uniqueId;
  }

  const start = date(proj['plan_start_date']) ?? tasks.reduce<number | null>((m, x) => (x.start !== null && (m === null || x.start < m) ? x.start : m), null);
  const finish = date(proj['scd_end_date']) ?? date(proj['plan_end_date']) ?? tasks.reduce<number | null>((m, x) => (x.finish !== null && (m === null || x.finish > m) ? x.finish : m), null);
  return {
    format: 'Primavera P6 (XER)',
    title: proj['proj_short_name'] || 'Project',
    subject: '', author: '', manager: '', company: '', comments: '',
    start, finish,
    statusDate: date(proj['last_recalc_date']),
    currencySymbol: rowsOf('CURRTYPE')[0]?.['curr_symbol'] ?? '',
    minutesPerDay: Math.round(hoursPerDay * 60),
    minutesPerWeek: Math.round(hoursPerWeek * 60),
    daysPerMonth: Math.round((hoursPerMonth / hoursPerDay) * 10) / 10 || 20,
    summary: null,
    tasks, resources, assignments, calendars,
    calendar: projCal ? Number(projCal['clndr_id']) : null,
    warnings,
  };
}
