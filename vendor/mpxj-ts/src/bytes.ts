/**
 * Reading values out of .mpp byte blocks, after MPXJ's ByteArrayHelper and
 * MPPUtility (LGPL-2.1). All little-endian.
 */

import { Duration, TimeUnit } from './model';

/** 31 Dec 1983, from which .mpp dates count. */
const EPOCH = Date.UTC(1983, 11, 31);
const DAY = 86400000;

export function u8(d: Uint8Array, o: number): number {
  return d[o] ?? 0;
}

/** Unsigned 16-bit, as MPXJ's getShort (which masks to 0..65535). */
export function u16(d: Uint8Array, o: number): number {
  return (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8);
}

export function i32(d: Uint8Array, o: number): number {
  return (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8) | ((d[o + 2] ?? 0) << 16) | ((d[o + 3] ?? 0) << 24);
}

export function i64big(d: Uint8Array, o: number): bigint {
  let r = 0n;
  for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(d[o + i] ?? 0);
  return BigInt.asIntN(64, r);
}

export function f64(d: Uint8Array, o: number): number {
  if (o + 8 > d.length) return 0;
  const v = new DataView(d.buffer, d.byteOffset + o, 8).getFloat64(0, true);
  return Number.isNaN(v) ? 0 : v;
}

/** Days since the epoch (2 bytes at o+2) and tenths of a minute (2 bytes at o). */
export function timestamp(d: Uint8Array, o: number): number | null {
  if (o + 4 > d.length) return null;
  const days = u16(d, o + 2);
  if (days <= 1 || days === 65535) return null;
  let time = u16(d, o);
  if (time === 65535) time = 0;
  const result = EPOCH + days * DAY + time * 6000;
  if (days < 100 && new Date(result).getUTCSeconds() !== 0) return null;
  return result;
}

/** Minutes since midnight, stored in tenths of a minute. */
export function timeOfDay(d: Uint8Array, o: number): number {
  return Math.floor(u16(d, o) / 10) % 1440;
}

export function unicode(d: Uint8Array | null, o = 0, maxBytes = 0): string {
  if (!d || o >= d.length) return '';
  let end = d.length - ((d.length - o) % 2);
  for (let i = o; i + 1 < d.length; i += 2) {
    if (d[i] === 0 && d[i + 1] === 0) {
      end = i;
      break;
    }
  }
  if (maxBytes && end - o > maxBytes) end = o + maxBytes;
  return new TextDecoder('utf-16le').decode(d.subarray(o, end));
}

/** A single-byte string up to its first zero, as MPXJ's getString (each byte one character). */
export function ascii(d: Uint8Array | null, o = 0): string {
  if (!d) return '';
  let s = '';
  for (let i = o; i < d.length && d[i] !== 0; i++) s += String.fromCharCode(d[i]);
  return s;
}

export function guid(d: Uint8Array | null, o = 0): string {
  if (!d || d.length < o + 16) return '';
  const h = (i: number) => (d[o + i] ?? 0).toString(16).padStart(2, '0');
  const s = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15].map((i) => (i < 0 ? '-' : h(i))).join('');
  return /^[0-]+$/.test(s) ? '' : s;
}

/** Project's duration units codes (the low five bits). */
export function durationUnits(code: number, fallback: TimeUnit = 'd'): TimeUnit {
  switch (code & 0x1f) {
    case 3: return 'm';
    case 4: return 'em';
    case 5: return 'h';
    case 6: return 'eh';
    case 7: return 'd';
    case 8: return 'ed';
    case 9: return 'w';
    case 10: return 'ew';
    case 11: return 'mo';
    case 12: return 'emo';
    case 19: return '%';
    case 20: return 'e%';
    case 21: return fallback;
    default: return 'd';
  }
}

/** MPXJ's TimeUnit order, used where a file stores the enum's index. */
const TIME_UNIT_ORDER: TimeUnit[] = ['m', 'h', 'd', 'w', 'mo', '%', 'y', 'em', 'eh', 'ed', 'ew', 'emo', 'ey', 'e%'];
export function timeUnitByIndex(i: number): TimeUnit | null {
  return TIME_UNIT_ORDER[i] ?? null;
}

export interface Calendar {
  minutesPerDay: number;
  minutesPerWeek: number;
  daysPerMonth: number;
}

/** A duration stored in tenths of a minute, in the units given (MPPUtility.getAdjustedDuration). */
export function adjustedDuration(cal: Calendar, tenths: number, units: TimeUnit): Duration | null {
  if (tenths === -1) return null;
  switch (units) {
    case 'd': return { value: cal.minutesPerDay ? tenths / (cal.minutesPerDay * 10) : 0, units };
    case 'ed': return { value: tenths / (24 * 600), units };
    case 'w': return { value: cal.minutesPerWeek ? tenths / (cal.minutesPerWeek * 10) : 0, units };
    case 'ew': return { value: tenths / (60 * 24 * 7 * 10), units };
    case 'mo': return { value: cal.minutesPerDay && cal.daysPerMonth ? tenths / (cal.minutesPerDay * cal.daysPerMonth * 10) : 0, units };
    case 'emo': return { value: tenths / (60 * 24 * 30 * 10), units };
    default: return simpleDuration(tenths, units);
  }
}

/** MPPUtility.getDuration(double, TimeUnit): fixed factors. */
export function simpleDuration(value: number, units: TimeUnit): Duration {
  const div: Partial<Record<TimeUnit, number>> = { m: 10, em: 10, h: 600, eh: 600, d: 4800, ed: 14400, w: 24000, ew: 100800, mo: 96000, emo: 432000 };
  return { value: value / (div[units] ?? 1), units };
}
