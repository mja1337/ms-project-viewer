/** Plain HTML tables for tasks, dependencies and resources. All file text is escaped. */
import { esc, fmtDate, fmtDateTime, fmtDuration, fmtLag, fmtNumber, LINK_NAMES } from '../format.js';

const pct = (u) => (u == null ? '' : `${fmtNumber(u * 100, 0)}%`);
const hours = (h) => (h == null ? '' : `${fmtNumber(h, 2)} hrs`);

export function renderTasks(el, vm) {
  el.innerHTML = `<table class="mspv-table" data-testid="tasks-table">
    <thead><tr><th>ID</th><th>WBS</th><th>Task name</th><th>Start</th><th>Finish</th><th>Duration</th><th>% Comp.</th><th>Resources</th><th>Predecessors</th><th>Successors</th></tr></thead>
    <tbody>${vm.tasks.map((t) => `<tr data-uid="${t.uid}" class="${t.summary ? 'is-summary' : ''} ${t.milestone ? 'is-milestone' : ''}">
      <td class="num">${t.id}</td><td>${esc(t.wbs)}</td>
      <td style="padding-left:${0.5 + (t.level - 1) * 1.2}em">${t.milestone ? '◆ ' : ''}${esc(t.name)}</td>
      <td>${esc(fmtDate(t.start))}</td><td>${esc(fmtDate(t.finish))}</td><td class="num">${esc(fmtDuration(t.duration, t.estimated))}</td>
      <td class="num">${esc(t.percent)}%</td><td>${esc(t.resourceNames)}</td><td>${esc(t.predecessorText)}</td><td>${esc(t.successorText)}</td></tr>`).join('')}
    </tbody></table>`;
}

export function renderLinks(el, vm) {
  if (!vm.links.length) { el.innerHTML = '<p class="empty">This plan has no task dependencies.</p>'; return; }
  const t = (uid) => vm.byUid.get(uid);
  el.innerHTML = `<table class="mspv-table" data-testid="links-table">
    <thead><tr><th>Predecessor</th><th>Successor</th><th>Type</th><th>Lag</th><th>Predecessor finish</th><th>Successor start</th></tr></thead>
    <tbody>${vm.links.map((l) => `<tr>
      <td><a href="#" data-uid="${l.from}">${t(l.from).id}. ${esc(t(l.from).name)}</a></td>
      <td><a href="#" data-uid="${l.to}">${t(l.to).id}. ${esc(t(l.to).name)}</a></td>
      <td><span class="badge link-${l.type}">${l.type}</span> ${LINK_NAMES[l.type] || ''}</td>
      <td class="num">${esc(fmtLag(l.lag) || '0')}</td>
      <td>${esc(fmtDate(t(l.from).finish))}</td><td>${esc(fmtDate(t(l.to).start))}</td></tr>`).join('')}
    </tbody></table>`;
}

export function renderResources(el, vm) {
  if (!vm.resources.length) { el.innerHTML = '<p class="empty">This plan has no resources.</p>'; return; }
  el.innerHTML = `<table class="mspv-table" data-testid="resources-table">
    <thead><tr><th>ID</th><th>Resource name</th><th>Type</th><th>Initials</th><th>Group</th><th>Max units</th><th>Std. rate</th><th>Work</th><th>Assigned tasks</th></tr></thead>
    <tbody>${vm.resources.map((r) => `<tr>
      <td class="num">${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td>${esc(r.initials)}</td><td>${esc(r.group)}</td>
      <td class="num">${r.type === 'Work' ? esc(pct(r.maxUnits)) : ''}</td>
      <td class="num">${r.standardRate ? `${esc(vm.meta.currency)}${esc(fmtNumber(r.standardRate))}/${esc(r.rateUnits || 'h')}` : ''}</td>
      <td class="num">${esc(hours(r.work))}</td>
      <td>${r.assignments.length ? r.assignments.map((a) => `<a href="#" data-uid="${a.task}">${a.taskId}. ${esc(a.taskName)}</a>${a.units != null && r.type === 'Work' ? ` <span class="muted">(${esc(pct(a.units))})</span>` : ''}`).join('<br>') : '<span class="muted">none</span>'}</td>
    </tr>`).join('')}</tbody></table>`;
}

export function renderDetails(el, vm, uid) {
  const t = vm.byUid.get(uid);
  if (!t) { el.hidden = true; return; }
  const linkRow = (l, otherUid) => {
    const o = vm.byUid.get(otherUid);
    return `<li><a href="#" data-uid="${o.uid}">${o.id}. ${esc(o.name)}</a> <span class="badge link-${l.type}">${l.type}</span>${fmtLag(l.lag) ? ` lag ${esc(fmtLag(l.lag))}` : ''}</li>`;
  };
  const asg = vm.assignments.filter((a) => a.task === uid).map((a) => {
    const r = vm.resources.find((x) => x.uid === a.resource);
    return `<li>${esc(r.name)}${a.units != null && r.type === 'Work' ? ` (${esc(pct(a.units))})` : ''}${a.work != null ? ` · ${esc(hours(a.work))}` : ''}</li>`;
  });
  el.hidden = false;
  el.innerHTML = `<button class="close" title="Close" aria-label="Close details">×</button>
    <h3>${t.id}. ${esc(t.name)}</h3>
    <dl>
      <dt>WBS</dt><dd>${esc(t.wbs) || '—'}</dd>
      <dt>Start</dt><dd>${esc(fmtDateTime(t.start)) || '—'}</dd>
      <dt>Finish</dt><dd>${esc(fmtDateTime(t.finish)) || '—'}</dd>
      <dt>Duration</dt><dd>${esc(fmtDuration(t.duration, t.estimated)) || '—'}</dd>
      <dt>% complete</dt><dd>${esc(t.percent)}%</dd>
      <dt>Type</dt><dd>${t.milestone ? 'Milestone' : t.summary ? 'Summary task' : 'Task'}${t.critical ? ' · critical' : ''}${t.manual ? ' · manually scheduled' : ''}</dd>
      ${t.constraint ? `<dt>Constraint</dt><dd>${esc(t.constraint)}</dd>` : ''}
    </dl>
    <h4>Resources</h4>${asg.length ? `<ul>${asg.join('')}</ul>` : '<p class="muted">None assigned</p>'}
    <h4>Predecessors</h4>${t.predecessors.length ? `<ul>${t.predecessors.map((l) => linkRow(l, l.from)).join('')}</ul>` : '<p class="muted">None</p>'}
    <h4>Successors</h4>${t.successors.length ? `<ul>${t.successors.map((l) => linkRow(l, l.to)).join('')}</ul>` : '<p class="muted">None</p>'}
    ${t.notes ? `<h4>Notes</h4><p class="notes">${esc(t.notes)}</p>` : ''}`;
}
