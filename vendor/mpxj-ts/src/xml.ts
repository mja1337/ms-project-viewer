/**
 * A small XML reader, enough for Project's XML (MSPDI): elements, attributes
 * and text, with the five standard entities and numeric character
 * references. No DTDs; comments, processing instructions and CDATA handled.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const decode = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()];
    });
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt === -1) {
      top.text += decode(src.slice(i));
      break;
    }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = end === -1 ? src.length : end + 1;
    } else {
      const end = src.indexOf('>', lt);
      if (end === -1) break;
      const body = src.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      const m = /^([^\s/>]+)([\s\S]*?)\/?$/.exec(body)!;
      const attrs = readAttrs(m[2], decode);
      const node: XmlNode = { name: m[1].replace(/^.*:/, ''), attrs, children: [], text: '' };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  return root;
}

/**
 * The name="value" pairs of a start tag, in one pass. A regex did this, but
 * on a tag holding a long run with no "=" it retried from every character:
 * a crafted 1 MB tag took minutes and froze the page.
 */
function readAttrs(body: string, decode: (s: string) => string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = body.length;
  const space = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let i = 0;
  while (i < n) {
    while (i < n && space(body[i])) i++;
    const nameStart = i;
    while (i < n && body[i] !== '=' && !space(body[i])) i++;
    const name = body.slice(nameStart, i);
    while (i < n && space(body[i])) i++;
    if (body[i] !== '=' || !name) {
      // Not an attribute (a stray word): move past it and go on.
      if (i === nameStart) i++;
      continue;
    }
    i++;
    while (i < n && space(body[i])) i++;
    const quote = body[i];
    if (quote !== '"' && quote !== "'") continue;
    const close = body.indexOf(quote, i + 1);
    if (close === -1) break;
    attrs[name] = decode(body.slice(i + 1, close));
    i = close + 1;
  }
  return attrs;
}

export function child(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find((c) => c.name === name);
}

export function children(n: XmlNode | undefined, name: string): XmlNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}

export function text(n: XmlNode | undefined, name: string): string {
  return child(n, name)?.text.trim() ?? '';
}
