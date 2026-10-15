/**
 * Reader 2 (fallback): a small, dependency-free MSPDI reader for Project's
 * "Save As > XML" files, written for this app (MIT). Used automatically when
 * mpxj-ts fails on an XML file, or chosen explicitly in the Reader menu.
 * It reads what the viewer shows: outline, dates, durations, % complete,
 * links with type and lag, resources and assignments.
 *
 * Output follows the mpxj-ts Project shape. Dates are wall-clock times held
 * as UTC milliseconds (Project stores no time zone).
 */

const UNITS = { 3: 'm', 4: 'em', 5: 'h', 6: 'eh', 7: 'd', 8: 'ed', 9: 'w', 10: 'ew', 11: 'mo', 12: 'emo', 19: '%', 20: 'e%' };
/** MSPDI link types: 0 FF, 1 FS, 2 SF, 3 SS. */
const LINK_TYPES = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };
const RESOURCE_TYPES = { 0: 'Material', 1: 'Work', 2: 'Cost' };

const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const text = (el, name) => {
  const k = kid(el, name);
  return k ? k.textContent.trim() : '';
};
const num = (el, name) => {
  const t = text(el, name);
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const bool = (el, name) => {
  const t = text(el, name);
  return t === '1' || t.toLowerCase() === 'true';
};
const date = (el, name) => {
  const t = text(el, name);
  if (!t) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? ms : null;
};
/** "PT8H30M0S" -> hours. */
function isoHours(s) {
  const m = /^-?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
  if (!m) return null;
  const [, , , d, h, mi, se] = m.map((x) => (x === undefined ? 0 : Number(x)));
  const hours = (d || 0) * 24 + (h || 0) + (mi || 0) / 60 + (se || 0) / 3600;
  return s.startsWith('-') ? -hours : hours;
}

function unitsFor(code) {
  const c = Number(code);
  if (UNITS[c]) return UNITS[c];
  if (UNITS[c - 32]) return UNITS[c - 32]; // estimated ("5 days?") variants
  return 'd';
}

function fromMinutes(minutes, units, cal) {
  const base = units.replace(/^e/, '');
  const elapsed = units.startsWith('e');
  const perDay = elapsed ? 1440 : cal.minutesPerDay;
  const perWeek = elapsed ? 10080 : cal.minutesPerWeek;
  switch (base) {
    case 'm': return minutes;
    case 'h': return minutes / 60;
    case 'd': return minutes / perDay;
    case 'w': return minutes / perWeek;
    case 'mo': return minutes / (perDay * (elapsed ? 30 : cal.daysPerMonth));
    case 'y': return minutes / (perWeek * 52);
    default: return minutes / perDay;
  }
}

export function readMspdiXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw Object.assign(new Error('This XML file could not be parsed.'), { code: 'format' });
  }
  const root = doc.documentElement;
  if (!root || root.localName !== 'Project') {
    throw Object.assign(new Error('This XML is not a Microsoft Project (MSPDI) file.'), { code: 'format' });
  }
  const cal = {
    minutesPerDay: num(root, 'MinutesPerDay') || 480,
    minutesPerWeek: num(root, 'MinutesPerWeek') || 2400,
    daysPerMonth: num(root, 'DaysPerMonth') || 20,
  };
  const duration = (iso, fmt) => {
    const h = isoHours(iso);
    if (h === null) return null;
    const units = unitsFor(fmt);
    return { value: fromMinutes(h * 60, units, cal), units };
  };

  const resources = [];
  for (const r of kids(kid(root, 'Resources'), 'Resource')) {
    const uid = num(r, 'UID');
    if (uid === null || uid === 0 || bool(r, 'IsNull') || !text(r, 'Name')) continue;
    resources.push({
      uniqueId: uid, id: num(r, 'ID') ?? uid, name: text(r, 'Name'), initials: text(r, 'Initials'), group: text(r, 'Group'),
      email: text(r, 'EmailAddress'), type: bool(r, 'IsCostResource') ? 'Cost' : RESOURCE_TYPES[num(r, 'Type') ?? 1] || 'Work', // Project marks cost resources with IsCostResource (Type stays 0) maxUnits: num(r, 'MaxUnits'),
      standardRate: num(r, 'StandardRate'), rateUnits: 'h', cost: num(r, 'Cost'),
      work: (() => { const h = isoHours(text(r, 'Work')); return h; })(), notes: text(r, 'Notes'), calendar: num(r, 'CalendarUID'),
    });
  }
  const resByUid = new Map(resources.map((r) => [r.uniqueId, r]));

  const assignments = [];
  for (const a of kids(kid(root, 'Assignments'), 'Assignment')) {
    const task = num(a, 'TaskUID');
    const resource = num(a, 'ResourceUID');
    if (task === null || resource === null || !resByUid.has(resource)) continue;
    assignments.push({ task, resource, units: num(a, 'Units'), work: isoHours(text(a, 'Work')), cost: num(a, 'Cost'), start: date(a, 'Start'), finish: date(a, 'Finish') });
  }

  let summary = null;
  const tasks = [];
  for (const t of kids(kid(root, 'Tasks'), 'Task')) {
    const uid = num(t, 'UID');
    if (uid === null) continue;
    const blank = bool(t, 'IsNull');
    const task = {
      uniqueId: uid, id: num(t, 'ID') ?? uid, name: text(t, 'Name'), outlineLevel: num(t, 'OutlineLevel') ?? 1,
      outlineNumber: text(t, 'OutlineNumber'), wbs: text(t, 'WBS'), start: date(t, 'Start'), finish: date(t, 'Finish'),
      duration: duration(text(t, 'Duration'), text(t, 'DurationFormat')), actualStart: date(t, 'ActualStart'), actualFinish: date(t, 'ActualFinish'),
      baselineStart: null, baselineFinish: null, percentComplete: num(t, 'PercentComplete') ?? 0, work: isoHours(text(t, 'Work')), cost: num(t, 'Cost'),
      milestone: bool(t, 'Milestone'), summary: bool(t, 'Summary'), critical: bool(t, 'Critical'), active: text(t, 'Active') !== '0',
      manual: bool(t, 'Manual'), estimated: bool(t, 'Estimated'), constraint: '', constraintDate: date(t, 'ConstraintDate'), priority: num(t, 'Priority'),
      notes: text(t, 'Notes'), predecessors: [], resourceNames: '', parent: null, blank, extra: {},
    };
    for (const l of kids(t, 'PredecessorLink')) {
      const pred = num(l, 'PredecessorUID');
      if (pred === null) continue;
      const lagTenths = num(l, 'LinkLag') ?? 0;
      const units = unitsFor(text(l, 'LagFormat') || 7);
      task.predecessors.push({ task: pred, type: LINK_TYPES[num(l, 'Type') ?? 1] || 'FS', lag: { value: fromMinutes(lagTenths / 10, units, cal), units } });
    }
    if (task.outlineLevel === 0 || task.id === 0) { summary = task; continue; }
    tasks.push(task);
  }
  tasks.sort((a, b) => a.id - b.id);
  const stack = [];
  for (const t of tasks) {
    if (t.blank) continue;
    while (stack.length && stack[stack.length - 1].outlineLevel >= t.outlineLevel) stack.pop();
    t.parent = stack.length ? stack[stack.length - 1].uniqueId : null;
    stack.push(t);
  }
  const names = new Map();
  for (const a of assignments) {
    const r = resByUid.get(a.resource);
    const label = a.units !== null && Math.abs(a.units - 1) > 1e-6 && r.type === 'Work' ? `${r.name}[${Math.round(a.units * 100)}%]` : r.name;
    names.set(a.task, [...(names.get(a.task) || []), label]);
  }
  for (const t of tasks) t.resourceNames = (names.get(t.uniqueId) || []).join(', ');

  return {
    format: 'Microsoft Project XML (built-in reader)', title: text(root, 'Title') || text(root, 'Name'), subject: text(root, 'Subject'),
    author: text(root, 'Author'), manager: text(root, 'Manager'), company: text(root, 'Company'), comments: '',
    start: date(root, 'StartDate'), finish: date(root, 'FinishDate'), statusDate: date(root, 'StatusDate'), currencySymbol: text(root, 'CurrencySymbol'),
    ...cal, summary, tasks, resources, assignments, calendars: [], calendar: num(root, 'CalendarUID'), warnings: [],
  };
}

function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0x3c && bytes[1] === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes).replace(/^\ufeff/, '');
}

export const mspdiNativeReader = {
  id: 'mspdi',
  label: 'Built-in Project XML reader (XML only)',
  accepts: (kind) => kind === 'xml',
  async read(bytes) {
    return readMspdiXml(decode(bytes));
  },
};
