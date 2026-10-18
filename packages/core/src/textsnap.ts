/**
 * PDF 글자 줄 인식 → 밑줄 자동 맞춤.
 *
 * pdf.js 가 추출한 텍스트 조각(위치·폭·글자 크기)을 기준선(baseline) 별로 묶어 "줄"을 만들고,
 * 사용자가 대충 그은 밑줄을 가장 가까운 줄의 기준선 바로 아래로 옮긴 뒤
 * 시작·끝을 걸친 단어의 경계에 맞춘다.
 */
export interface TextItem {
  /** 페이지 좌표(pt, 좌상단 원점) */
  x: number;
  baseline: number;
  width: number;
  /** 글자 높이 */
  height: number;
  str: string;
}

export interface TextLine {
  baseline: number;
  height: number;
  x0: number;
  x1: number;
  /** 단어 단위 [x0, x1] */
  words: Array<[number, number]>;
}

/** 텍스트 조각 → 줄 (기준선이 글자 높이의 35% 이내면 같은 줄) */
export function buildTextLines(items: TextItem[]): TextLine[] {
  const sorted = items.filter((it) => it.str.trim() && it.width > 0 && it.height > 0).sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const lines: TextLine[] = [];
  for (const it of sorted) {
    let line = lines.find((l) => Math.abs(l.baseline - it.baseline) < 0.35 * Math.max(l.height, it.height));
    if (!line) {
      line = { baseline: it.baseline, height: it.height, x0: it.x, x1: it.x + it.width, words: [] };
      lines.push(line);
    }
    line.height = Math.max(line.height, it.height);
    line.x0 = Math.min(line.x0, it.x);
    line.x1 = Math.max(line.x1, it.x + it.width);
    // 조각 안의 단어 위치는 글자 수 비례로 추정 (pdf.js 는 조각 폭만 제공)
    const chars = it.str.length;
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(it.str))) {
      const a = it.x + (it.width * m.index) / chars;
      const b = it.x + (it.width * (m.index + m[0].length)) / chars;
      line.words.push([a, b]);
    }
  }
  for (const l of lines) l.words.sort((a, b) => a[0] - b[0]);
  return lines;
}

export interface UnderlineSnap {
  x0: number;
  x1: number;
  y: number;
}

/**
 * 밑줄 (x0..x1, y) 을 가장 가까운 글자 줄에 맞춘다. 맞출 줄이 없으면 null.
 * - 세로: 글자 몸통~기준선 아래 0.9×글자높이 범위에 있어야 그 줄의 밑줄로 인정
 * - 가로: 35% 이상 걸친 단어들의 [처음, 끝] 경계로 확장/축소
 */
export function snapUnderline(x0: number, x1: number, y: number, lines: TextLine[]): UnderlineSnap | null {
  if (x1 < x0) [x0, x1] = [x1, x0];
  let best: TextLine | null = null;
  let bestD = Infinity;
  for (const l of lines) {
    if (y < l.baseline - l.height * 0.6 || y > l.baseline + l.height * 0.9) continue;
    if (x1 < l.x0 - l.height || x0 > l.x1 + l.height) continue;
    const d = Math.abs(y - (l.baseline + l.height * 0.15));
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  if (!best) return null;
  let covered = best.words.filter(([a, b]) => Math.min(b, x1) - Math.max(a, x0) >= 0.35 * (b - a));
  if (!covered.length) {
    const mid = (x0 + x1) / 2;
    const nearest = best.words.reduce<[number, number] | null>(
      (n, w) => (!n || Math.abs((w[0] + w[1]) / 2 - mid) < Math.abs((n[0] + n[1]) / 2 - mid) ? w : n),
      null,
    );
    if (!nearest) return null;
    covered = [nearest];
  }
  return {
    x0: covered[0][0],
    x1: covered[covered.length - 1][1],
    y: best.baseline + Math.max(1.2, best.height * 0.14),
  };
}
