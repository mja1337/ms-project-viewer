/**
 * Turns a reader's Project (mpxj-ts shape) into the view model the Gantt and
 * tables use: tasks in outline order with successors filled in, a flat link
 * list, and resources with their assignments.
 */
import { fmtLag } from './format.js';

export function buildViewModel(project) {
  const all = project.tasks.filter((t) => !t.blank && t.id !== 0);
  all.sort((a, b) => a.id - b.id);
  const byUid = new Map(all.map((t) => [t.uniqueId, t]));
  const resByUid = new Map(project.resources.map((r) => [r.uniqueId, r]));

  const tasks = all.map((t) => ({
    uid: t.uniqueId,
    id: t.id,
    name: t.name || '(unnamed task)',
    wbs: t.wbs || t.outlineNumber || '',
    outline: t.outlineNumber || '',
    level: t.outlineLevel || 1,
    parent: t.parent != null && byUid.has(t.parent) ? t.parent : null,
    start: t.start,
    finish: t.finish,
    duration: t.duration,
    estimated: !!t.estimated,
    percent: t.percentComplete || 0,
    milestone: !!t.milestone,
    summary: !!t.summary,
    critical: !!t.critical,
    manual: !!t.manual,
    active: t.active !== false,
    notes: t.notes || '',
    constraint: t.constraint || '',
    resourceNames: t.resourceNames || '',
    predecessors: [],
    successors: [],
  }));
  const vmByUid = new Map(tasks.map((t) => [t.uid, t]));

  const links = [];
  let n = 0;
  for (const t of all) {
    for (const p of t.predecessors || []) {
      const from = vmByUid.get(p.task);
      const to = vmByUid.get(t.uniqueId);
      if (!from || !to) continue; // e.g. a link to an external/subproject task
      const link = { id: ++n, from: from.uid, to: to.uid, type: p.type || 'FS', lag: p.lag || null };
      links.push(link);
      to.predecessors.push(link);
      from.successors.push(link);
    }
  }
  const linkLabel = (l, other) => `${vmByUid.get(other).id}${l.type}${fmtLag(l.lag)}`;
  for (const t of tasks) {
    t.predecessorText = t.predecessors.map((l) => (l.type === 'FS' && !fmtLag(l.lag) ? String(vmByUid.get(l.from).id) : linkLabel(l, l.from))).join(', ');
    t.successorText = t.successors.map((l) => (l.type === 'FS' && !fmtLag(l.lag) ? String(vmByUid.get(l.to).id) : linkLabel(l, l.to))).join(', ');
  }

  const assignments = project.assignments
    .filter((a) => vmByUid.has(a.task) && resByUid.has(a.resource))
    .map((a) => ({ ...a }));
  const resources = project.resources.map((r) => {
    const mine = assignments.filter((a) => a.resource === r.uniqueId);
    return {
      uid: r.uniqueId, id: r.id, name: r.name, type: r.type, initials: r.initials, group: r.group, email: r.email,
      maxUnits: r.maxUnits, standardRate: r.standardRate, rateUnits: r.rateUnits, work: r.work, cost: r.cost,
      assignments: mine.map((a) => ({ ...a, taskId: vmByUid.get(a.task).id, taskName: vmByUid.get(a.task).name })),
    };
  }).sort((a, b) => a.id - b.id);

  // Fill resource names from assignments if the reader did not.
  for (const t of tasks) {
    if (t.resourceNames) continue;
    t.resourceNames = assignments.filter((a) => a.task === t.uid).map((a) => resByUid.get(a.resource).name).join(', ');
  }

  const starts = tasks.map((t) => t.start).filter((x) => x != null);
  const finishes = tasks.map((t) => t.finish).filter((x) => x != null);
  return {
    meta: {
      title: project.title || project.summary?.name || '',
      format: project.format,
      author: project.author, manager: project.manager, company: project.company,
      start: project.start ?? (starts.length ? Math.min(...starts) : null),
      finish: project.finish ?? (finishes.length ? Math.max(...finishes) : null),
      statusDate: project.statusDate,
      currency: project.currencySymbol || '',
      warnings: project.warnings || [],
    },
    tasks, links, resources, assignments, byUid: vmByUid,
  };
}
