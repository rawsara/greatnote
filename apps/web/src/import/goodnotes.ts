import type { GnImport, PdfAsset } from '@inknote/core';
import { inspectPdf } from '../engine/pdf';
import { textFont } from '../engine/render';
import { sha256Hex } from '../engine/sha256';
import type { Repo } from '../storage/repo';

export interface GoodnotesImportResult {
  docId: string;
  title: string;
  pages: number;
  stats: Record<string, number>;
  warnings: string[];
}

let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * 굿노트 텍스트 상자는 내용에 맞춰 크기가 정해진다. 이 기기 글꼴이 조금 더 넓으면
 * 원본에 없던 줄바꿈이 생기므로, 가장 긴 줄이 들어가도록 폭을 넓힌다 (최대 1.6배).
 */
function fitTextBox<T extends { w: number; h: number; text: string; fontSize: number; bold: boolean }>(o: T): T {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return o;
  measureCtx.font = textFont(o);
  const widest = Math.max(...o.text.split('\n').map((l) => measureCtx!.measureText(l).width));
  return widest > o.w && widest <= o.w * 1.6 ? { ...o, w: Math.ceil(widest + 2) } : o;
}

export const isGoodnotesFile = (f: File) => /\.goodnotes$/i.test(f.name);

function convertInWorker(bytes: ArrayBuffer, onProgress?: (msg: string) => void): Promise<GnImport> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./gnWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ ok: boolean; result?: GnImport; error?: string; progress?: string }>) => {
      if (e.data.progress) {
        console.debug('[goodnotes]', e.data.progress);
        onProgress?.(e.data.progress);
        return;
      }
      w.terminate();
      if (e.data.ok) resolve(e.data.result!);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || '변환 실패'));
    };
    w.postMessage(bytes, [bytes]);
  });
}

/**
 * .goodnotes → 새 노트.
 * 첨부(템플릿 PDF·이미지)는 SHA-256 id 로 저장해 동기화 시 한 번만 업로드되고,
 * 페이지 배경·이미지 객체의 참조도 그 id 로 바꾼다.
 */
export async function importGoodnotes(file: File, repo: Repo, onProgress?: (msg: string) => void): Promise<GoodnotesImportResult> {
  const t0 = performance.now();
  const lap = (what: string) => console.debug(`[goodnotes] ${what} ${Math.round(performance.now() - t0)}ms`);
  onProgress?.('굿노트 파일 변환 중…');
  const r = await convertInWorker(await file.arrayBuffer(), onProgress);
  lap('converted');
  onProgress?.('첨부 파일 저장 중…');
  const idMap = new Map<string, string>();
  const assets: PdfAsset[] = [];
  const warnings = [...r.warnings];
  for (const [uuid, { bytes, mime }] of r.attachments) {
    const buf = bytes.slice().buffer as ArrayBuffer;
    const id = await sha256Hex(buf);
    if (mime === 'application/pdf') {
      // 손상된 템플릿 하나 때문에 노트 전체를 못 가져오면 안 됨 → 무지로 대체
      const info = await inspectPdf(buf.slice(0)).catch(() => null);
      if (!info) {
        warnings.push('열 수 없는 속지 템플릿이 있어 해당 페이지는 무지로 가져왔습니다');
        continue;
      }
      assets.push({ id, name: `template-${uuid.slice(0, 8)}.pdf`, pageCount: info.pageCount, size: buf.byteLength, kind: 'pdf', mime });
    } else assets.push({ id, name: `image-${uuid.slice(0, 8)}`, pageCount: 0, size: buf.byteLength, kind: 'image', mime });
    idMap.set(uuid, id);
    await repo.putBlob(id, buf);
  }
  const pages = r.pages.map((p) => ({
    width: p.width,
    height: p.height,
    bg: p.bg.kind === 'pdf' && idMap.has(p.bg.assetId) ? { ...p.bg, assetId: idMap.get(p.bg.assetId)! } : p.bg.kind === 'pdf' ? { kind: 'blank' as const } : p.bg,
  }));
  const objects = r.pages.map((p) =>
    p.objects.map((o) => {
      if (o.type === 'image') return { ...o, assetId: idMap.get(o.assetId) ?? o.assetId };
      if (o.type === 'text' && !o.flow) return fitTextBox(o);
      return o;
    }),
  );
  lap('attachments stored');
  onProgress?.(`${r.pages.length}쪽 저장 중…`);
  const fromName = file.name.replace(/\.goodnotes$/i, '').trim();
  const title = fromName && !/^_+$/.test(fromName) ? fromName : r.title;
  const doc = await repo.create(title, pages, assets, objects);
  lap('document created');
  return { docId: doc.id, title, pages: pages.length, stats: r.stats, warnings };
}
