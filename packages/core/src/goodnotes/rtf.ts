/**
 * Apple RTF(굿노트 텍스트 상자) → 일반 텍스트 + 글자 크기·굵기·색.
 * 글꼴마다 charset 이 다르다 (129 = 한국어 CP949, 0 = CP1252 …) — \'hh 바이트는 현재 글꼴의 인코딩으로 해석.
 */
const CHARSETS: Record<number, string> = { 0: 'windows-1252', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 1: 'windows-1252' };

export interface RtfText {
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
}

function decoder(label: string): { decode(b: Uint8Array): string } {
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

export function rtfToText(rtf: Uint8Array): RtfText {
  let s = '';
  for (let k = 0; k < rtf.length; k++) s += String.fromCharCode(rtf[k]);
  const fonts = new Map<number, string>();
  for (const m of s.matchAll(/\\f(\d+)\\f\w+\\fcharset(\d+)/g)) fonts.set(+m[1], CHARSETS[+m[2]] ?? 'windows-1252');
  const colors: string[] = [];
  const ct = s.match(/\{\\colortbl;([^}]*)\}/);
  if (ct) {
    colors.push('#000000'); // 0번 = 기본(auto)
    for (const c of ct[1].split(';')) {
      const m = c.match(/\\red(\d+)\\green(\d+)\\blue(\d+)/);
      if (m) colors.push('#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join(''));
    }
  }
  const fs = s.match(/\\fs(\d+)/);
  const cf = s.match(/\\cf(\d+)/);
  const bold = /\\b(?![a-z])(?!0)/.test(s.slice(s.indexOf('\\pard') >= 0 ? s.indexOf('\\pard') : 0));

  const body = s.includes('\\pard') ? s.slice(s.lastIndexOf('\\pard')) : s;
  let out = '';
  let buf: number[] = [];
  let enc = 'windows-1252';
  const flush = () => {
    if (buf.length) out += decoder(enc).decode(new Uint8Array(buf));
    buf = [];
  };
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      const rest = body.slice(i);
      let m = rest.match(/^\\'([0-9a-fA-F]{2})/);
      if (m) {
        buf.push(parseInt(m[1], 16));
        i += 4;
        continue;
      }
      m = rest.match(/^\\u(-?\d+) ?\??/);
      if (m) {
        flush();
        out += String.fromCharCode(((+m[1] % 65536) + 65536) % 65536);
        i += m[0].length;
        continue;
      }
      m = rest.match(/^\\([a-zA-Z]+)(-?\d+)? ?/);
      if (m) {
        flush();
        if (m[1] === 'f' && m[2]) enc = fonts.get(+m[2]) ?? 'windows-1252';
        else if (m[1] === 'par' || m[1] === 'line') out += '\n';
        i += m[0].length;
        continue;
      }
      const nx = body[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') buf.push(nx.charCodeAt(0));
      else if (nx === '\n') {
        flush();
        out += '\n';
      }
      i += 2;
      continue;
    }
    if (c === '{' || c === '}') {
      flush();
      i++;
      continue;
    }
    if (c !== '\r' && c !== '\n') buf.push(c.charCodeAt(0));
    i++;
  }
  flush();
  return {
    text: out.replace(/^\n+|\n+$/g, ''),
    fontSize: fs ? +fs[1] / 2 : 12,
    bold,
    color: (cf && colors[+cf[1]]) || '#000000',
  };
}
