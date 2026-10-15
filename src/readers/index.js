/**
 * The reader layer: the one swappable step between a file and the views.
 *
 * Every reader implements
 *     { id, label, accepts(file, bytes) -> boolean, read(bytes, file) -> Promise<Project> }
 * and returns the mpxj-ts `Project` shape (see vendor/mpxj-ts/src/model.ts):
 * plain objects with tasks, resources, assignments, calendars. src/model.js
 * turns that into the view model; the Gantt and tables never see a reader.
 *
 * To add or replace a reader (e.g. a localhost or cloud MPXJ converter),
 * register it here. Nothing else changes.
 */
import { mpxjTsReader } from './mpxjTs.js';
import { mspdiNativeReader } from './mspdiNative.js';
import { remoteReader } from './remote.js';

export const READERS = [mpxjTsReader, mspdiNativeReader, remoteReader];

export class ReadError extends Error {
  constructor(message, code = 'format', cause) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

const isOle = (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

/** What kind of file this is, from its first bytes (extensions lie). */
export function sniff(bytes, name = '') {
  if (isOle(bytes)) return 'mpp';
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).replace(/\0/g, '');
  if (/<Project[\s>]/.test(head) || /^\s*(\ufeff)?<\?xml/.test(head)) return 'xml';
  if (/^MPX/.test(head)) return 'mpx';
  if (/\.xml$/i.test(name)) return 'xml';
  return 'unknown';
}

/**
 * Reads a File with the chosen reader ('auto' or a reader id). In auto mode,
 * .mpp/.mpt/.mpx go to mpxj-ts; XML goes to mpxj-ts and falls back to the
 * built-in MSPDI reader if mpxj-ts fails.
 */
export async function readFile(file, readerId = 'auto') {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes, file.name);
  const enabled = READERS.filter((r) => r.enabled !== false);
  const chain = readerId === 'auto'
    ? enabled.filter((r) => r.auto !== false && r.accepts(kind))
    : enabled.filter((r) => r.id === readerId);
  if (!chain.length) {
    throw new ReadError(kind === 'unknown'
      ? 'This does not look like a Microsoft Project file (.mpp, .mpt, Project XML or .mpx).'
      : `The selected reader cannot open this kind of file (${kind}).`, 'format');
  }
  const errors = [];
  for (const reader of chain) {
    try {
      const project = await reader.read(bytes, file);
      return { project, reader, kind, fallbackErrors: errors };
    } catch (e) {
      errors.push({ reader: reader.id, error: e });
      // A password-protected plan will not open with another reader either.
      if (e && e.code === 'password') break;
    }
  }
  const first = errors[0].error;
  throw new ReadError(first?.message || String(first), first?.code || 'format', errors);
}
