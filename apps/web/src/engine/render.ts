import {
  TOOL_PRESETS, buildOutline, traceCenterline, traceOutline, traceShape, traceTape,
  type BBox, type InkDocument, type InkObject, type Page, type PaperKind,
} from '@inknote/core';

/**
 * 벡터 객체 → Canvas2D 렌더링.
 *
 * 객체는 불변이므로 Path2D 를 WeakMap 에 캐시한다. 줌/스크롤 때는 경로를 다시 만들지 않고
 * ctx 변환만 바꿔 같은 Path2D 를 재사용 → 확대해도 항상 선명한 벡터 렌더링.
 */
const pathCache = new WeakMap<InkObject, Path2D>();

function buildPath(o: InkObject): Path2D {
  const p = new Path2D();
  if (o.type === 'stroke') {
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
  let seed = 1234567;
  for (let i = 0; i < size * size; i++) {
    seed = (seed * 16807) % 2147483647;
    const n = seed / 2147483647;
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.round(255 * (0.42 + 0.58 * n * n));
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

/** 레이어 순서: 형광펜(잉크 아래) → 잉크/도형 → 테이프(맨 위) */
export function drawObjects(ctx: CanvasRenderingContext2D, objs: InkObject[], hidden?: Set<string>): void {
  const visible = hidden?.size ? objs.filter((o) => !hidden.has(o.id)) : objs;
  for (const o of visible) if (o.type === 'stroke' && o.tool === 'highlighter') drawObject(ctx, o);
  for (const o of visible) if ((o.type === 'stroke' && o.tool !== 'highlighter') || o.type === 'shape') drawObject(ctx, o);
  for (const o of visible) if (o.type === 'tape') drawObject(ctx, o);
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
