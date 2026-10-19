import {
  TOOL_PRESETS, buildOutline, traceCenterline, traceOutline, traceShape, traceTape,
  type BBox, type ImageObj, type InkDocument, type InkObject, type Page, type PaperKind, type TextObj,
} from '@inknote/core';

// ── 이미지: 에셋 id → 디코딩된 이미지 (ImageManager 가 등록) ──
let imageSource: (assetId: string) => CanvasImageSource | null = () => null;
export function setImageSource(fn: (assetId: string) => CanvasImageSource | null): void {
  imageSource = fn;
}

export const TEXT_FONT = `system-ui, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif`;
export const TEXT_LINE = 1.28;

export function textFont(o: Pick<TextObj, 'bold' | 'fontSize'>): string {
  return `${o.bold ? '700 ' : ''}${o.fontSize}px ${TEXT_FONT}`;
}

const layoutCache = new WeakMap<TextObj, string[]>();
let measureCtx: CanvasRenderingContext2D | null = null;

/** 줄바꿈: 공백 단위, 한 단어가 폭을 넘으면 글자 단위 (한글·긴 영단어) */
export function layoutText(o: TextObj): string[] {
  let lines = layoutCache.get(o);
  if (lines) return lines;
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!;
  ctx.font = textFont(o);
  lines = [];
  const fits = (t: string) => ctx.measureText(t).width <= o.w;
  for (const para of o.text.split('\n')) {
    let cur = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      if (fits(cur + word)) {
        cur += word;
        continue;
      }
      if (cur.trim()) {
        lines.push(cur.trimEnd());
        cur = word.trimStart();
      } else cur += word;
      // 단어 하나가 폭보다 길면 글자 단위로 자름 (한글 문장, 긴 영단어)
      while (!fits(cur) && cur.length > 1) {
        let k = cur.length - 1;
        while (k > 1 && !fits(cur.slice(0, k))) k--;
        lines.push(cur.slice(0, k));
        cur = cur.slice(k);
      }
    }
    lines.push(cur.trimEnd());
  }
  layoutCache.set(o, lines);
  return lines;
}

export function drawText(ctx: CanvasRenderingContext2D, o: TextObj): void {
  ctx.font = textFont(o);
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'top';
  const lh = o.fontSize * TEXT_LINE;
  layoutText(o).forEach((line, i) => ctx.fillText(line, o.x, o.y + i * lh + (lh - o.fontSize) / 2));
}

function drawImageObj(ctx: CanvasRenderingContext2D, o: ImageObj): void {
  const src = imageSource(o.assetId);
  ctx.globalAlpha = o.opacity;
  if (src) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, o.x, o.y, o.w, o.h);
    return;
  }
  // 아직 로딩 중이거나 이 기기에서 열 수 없는 형식(HEIC 등)
  ctx.fillStyle = '#eef1f5';
  ctx.fillRect(o.x, o.y, o.w, o.h);
  ctx.strokeStyle = '#b8c2cc';
  ctx.lineWidth = 1;
  ctx.strokeRect(o.x, o.y, o.w, o.h);
}

/**
 * 벡터 객체 → Canvas2D 렌더링.
 *
 * 객체는 불변이므로 Path2D 를 WeakMap 에 캐시한다. 줌/스크롤 때는 경로를 다시 만들지 않고
 * ctx 변환만 바꿔 같은 Path2D 를 재사용 → 확대해도 항상 선명한 벡터 렌더링.
 */
const pathCache = new WeakMap<InkObject, Path2D>();

function buildPath(o: InkObject): Path2D {
  const p = new Path2D();
  if (o.type === 'image' || o.type === 'text') p.rect(o.x, o.y, o.w, o.h);
  else if (o.type === 'stroke') {
    if (TOOL_PRESETS[o.tool].variable) traceOutline(p, buildOutline(o.pts, o.width));
    else traceCenterline(p, o.pts);
  } else if (o.type === 'shape') traceShape(p, o);
  else traceTape(p, o);
  return p;
}

export function objectPath(o: InkObject, cache = true): Path2D {
  if (!cache) return buildPath(o);
  let p = pathCache.get(o);
  if (!p) pathCache.set(o, (p = buildPath(o)));
  return p;
}

// 연필 질감: 색상별 노이즈 패턴
const grainCache = new Map<string, CanvasPattern>();
let grainCtx: CanvasRenderingContext2D | null = null;

function grainPattern(color: string): CanvasPattern | string {
  let pat = grainCache.get(color);
  if (pat) return pat;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const r = parseInt(color.slice(1, 3), 16), gg = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  // 흑연 질감: 픽셀 노이즈 + 결 방향(사선) 줄무늬 + 약한 금속광(밝은 회색 섞기)
  let seed = 1234567;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const streak = Array.from({ length: size * 2 }, rnd);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const n = rnd();
    const st = streak[(x + y) % (size * 2)];
    const a = 0.25 + 0.75 * Math.min(1, n * n * 0.7 + st * 0.55);
    const sheen = 0.18 * st;
    img.data[i * 4] = Math.round(r + (150 - r) * sheen);
    img.data[i * 4 + 1] = Math.round(gg + (150 - gg) * sheen);
    img.data[i * 4 + 2] = Math.round(b + (155 - b) * sheen);
    img.data[i * 4 + 3] = Math.round(255 * a);
  }
  g.putImageData(img, 0, 0);
  grainCtx ??= document.createElement('canvas').getContext('2d');
  pat = grainCtx?.createPattern(c, 'repeat') ?? undefined;
  if (!pat) return color;
  pat.setTransform(new DOMMatrix().scale(0.35));
  grainCache.set(color, pat);
  return pat;
}

export interface DrawOpts {
  cache?: boolean;
  /** 테이프 강제 표시 상태 (미리보기용) */
  tapeAlpha?: number;
}

export function drawObject(ctx: CanvasRenderingContext2D, o: InkObject, opts: DrawOpts = {}): void {
  if (o.type === 'image' || o.type === 'text') {
    ctx.save();
    if (o.type === 'image') drawImageObj(ctx, o);
    else drawText(ctx, o);
    ctx.restore();
    return;
  }
  const path = objectPath(o, opts.cache ?? true);
  ctx.save();
  switch (o.type) {
    case 'stroke': {
      const preset = TOOL_PRESETS[o.tool];
      ctx.globalAlpha = o.opacity;
      if (preset.blend === 'multiply') ctx.globalCompositeOperation = 'multiply';
      if (preset.variable) {
        ctx.fillStyle = preset.texture === 'grain' ? grainPattern(o.color) : o.color;
        ctx.fill(path, 'nonzero');
      } else {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.width;
        ctx.lineCap = preset.cap;
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
      break;
    }
    case 'shape':
      ctx.globalAlpha = o.opacity;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      break;
    case 'tape': {
      if (o.revealed) {
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = o.color;
        ctx.fill(path);
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = o.color;
        ctx.stroke(path);
      } else {
        ctx.globalAlpha = opts.tapeAlpha ?? 1;
        ctx.fillStyle = o.color;
        ctx.fill(path);
        // 테이프 질감 (사선)
        ctx.clip(path);
        ctx.globalAlpha = 0.12;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        const minX = Math.min(o.x1, o.x2) - o.thickness, maxX = Math.max(o.x1, o.x2) + o.thickness;
        const minY = Math.min(o.y1, o.y2) - o.thickness, maxY = Math.max(o.y1, o.y2) + o.thickness;
        ctx.beginPath();
        for (let x = minX - (maxY - minY); x < maxX; x += 5) {
          ctx.moveTo(x, maxY);
          ctx.lineTo(x + (maxY - minY), minY);
        }
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/** bg 레이어용: 형광펜 (잉크 아래, multiply) */
export function drawUnderLayer(ctx: CanvasRenderingContext2D, objs: InkObject[], hidden?: Set<string>): void {
  for (const o of objs) if (o.type === 'stroke' && o.tool === 'highlighter' && !hidden?.has(o.id)) drawObject(ctx, o);
}

/** ink 레이어용: 펜 획·도형·이미지·텍스트 (z 순서) → 테이프(맨 위) */
export function drawInkLayer(ctx: CanvasRenderingContext2D, objs: InkObject[], hidden?: Set<string>): void {
  const visible = hidden?.size ? objs.filter((o) => !hidden.has(o.id)) : objs;
  for (const o of visible) if (o.type !== 'tape' && !(o.type === 'stroke' && o.tool === 'highlighter')) drawObject(ctx, o);
  for (const o of visible) if (o.type === 'tape') drawObject(ctx, o);
}

/** 한 캔버스에 모든 레이어 (썸네일용): 형광펜 → 잉크/도형 → 테이프 */
export function drawObjects(ctx: CanvasRenderingContext2D, objs: InkObject[], hidden?: Set<string>): void {
  drawUnderLayer(ctx, objs, hidden);
  drawInkLayer(ctx, objs, hidden);
}

export function pageObjects(doc: InkDocument, page: Page, visible?: BBox): InkObject[] {
  if (!visible) return doc.objects(page.id);
  const full = visible.minX <= 0 && visible.minY <= 0 && visible.maxX >= page.width && visible.maxY >= page.height;
  if (full) return doc.objects(page.id);
  return doc.query(page.id, visible).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
}

/** 속지 템플릿 (줄/모눈/점) */
export function drawPaper(ctx: CanvasRenderingContext2D, page: Page, kind: PaperKind, zoom: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, page.width, page.height);
  if (kind === 'blank') return;
  ctx.save();
  const hair = Math.max(0.35, 0.6 / zoom);
  if (kind === 'lined') {
    ctx.strokeStyle = '#b9d3ee';
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (let y = 72; y < page.height - 24; y += 24) {
      ctx.moveTo(28, y);
      ctx.lineTo(page.width - 28, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#f2b8b8';
    ctx.beginPath();
    ctx.moveTo(64, 0);
    ctx.lineTo(64, page.height);
    ctx.stroke();
  } else if (kind === 'grid') {
    ctx.strokeStyle = '#d7e3ef';
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (let x = 18; x < page.width; x += 18) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, page.height);
    }
    for (let y = 18; y < page.height; y += 18) {
      ctx.moveTo(0, y);
      ctx.lineTo(page.width, y);
    }
    ctx.stroke();
  } else if (kind === 'dotted') {
    ctx.fillStyle = '#b8c2cc';
    const r = Math.max(0.6, 0.9 / zoom);
    for (let x = 18; x < page.width; x += 18) for (let y = 18; y < page.height; y += 18) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
