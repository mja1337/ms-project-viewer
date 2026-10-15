/**
 * Gantt view: DHTMLX Gantt Community (MIT), read-only. Data comes only from
 * the view model; nothing here talks to the network. The export_api plugin
 * (which would post to export.dhtmlx.com) and importFromMSProject() are
 * never used. (Status-date markers need the PRO marker plugin, so the
 * status date is shown in the header instead.)
 */
import { gantt } from 'dhtmlx-gantt';
import 'dhtmlx-gantt/codebase/dhtmlxgantt.css';
import { esc, fmtDateShort, fmtDateTime, fmtDuration, fmtLag, toLocalDate, LINK_NAMES } from '../format.js';

const LINK_TYPE = { FS: '0', SS: '1', FF: '2', SF: '3' };
let ready = false;
let onSelect = () => {};

const ZOOM_LEVELS = [
  { name: 'day', scale_height: 50, min_column_width: 40, scales: [{ unit: 'week', step: 1, format: 'w/c %d %M %Y' }, { unit: 'day', step: 1, format: '%D %d' }] },
  { name: 'week', scale_height: 50, min_column_width: 60, scales: [{ unit: 'month', step: 1, format: '%F %Y' }, { unit: 'week', step: 1, format: 'w/c %d %M' }] },
  { name: 'month', scale_height: 50, min_column_width: 80, scales: [{ unit: 'year', step: 1, format: '%Y' }, { unit: 'month', step: 1, format: '%M' }] },
  { name: 'quarter', scale_height: 50, min_column_width: 90, scales: [{ unit: 'year', step: 1, format: '%Y' }, { unit: 'quarter', step: 1, format: (d) => `Q${Math.floor(d.getMonth() / 3) + 1}` }] },
  { name: 'year', scale_height: 50, min_column_width: 60, scales: [{ unit: 'year', step: 1, format: '%Y' }] },
];

function init(container) {
  gantt.plugins({ tooltip: true });
  Object.assign(gantt.config, {
    readonly: true,
    drag_move: false, drag_resize: false, drag_progress: false, drag_links: false,
    details_on_dblclick: false, details_on_create: false,
    open_tree_initially: true,
    auto_types: false,
    show_unscheduled: true,
    fit_tasks: true,
    row_height: 30, bar_height: 18,
    grid_width: 840,
    grid_resize: true,
    keep_grid_width: false,
    min_grid_column_width: 30,
    smart_rendering: true,
    show_errors: false,
    work_time: false,
    duration_unit: 'hour',
    round_dnd_dates: false,
    layout: {
      css: 'gantt_container',
      cols: [
        { width: 840, min_width: 300, rows: [{ view: 'grid', scrollX: 'gridScroll', scrollable: true, scrollY: 'scrollVer' }, { view: 'scrollbar', id: 'gridScroll', group: 'horizontal' }] },
        { resizer: true, width: 1 },
        { rows: [{ view: 'timeline', scrollX: 'scrollHor', scrollY: 'scrollVer' }, { view: 'scrollbar', id: 'scrollHor', group: 'horizontal' }] },
        { view: 'scrollbar', id: 'scrollVer' },
      ],
    },
  });
  gantt.config.columns = [
    { name: 'mspId', label: 'ID', width: 38, align: 'right', template: (t) => esc(t.mspId) },
    { name: 'wbs', label: 'WBS', width: 52, template: (t) => esc(t.wbs) },
    { name: 'text', label: 'Task name', tree: true, width: 210, resize: true, template: (t) => esc(t.text) },
    { name: 'startText', label: 'Start', width: 86, template: (t) => esc(t.startText) },
    { name: 'finishText', label: 'Finish', width: 86, template: (t) => esc(t.finishText) },
    { name: 'durText', label: 'Duration', width: 70, align: 'right', template: (t) => esc(t.durText) },
    { name: 'pct', label: '% Comp.', width: 64, align: 'right', template: (t) => `${esc(t.pct)}%` },
    { name: 'resourceNames', label: 'Resources', width: 150, resize: true, template: (t) => esc(t.resourceNames) },
    { name: 'predecessorText', label: 'Predecessors', width: 88, resize: true, template: (t) => esc(t.predecessorText) },
  ];
  gantt.templates.task_text = (s, e, t) => (t.type === 'milestone' ? '' : esc(t.text));
  gantt.templates.rightside_text = (s, e, t) => (t.type === 'milestone' ? `${esc(t.text)}${t.resourceNames ? ` · ${esc(t.resourceNames)}` : ''}` : esc(t.resourceNames));
  gantt.templates.task_class = (s, e, t) => [t.type === 'project' ? 'mspv-summary' : '', t.critical ? 'mspv-critical' : '', t.unscheduled ? 'mspv-unscheduled' : ''].join(' ');
  gantt.templates.grid_row_class = (s, e, t) => (t.type === 'project' ? 'mspv-summary-row' : '');
  gantt.templates.link_class = (l) => `mspv-link-${l.mspType}`;
  gantt.templates.tooltip_text = (s, e, t) => [
    `<b>${esc(t.mspId)}. ${esc(t.text)}</b>`,
    t.wbs ? `WBS: ${esc(t.wbs)}` : '',
    `Start: ${esc(fmtDateTime(t.rawStart))}`,
    `Finish: ${esc(fmtDateTime(t.rawFinish))}`,
    `Duration: ${esc(t.durText)} · ${esc(t.pct)}% complete`,
    t.resourceNames ? `Resources: ${esc(t.resourceNames)}` : '',
    t.predecessorText ? `Predecessors: ${esc(t.predecessorText)}` : '',
    t.successorText ? `Successors: ${esc(t.successorText)}` : '',
  ].filter(Boolean).join('<br>');
  gantt.ext.zoom.init({ levels: ZOOM_LEVELS });
  gantt.attachEvent('onTaskClick', (id) => { onSelect(Number(id)); return true; });
  gantt.attachEvent('onTaskDblClick', () => false);
  gantt.attachEvent('onBeforeLightbox', () => false);
  gantt.init(container);
  ready = true;
}

/** Picks a zoom level that fits the project span on screen. */
function autoZoom(vm, widthPx) {
  const s = vm.meta.start;
  const f = vm.meta.finish;
  if (s == null || f == null) return 'week';
  const days = Math.max(1, (f - s) / 86400000);
  const cols = Math.max(4, (widthPx - 840) / 60);
  if (days / 1 <= cols) return 'day';
  if (days / 7 <= cols) return 'week';
  if (days / 30 <= cols * 1.4) return 'month';
  if (days / 91 <= cols * 1.4) return 'quarter';
  return 'year';
}

export function renderGantt(container, vm, select) {
  onSelect = select;
  if (!ready) init(container);
  gantt.clearAll();
  const data = vm.tasks.map((t) => {
    const hasDates = t.start != null && t.finish != null;
    const start = toLocalDate(t.start);
    let end = toLocalDate(t.finish);
    const type = t.milestone ? 'milestone' : t.summary ? 'project' : 'task';
    if (type !== 'milestone' && hasDates && end <= start) end = new Date(start.getTime() + 3600000);
    return {
      id: t.uid, parent: t.parent ?? 0, text: t.name, type, open: true,
      start_date: hasDates ? start : undefined,
      end_date: hasDates ? (type === 'milestone' ? start : end) : undefined,
      unscheduled: !hasDates,
      progress: Math.max(0, Math.min(1, t.percent / 100)),
      mspId: t.id, wbs: t.wbs, critical: t.critical, rawStart: t.start, rawFinish: t.finish,
      startText: fmtDateShort(t.start), finishText: fmtDateShort(t.finish), durText: fmtDuration(t.duration, t.estimated), pct: t.percent,
      resourceNames: t.resourceNames, predecessorText: t.predecessorText, successorText: t.successorText,
    };
  });
  const links = vm.links.map((l) => ({ id: l.id, source: l.from, target: l.to, type: LINK_TYPE[l.type] || '0', lag: 0, mspType: l.type, mspLag: fmtLag(l.lag) }));
  gantt.parse({ data, links });
  const level = autoZoom(vm, container.clientWidth || 1200);
  gantt.ext.zoom.setLevel(level);
  gantt.render();
  return level;
}

export const clearGantt = () => { if (ready) gantt.clearAll(); };
export const setZoom = (level) => { if (ready) gantt.ext.zoom.setLevel(level); };
export const resizeGantt = () => { if (ready) gantt.setSizes(); };
export const selectInGantt = (uid) => { if (ready && gantt.isTaskExists(uid)) { gantt.selectTask(uid); gantt.showTask(uid); } };
export const expandAll = (open) => {
  if (!ready) return;
  gantt.batchUpdate(() => gantt.eachTask((t) => { t.$open = open; }));
  gantt.render();
};
export { LINK_NAMES };
