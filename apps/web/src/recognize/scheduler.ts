import {
  groupStrokesIntoLines, inkSignature, isHandwriting, selectionBBox, wordsFromLine,
  type ChangeEvent, type HwrWord, type InkDocument, type Page, type StrokeObj,
} from '@inknote/core';
import { Capacitor } from '@capacitor/core';
import { InkRecognizer } from '@inknote/ink-recognizer';
import { drawObject } from '../engine/render';

/**
 * 손글씨 인식 스케줄러.
 *
 * 필기가 바뀐 페이지를 (쓰기를 멈추고 잠시 뒤) 기기 내장 인식기로 다시 인식해
 * 결과를 문서의 hwr 레코드로 저장한다. hwr 레코드는 동기화되므로 인식기가 없는 웹에서도 검색된다.
 * 페이지 필기 서명(inkSignature)이 저장된 결과와 같으면 다시 인식하지 않는다.
 */
export interface PageRecognizer {
  readonly engine: 'vision' | 'mlkit';
  recognize(page: Page, strokes: StrokeObj[]): Promise<HwrWord[]>;
}

export interface RecognitionStatus {
  engine: 'vision' | 'mlkit' | 'none';
  /** 인식 결과가 있는 페이지 수 */
  indexed: number;
  /** 인식 대기 중인 페이지 수 */
  pending: number;
  error?: string;
}

const IDLE_MS = 2200;

export class HwrScheduler {
  private queue = new Set<string>();
  private timers = new Map<string, number>();
  private running = false;
  private closed = false;
  private listeners = new Set<(s: RecognitionStatus) => void>();
  private unsub: () => void;
  status: RecognitionStatus;

  constructor(
    private doc: InkDocument,
    private recognizer: PageRecognizer | null,
  ) {
    this.status = { engine: recognizer?.engine ?? 'none', indexed: 0, pending: 0 };
    this.unsub = doc.on(this.onChange);
    this.refreshStatus();
    if (recognizer) {
      // 열자마자 전부 인식하지 않고, 화면이 자리 잡은 뒤 천천히
      window.setTimeout(() => {
        for (const p of doc.pages) if (this.needs(p.id)) this.queue.add(p.id);
        this.pump();
      }, 1500);
    }
  }

  onStatus(fn: (s: RecognitionStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private refreshStatus(patch: Partial<RecognitionStatus> = {}): void {
    const indexed = this.doc.pages.filter((p) => this.doc.hwr(p.id)?.words.length).length;
    this.status = { ...this.status, indexed, pending: this.queue.size + (this.running ? 1 : 0), ...patch };
    this.listeners.forEach((l) => l(this.status));
  }

  private needs(pageId: string): boolean {
    const strokes = this.doc.objects(pageId).filter(isHandwriting);
    const rec = this.doc.hwr(pageId);
    if (!strokes.length) return !!rec?.words.length; // 필기를 다 지웠으면 결과도 비움
    return rec?.sig !== inkSignature(strokes);
  }

  private onChange = (e: ChangeEvent): void => {
    if (e.hwr.size) this.refreshStatus();
    if (!this.recognizer || e.origin === 'load') return;
    for (const pid of e.pages) {
      clearTimeout(this.timers.get(pid));
      this.timers.set(pid, window.setTimeout(() => {
        this.timers.delete(pid);
        if (this.doc.page(pid) && this.needs(pid)) {
          this.queue.add(pid);
          this.pump();
        }
      }, IDLE_MS));
    }
  };

  private async pump(): Promise<void> {
    if (this.running || this.closed || !this.recognizer) return;
    const pid = this.queue.values().next().value as string | undefined;
    if (!pid) return this.refreshStatus();
    this.queue.delete(pid);
    this.running = true;
    this.refreshStatus();
    try {
      const page = this.doc.page(pid);
      if (page && this.needs(pid)) {
        const strokes = this.doc.objects(pid).filter(isHandwriting);
        const sig = inkSignature(strokes);
        const words = strokes.length ? await this.recognizer.recognize(page, strokes) : [];
        // 인식하는 사이에 필기가 또 바뀌었으면 버리고 다음 차례에 다시
        if (!this.closed && inkSignature(this.doc.objects(pid).filter(isHandwriting)) === sig) {
          this.doc.setHwr({ pageId: pid, sig, engine: this.recognizer.engine, words, at: Date.now() });
        }
      }
      this.refreshStatus({ error: undefined });
    } catch (e) {
      console.warn('손글씨 인식 실패', e);
      this.refreshStatus({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
    // 다음 페이지는 잠깐 쉬었다가 (필기 반응성 우선)
    if (!this.closed) window.setTimeout(() => void this.pump(), 250);
  }

  close(): void {
    this.closed = true;
    this.unsub();
    this.timers.forEach((t) => clearTimeout(t));
  }
}

// ───────────────────────── 인식기 ─────────────────────────

/** iOS: 필기 획만 흰 바탕에 검게 그린 이미지 → Apple Vision */
class VisionRecognizer implements PageRecognizer {
  readonly engine = 'vision' as const;
  constructor(private languages: string[]) {}

  async recognize(_page: Page, strokes: StrokeObj[]): Promise<HwrWord[]> {
    const b = selectionBBox(strokes);
    const pad = 12;
    const rx = b.minX - pad, ry = b.minY - pad, rw = b.maxX - b.minX + pad * 2, rh = b.maxY - b.minY + pad * 2;
    // 필기 영역만 잘라 충분한 해상도로 (긴 변 최대 2400px)
    const scale = Math.max(1, Math.min(4, 2400 / Math.max(rw, rh)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(rw * scale);
    canvas.height = Math.ceil(rh * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, -rx * scale, -ry * scale);
    for (const s of strokes) drawObject(ctx, { ...s, color: '#000000', opacity: 1, tool: s.tool === 'pencil' ? 'ballpoint' : s.tool }, { cache: false });
    const image = canvas.toDataURL('image/png').split(',')[1];
    canvas.width = canvas.height = 0;
    const { lines } = await InkRecognizer.recognizeImage({ image, languages: this.languages });
    const map = (r: { x: number; y: number; w: number; h: number }) => ({ x: rx + r.x * rw, y: ry + r.y * rh, w: r.w * rw, h: r.h * rh });
    const out: HwrWord[] = [];
    for (const line of lines) {
      const lb = map(line);
      const words: HwrWord[] = line.words?.length
        ? line.words.map((w) => ({ t: w.text, ...map(w) }))
        : wordsFromLine(line.text, { minX: lb.x, minY: lb.y, maxX: lb.x + lb.w, maxY: lb.y + lb.h });
      if (words.length && line.alts?.length) words[0].alt = line.alts.filter((a) => a && a !== line.text).slice(0, 4);
      out.push(...words);
    }
    return out;
  }
}

/** Android: 줄로 묶은 획 좌표 → ML Kit Digital Ink */
class MlkitRecognizer implements PageRecognizer {
  readonly engine = 'mlkit' as const;
  private ready: boolean;
  constructor(private language: string, ready: boolean) {
    this.ready = ready;
  }

  async recognize(_page: Page, strokes: StrokeObj[]): Promise<HwrWord[]> {
    if (!this.ready) {
      await InkRecognizer.prepare({ language: this.language });
      this.ready = true;
    }
    const byId = new Map(strokes.map((s) => [s.id, s]));
    const lines = groupStrokesIntoLines(strokes);
    const out: HwrWord[] = [];
    for (let i = 0; i < lines.length; i += 30) {
      const chunk = lines.slice(i, i + 30);
      const input = chunk.map((l) => {
        let t = 0;
        const strokes = l.ids.map((id) => {
          const s = byId.get(id)!;
          const pts: number[] = [];
          for (let k = 0; k < s.pts.length; k += 3) pts.push(s.pts[k] - l.bbox.minX, s.pts[k + 1] - l.bbox.minY, (t += 8));
          t += 120; // 획 사이 간격
          return pts;
        });
        return { strokes, width: l.bbox.maxX - l.bbox.minX, height: l.bbox.maxY - l.bbox.minY };
      });
      const res = await InkRecognizer.recognizeStrokes({ language: this.language, lines: input });
      res.lines.forEach((r, j) => {
        const [best, ...alt] = r.candidates;
        if (best) out.push(...wordsFromLine(best, chunk[j].bbox, alt.slice(0, 4)));
      });
    }
    return out;
  }
}

/** 이 기기에서 쓸 수 있는 인식기 (웹 브라우저면 null) */
export async function createRecognizer(): Promise<PageRecognizer | null> {
  // E2E 테스트용 가짜 인식기
  const injected = (window as unknown as { __inknoteTestRecognizer?: PageRecognizer }).__inknoteTestRecognizer;
  if (injected) return injected;
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('InkRecognizer')) return null;
  try {
    const info = await InkRecognizer.info();
    if (!info.available) return null;
    if (info.engine === 'vision') return new VisionRecognizer(['ko-KR', 'en-US'].filter((l) => !info.languages.length || info.languages.includes(l)));
    if (info.engine === 'mlkit') return new MlkitRecognizer('ko', !!info.ready);
  } catch (e) {
    console.warn('손글씨 인식기를 쓸 수 없음', e);
  }
  return null;
}
