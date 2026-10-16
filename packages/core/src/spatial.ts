import type { BBox } from './geometry';

/**
 * 균일 격자 공간 인덱스 — 지우개/올가미/렌더링 컬링 시 후보 객체를 O(1)에 가깝게 찾는다.
 * 페이지 크기가 유한(수백~수천 pt)하므로 R-tree 보다 단순한 grid 가 충분히 빠르다.
 */
export class SpatialGrid {
  private cells = new Map<number, Set<string>>();
  private boxes = new Map<string, BBox>();

  constructor(private readonly cell = 96) {}

  private key(cx: number, cy: number): number {
    // 페이지 좌표는 음수가 될 수 있어 오프셋을 둔다
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  private forCells(b: BBox, fn: (k: number) => void): void {
    const c = this.cell;
    const x0 = Math.floor(b.minX / c), x1 = Math.floor(b.maxX / c);
    const y0 = Math.floor(b.minY / c), y1 = Math.floor(b.maxY / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(this.key(x, y));
  }

  insert(id: string, b: BBox): void {
    this.remove(id);
    this.boxes.set(id, b);
    this.forCells(b, (k) => {
      let s = this.cells.get(k);
      if (!s) this.cells.set(k, (s = new Set()));
      s.add(id);
    });
  }

  remove(id: string): void {
    const b = this.boxes.get(id);
    if (!b) return;
    this.boxes.delete(id);
    this.forCells(b, (k) => {
      const s = this.cells.get(k);
      if (s) {
        s.delete(id);
        if (!s.size) this.cells.delete(k);
      }
    });
  }

  query(b: BBox): Set<string> {
    const out = new Set<string>();
    this.forCells(b, (k) => {
      const s = this.cells.get(k);
      if (s) for (const id of s) {
        const ob = this.boxes.get(id)!;
        if (ob.minX <= b.maxX && ob.maxX >= b.minX && ob.minY <= b.maxY && ob.maxY >= b.minY) out.add(id);
      }
    });
    return out;
  }

  get size(): number {
    return this.boxes.size;
  }
}
