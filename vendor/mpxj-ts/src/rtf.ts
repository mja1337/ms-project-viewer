/**
 * The plain text of an RTF document, as Project stores task and resource
 * notes: paragraphs and line breaks kept, formatting dropped, \'hh and \uN
 * characters decoded, and destination groups (fonts, colours, pictures)
 * skipped. Text that is not RTF is returned as it is.
 */
export function rtfToText(rtf: string): string {
  if (!rtf.startsWith('{\\rtf')) return rtf.trim();
  let out = '';
  let i = 0;
  const skipStack: boolean[] = [];
  let skip = false;
  let ucSkip = 1;
  let pendingSkip = 0;
  const cp1252 = new TextDecoder('windows-1252');
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') {
      skipStack.push(skip);
      i++;
      // {\*\destination ...} and known non-text destinations are skipped whole.
      const m = /^\\(\*|fonttbl|colortbl|stylesheet|info|pict|object|header|footer|listtable|listoverridetable|rsidtbl|generator|themedata|datastore|latentstyles|xmlnstbl)/.exec(rtf.slice(i, i + 24));
      if (m) skip = true;
      continue;
    }
    if (c === '}') {
      skip = skipStack.pop() ?? false;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (!skip) out += next;
        i += 2;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        if (pendingSkip > 0) pendingSkip--;
        else if (!skip) out += cp1252.decode(new Uint8Array([parseInt(hex, 16) || 32]));
        i += 4;
        continue;
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] === undefined ? null : Number(m[2]);
      if (skip) continue;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') out += '\n';
      else if (word === 'tab') out += '\t';
      else if (word === 'uc' && arg !== null) ucSkip = arg;
      else if (word === 'u' && arg !== null) {
        out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
        pendingSkip = ucSkip;
      } else if (word === 'emdash') out += '—';
      else if (word === 'endash') out += '–';
      else if (word === 'bullet') out += '•';
      else if (word === 'lquote') out += '‘';
      else if (word === 'rquote') out += '’';
      else if (word === 'ldblquote') out += '“';
      else if (word === 'rdblquote') out += '”';
      continue;
    }
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (pendingSkip > 0) pendingSkip--;
    else if (!skip) out += c;
    i++;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
