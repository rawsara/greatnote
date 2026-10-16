import { Capacitor } from '@capacitor/core';
import type { PdfAsset } from '@inknote/core';
import { inspectPdf, type PdfInfo } from '../engine/pdf';
import { sha256Hex } from '../engine/sha256';
import type { Repo } from '../storage/repo';

/** PDF 파일 → (SHA-256 asset, 페이지 정보). 원본 바이트는 IndexedDB 에 보관 */
export async function importPdf(file: File, repo: Repo): Promise<{ asset: PdfAsset; info: PdfInfo }> {
  const bytes = await file.arrayBuffer();
  const id = await sha256Hex(bytes);
  await repo.putBlob(id, bytes);
  const info = await inspectPdf(bytes);
  return { asset: { id, name: file.name, pageCount: info.pageCount, size: bytes.byteLength }, info };
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** 웹: 다운로드 / 네이티브 앱: 공유 시트 (파일 앱 저장, 다른 앱으로 보내기) */
export async function saveFile(bytes: Uint8Array, name: string): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const file = new File([blob], name, { type: 'application/pdf' });
  if (Capacitor.isNativePlatform() && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
