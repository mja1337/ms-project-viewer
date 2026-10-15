import './styles.css';
import { readFile, READERS } from './readers/index.js';
import { buildViewModel } from './model.js';
import { renderGantt, clearGantt, setZoom, resizeGantt, selectInGantt, expandAll } from './views/gantt.js';
import { renderTasks, renderLinks, renderResources, renderDetails } from './views/tables.js';
import { esc, fmtDate } from './format.js';

const $ = (s) => document.querySelector(s);
const fileInput = $('#file-input');
const readerSelect = $('#reader-select');
const status = $('#status');
const details = $('#details');
let vm = null;
let currentTab = 'gantt';

for (const r of READERS.filter((x) => x.enabled !== false)) {
  readerSelect.insertAdjacentHTML('beforeend', `<option value="${esc(r.id)}">${esc(r.label)}</option>`);
}

function setStatus(html, kind = 'info') {
  status.className = `status ${kind}`;
  status.innerHTML = html;
}

const HINTS = {
  password: 'Password-protected plans cannot be opened in the browser. In Project, remove the password (File › Save As › Tools › General Options) or use File › Save As › XML, then open the XML here.',
  version: 'This Project version is not supported by the in-browser reader. In Project, use File › Save As › XML and open the XML file here.',
  format: 'If this is a Project file, try File › Save As › XML in Project and open the XML here.',
};

async function open(file) {
  if (!file) return;
  setStatus(`Reading <b>${esc(file.name)}</b> in your browser…`);
  document.body.classList.add('busy');
  try {
    const { project, reader, fallbackErrors } = await readFile(file, readerSelect.value);
    vm = buildViewModel(project);
    document.body.classList.add('loaded');
    $('#project-title').textContent = vm.meta.title || file.name;
    $('#project-meta').innerHTML = [
      `<span>${esc(file.name)}</span>`,
      `<span>${esc(vm.meta.format)}</span>`,
      vm.meta.start != null ? `<span>${esc(fmtDate(vm.meta.start))} → ${esc(fmtDate(vm.meta.finish))}</span>` : '',
      vm.meta.statusDate != null ? `<span>Status date ${esc(fmtDate(vm.meta.statusDate))}</span>` : '',
      `<span data-testid="counts">${vm.tasks.length} tasks · ${vm.links.length} links · ${vm.resources.length} resources</span>`,
    ].join('');
    $('#count-tasks').textContent = vm.tasks.length;
    $('#count-links').textContent = vm.links.length;
    $('#count-resources').textContent = vm.resources.length;
    const fb = fallbackErrors.length ? ` (after ${esc(fallbackErrors.map((f) => f.reader).join(', '))} failed: ${esc(fallbackErrors[0].error?.message)})` : '';
    const warn = vm.meta.warnings.length ? `<br>Partly read: ${vm.meta.warnings.map(esc).join('; ')}` : '';
    setStatus(`Opened <b>${esc(file.name)}</b> with ${esc(reader.label)}${fb}. Nothing was uploaded.${warn}`, vm.meta.warnings.length ? 'warn' : 'ok');
    details.hidden = true;
    renderTasks($('#tab-tasks'), vm);
    renderLinks($('#tab-links'), vm);
    renderResources($('#tab-resources'), vm);
    showTab('gantt');
    $('#zoom').value = renderGantt($('#gantt'), vm, select);
  } catch (e) {
    console.warn('Could not read file:', e);
    clearView();
    setStatus(`<b>Could not open ${esc(file.name)}.</b> ${esc(e.message)}<br>${esc(HINTS[e.code] || HINTS.format)}`, 'error');
  } finally {
    document.body.classList.remove('busy');
    fileInput.value = '';
  }
}

function clearView() {
  vm = null;
  document.body.classList.remove('loaded');
  details.hidden = true;
  $('#project-title').textContent = 'No file open';
  $('#project-meta').innerHTML = '';
  for (const id of ['count-tasks', 'count-links', 'count-resources']) $(`#${id}`).textContent = '0';
  for (const id of ['tab-tasks', 'tab-links', 'tab-resources']) $(`#${id}`).innerHTML = '';
  clearGantt();
}

function select(uid) {
  if (!vm) return;
  renderDetails(details, vm, uid);
}

function showTab(name) {
  currentTab = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
  $('#gantt-tools').hidden = name !== 'gantt';
  if (name === 'gantt') requestAnimationFrame(resizeGantt);
}

$('#open-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => open(fileInput.files[0]));
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
$('#zoom').addEventListener('change', (e) => setZoom(e.target.value));
$('#expand').addEventListener('click', () => expandAll(true));
$('#collapse').addEventListener('click', () => expandAll(false));
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-uid]');
  if (a) { e.preventDefault(); const uid = Number(a.dataset.uid); select(uid); if (currentTab === 'gantt') selectInGantt(uid); }
  if (e.target.closest('#details .close')) details.hidden = true;
  const row = e.target.closest('#tab-tasks tr[data-uid]');
  if (row && !a) select(Number(row.dataset.uid));
});
// Drag and drop a file anywhere on the page.
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging'); open(e.dataTransfer.files[0]); });
window.addEventListener('resize', () => { if (currentTab === 'gantt') resizeGantt(); });
