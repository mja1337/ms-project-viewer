/**
 * mpxj-ts: reads Microsoft Project plans in the browser.
 *
 * .mpp and .mpt from Project 2000 to 2024 (a TypeScript port of MPXJ's MPP9,
 * MPP12 and MPP14 readers, https://github.com/joniles/mpxj), Project's XML
 * (MSPDI), MPX, and Primavera P6 XER.
 *
 * Copyright (c) 2000-2026 Jon Iles and the MPXJ contributors (the parts
 * ported from MPXJ); port and the rest (c) 2026 johnmcm.com.
 * Licensed under the GNU Lesser General Public License, version 2.1 or later:
 * see LICENSE. Source: /source/mpxj/ on johnmcm.com.
 */

import { readMpp, ProjectFileError } from './mpp14';
import { isMpx, readMpx } from './mpx';
import { readMspdi } from './mspdi';
import { isXer, readXer } from './xer';
import { Project } from './model';

export * from './model';
export { ProjectFileError };

export function readProject(bytes: Uint8Array): Project {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return readMpp(bytes);
  const text = decodeText(bytes);
  if (isMpx(text)) return readMpx(text);
  if (isXer(text)) return readXer(text);
  if (/^\s*</.test(text)) return readMspdi(text);
  throw new ProjectFileError('This does not look like a project file (.mpp, .xml, .mpx or Primavera .xer).', 'format');
}

/** UTF-8 (with or without BOM) or UTF-16 XML; MPX files from old Windows versions are ANSI. */
function decodeText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0x3c && b[1] === 0x00) return new TextDecoder('utf-16le').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}
