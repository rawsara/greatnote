// legacy 빌드: 최신 JS API 를 폴리필해 구형 iOS WKWebView / Android WebView 에서도 동작
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildTextLines, type TextItem, type TextLine } from '@inknote/core';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfInfo {
  pageCount: number;
  pages: Array<{ width: number; height: number }>;
}

/** PDF 바이트에서 페이지 수/크기(pt, 회전 반영) 추출 */
export async function inspectPdf(bytes: ArrayBuffer): Promise<PdfInfo> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height });
  }
  await doc.destroy();
  return { pageCount: pages.length, pages };
}

interface Bitmap {
  canvas: HTMLCanvasElement;
  scale: number;
}

const MAX_SIDE = 4096;
const MAX_PIXELS = 80e6; // 전체 캐시 상한 (모바일 메모리 고려)

/**
 * PDF 페이지 → 비트맵 캐시.
 * - 줌 단계(√2 배수)로 양자화한 해상도로 렌더 → 확대 시 다시 선명하게
 * - 더 낮은 해상도로는 다시 그리지 않음(다운그레이드 없음), 렌더 중엔 기존 비트맵을 늘려서 표시
 * - 렌더는 pdf.js 워커에서 비동기로 수행되어 필기 입력을 막지 않는다
 */
export class PdfManager {
  private docs = new Map<string, Promise<PDFDocumentProxy | null>>();
  private bitmaps = new Map<string, Bitmap>();
  private pending = new Set<string>();
  private queue: Array<{ key: string; assetId: string; pageIndex: number; scale: number }> = [];
  private running = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly loadBytes: (assetId: string) => Promise<ArrayBuffer | null>) {}

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 에셋 바이트가 나중에 도착(동기화)했을 때 다시 시도 */
  retry(assetId: string): void {
    const p = this.docs.get(assetId);
    if (p) void p.then((d) => !d && this.docs.delete(assetId)).then(() => this.emit());
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private open(assetId: string): Promise<PDFDocumentProxy | null> {
    let p = this.docs.get(assetId);
    if (!p) {
      p = this.loadBytes(assetId).then((bytes) =>
        bytes ? pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise : null,
      ).catch((e) => {
        console.error('PDF 로드 실패', e);
        return null;
      });
      this.docs.set(assetId, p);
    }
    return p;
  }

  /** 즉시 사용 가능한 최선의 비트맵을 반환하고, 필요하면 더 선명한 렌더를 예약 */
  getBitmap(assetId: string, pageIndex: number, wantScale: number, pageW: number, pageH: number): Bitmap | null {
    const key = `${assetId}:${pageIndex}`;
    const q = Math.pow(Math.SQRT2, Math.ceil(Math.log(Math.max(0.25, wantScale)) / Math.log(Math.SQRT2)));
    const scale = Math.min(q, MAX_SIDE / Math.max(pageW, pageH));
    const bm = this.bitmaps.get(key);
    if (bm) {
      this.bitmaps.delete(key);
      this.bitmaps.set(key, bm); // LRU 갱신
    }
    if ((!bm || bm.scale < scale * 0.99) && !this.pending.has(key)) {
      this.pending.add(key);
      this.queue.push({ key, assetId, pageIndex, scale });
      this.pump();
    }
    return bm ?? null;
  }

  private pump(): void {
    while (this.running < 2 && this.queue.length) {
      const job = this.queue.pop()!; // 최근 요청 우선(현재 보고 있는 페이지)
      this.running++;
      void this.render(job).finally(() => {
        this.running--;
        this.pending.delete(job.key);
        this.pump();
      });
    }
  }

  private async render(job: { key: string; assetId: string; pageIndex: number; scale: number }): Promise<void> {
    const doc = await this.open(job.assetId);
    if (!doc) return;
    const page = await doc.getPage(job.pageIndex + 1);
    const vp = page.getViewport({ scale: job.scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, viewport: vp }).promise;
    const prev = this.bitmaps.get(job.key);
    if (prev && prev.scale >= job.scale) return;
    this.bitmaps.delete(job.key);
    this.bitmaps.set(job.key, { canvas, scale: job.scale });
    this.evict();
    this.emit();
  }

  private evict(): void {
    let total = 0;
    for (const b of this.bitmaps.values()) total += b.canvas.width * b.canvas.height;
    for (const [k, b] of this.bitmaps) {
      if (total <= MAX_PIXELS) break;
      total -= b.canvas.width * b.canvas.height;
      b.canvas.width = b.canvas.height = 0;
      this.bitmaps.delete(k);
    }
  }

  // ── 글자 (밑줄 자동 맞춤·검색용) ──
  private itemCache = new Map<string, TextItem[] | Promise<TextItem[]>>();
  private lineCache = new Map<string, TextLine[]>();

  /** 캐시된 글자 줄 (없으면 추출을 시작하고 null) */
  textLines(assetId: string, pageIndex: number): TextLine[] | null {
    const key = `${assetId}:${pageIndex}`;
    const lines = this.lineCache.get(key);
    if (lines) return lines;
    const items = this.textItems(assetId, pageIndex);
    if (!items) return null;
    const built = buildTextLines(items);
    this.lineCache.set(key, built);
    return built;
  }

  /** 캐시된 글자 조각 (없으면 추출을 시작하고 null) */
  textItems(assetId: string, pageIndex: number): TextItem[] | null {
    const v = this.itemCache.get(`${assetId}:${pageIndex}`);
    if (Array.isArray(v)) return v;
    if (!v) void this.loadTextItems(assetId, pageIndex);
    return null;
  }

  /** 글자 조각 추출 (검색 전에 PDF 페이지들을 미리 읽을 때) */
  loadTextItems(assetId: string, pageIndex: number): Promise<TextItem[]> {
    const key = `${assetId}:${pageIndex}`;
    const v = this.itemCache.get(key);
    if (v) return Promise.resolve(v);
    const p = this.extractText(assetId, pageIndex).catch(() => [] as TextItem[]);
    this.itemCache.set(key, p);
    void p.then((items) => this.itemCache.set(key, items));
    return p;
  }

  private async extractText(assetId: string, pageIndex: number): Promise<TextItem[]> {
    const doc = await this.open(assetId);
    if (!doc) return [];
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      // 텍스트 행렬 × 뷰포트 행렬 → 페이지 좌표(좌상단 원점, 회전 반영)
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(t[2], t[3]);
      if (Math.abs(t[1]) > Math.abs(t[0]) * 0.05) continue; // 가로쓰기만
      const scaleX = Math.hypot(t[0], t[1]) / Math.hypot(it.transform[0], it.transform[1] || 0) || 1;
      items.push({ x: t[4], baseline: t[5], width: it.width * scaleX, height: h, str: it.str });
    }
    return items;
  }

  destroy(): void {
    for (const p of this.docs.values()) void p.then((d) => d?.destroy());
    this.docs.clear();
    this.bitmaps.clear();
  }
}
