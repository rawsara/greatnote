import type { PathSink } from './curve';
import type { ShapeObj, TapeObj } from './model';

const KAPPA = 0.5522847498;

/** 도형 중심선 경로 */
export function traceShape(sink: PathSink, s: ShapeObj): void {
  const { x1, y1, x2, y2 } = s;
  switch (s.shape) {
    case 'line':
      sink.moveTo(x1, y1);
      sink.lineTo(x2, y2);
      break;
    case 'arrow': {
      sink.moveTo(x1, y1);
      sink.lineTo(x2, y2);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.min(Math.hypot(x2 - x1, y2 - y1) * 0.4, 10 + s.width * 3);
      for (const d of [-0.45, 0.45]) {
        sink.moveTo(x2, y2);
        sink.lineTo(x2 - Math.cos(ang + d) * len, y2 - Math.sin(ang + d) * len);
      }
      break;
    }
    case 'rect': {
      const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
      sink.moveTo(l, t);
      sink.lineTo(r, t);
      sink.lineTo(r, b);
      sink.lineTo(l, b);
      sink.closePath();
      break;
    }
    case 'ellipse': {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      const ox = rx * KAPPA, oy = ry * KAPPA;
      sink.moveTo(cx - rx, cy);
      sink.bezierCurveTo(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry);
      sink.bezierCurveTo(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy);
      sink.bezierCurveTo(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry);
      sink.bezierCurveTo(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy);
      sink.closePath();
      break;
    }
  }
}

/**
 * 도형 → 폴리라인(stride 3, w=1). 부분 지우개·올가미 판정에 사용.
 * arrow 는 머리를 제외한 몸통만 반환한다.
 */
export function shapeToPolyline(s: ShapeObj, step = 3): number[] {
  const { x1, y1, x2, y2 } = s;
  const out: number[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number, includeEnd: boolean) => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let i = 0; i < (includeEnd ? n + 1 : n); i++) {
      const t = i / n;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, 1);
    }
  };
  switch (s.shape) {
    case 'line':
    case 'arrow':
      seg(x1, y1, x2, y2, true);
      break;
    case 'rect': {
      const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
      seg(l, t, r, t, false);
      seg(r, t, r, b, false);
      seg(r, b, l, b, false);
      seg(l, b, l, t, true);
      break;
    }
    case 'ellipse': {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      const n = Math.max(12, Math.ceil((Math.PI * (rx + ry)) / step));
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 1);
      }
      break;
    }
  }
  return out;
}

/** 테이프의 사각형 꼭짓점 [x,y]*4 */
export function tapePolygon(t: TapeObj): number[] {
  const dx = t.x2 - t.x1, dy = t.y2 - t.y1;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * (t.thickness / 2), ny = (dx / l) * (t.thickness / 2);
  return [t.x1 + nx, t.y1 + ny, t.x2 + nx, t.y2 + ny, t.x2 - nx, t.y2 - ny, t.x1 - nx, t.y1 - ny];
}

export function traceTape(sink: PathSink, t: TapeObj): void {
  const p = tapePolygon(t);
  sink.moveTo(p[0], p[1]);
  for (let i = 2; i < 8; i += 2) sink.lineTo(p[i], p[i + 1]);
  sink.closePath();
}
