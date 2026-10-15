/** Formatting helpers. Project dates are wall-clock times held as UTC ms. */
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const shortFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: '2-digit' });
/** "02 Nov 26", for narrow grid columns. */
export const fmtDateShort = (ms) => (ms == null ? '' : shortFmt.format(new Date(ms)));
export const fmtDate = (ms) => (ms == null ? '' : dateFmt.format(new Date(ms)));
export const fmtDateTime = (ms) => (ms == null ? '' : dateTimeFmt.format(new Date(ms)));

/** Wall-clock UTC ms -> a local Date with the same digits (what the Gantt expects). */
export const toLocalDate = (ms) => {
  if (ms == null) return null;
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
};

const UNIT_NAMES = {
  m: ['min', 'mins'], em: ['emin', 'emins'], h: ['hr', 'hrs'], eh: ['ehr', 'ehrs'], d: ['day', 'days'], ed: ['eday', 'edays'],
  w: ['wk', 'wks'], ew: ['ewk', 'ewks'], mo: ['mon', 'mons'], emo: ['emon', 'emons'], y: ['yr', 'yrs'], ey: ['eyr', 'eyrs'], '%': ['%', '%'], 'e%': ['e%', 'e%'],
};
const SHORT = { m: 'm', em: 'em', h: 'h', eh: 'eh', d: 'd', ed: 'ed', w: 'w', ew: 'ew', mo: 'mo', emo: 'emo', y: 'y', ey: 'ey', '%': '%', 'e%': 'e%' };

export function fmtDuration(d, estimated = false) {
  if (!d) return '';
  const v = Math.round(d.value * 100) / 100;
  const n = UNIT_NAMES[d.units] || ['', ''];
  return `${v} ${v === 1 ? n[0] : n[1]}${estimated ? '?' : ''}`.replace(' %', '%');
}

/** "+2d", "-1h", "" for no lag. */
export function fmtLag(lag) {
  if (!lag || !lag.value) return '';
  const v = Math.round(lag.value * 100) / 100;
  return `${v > 0 ? '+' : ''}${v}${SHORT[lag.units] || ''}`;
}

export const LINK_NAMES = { FS: 'Finish-to-Start', SS: 'Start-to-Start', FF: 'Finish-to-Finish', SF: 'Start-to-Finish' };

export function fmtNumber(n, digits = 2) {
  if (n == null) return '';
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits }).format(n);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Everything read from a file is untrusted: escape before it goes into HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
