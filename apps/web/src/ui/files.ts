import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import type { PdfAsset } from '@inknote/core';
import { inspectPdf, type PdfInfo } from '../engine/pdf';
import { sha256Hex } from '../engine/sha256';
import { shareFile } from '../native';
import type { Repo } from '../storage/repo';

/** PDF 파일 → (SHA-256 asset, 페이지 정보). 원본 바이트는 IndexedDB 에 보관 */
export async function importPdf(file: File, repo: Repo): Promise<{ asset: PdfAsset; info: PdfInfo }> {
  const bytes = await file.arrayBuffer();
  const id = await sha256Hex(bytes);
  await repo.putBlob(id, bytes);
  const info = await inspectPdf(bytes);
  return { asset: { id, name: file.name, pageCount: info.pageCount, size: bytes.byteLength }, info };
}

/** 이미지 파일 → 에셋 (원본 그대로 보관) + 원래 크기 */
export async function importImage(file: File, repo: Repo): Promise<{ asset: PdfAsset; width: number; height: number }> {
  const bytes = await file.arrayBuffer();
  const bmp = await createImageBitmap(new Blob([bytes], { type: file.type }));
  const { width, height } = bmp;
  bmp.close();
  const id = await sha256Hex(bytes);
  await repo.putBlob(id, bytes);
  return { asset: { id, name: file.name, pageCount: 0, size: bytes.byteLength, kind: 'image', mime: file.type || 'image/jpeg' }, width, height };
}

/** capture: 모바일 브라우저에서 바로 카메라 열기 ('environment' = 후면) */
export function pickFile(accept: string, capture?: 'environment' | 'user'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** 웹: 다운로드 / 네이티브 앱: 공유 시트 (파일 앱 저장, 다른 앱으로 보내기) */
export async function saveFile(bytes: Uint8Array, name: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return shareFile(bytes, name);
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * 사진 가져오기. 앱: 사진 보관함/카메라 (기기 권한 요청), 웹: 파일 선택 또는 모바일 브라우저 카메라.
 * 취소하면 null.
 */
export async function pickPhoto(source: 'camera' | 'photos'): Promise<File | null> {
  if (!Capacitor.isNativePlatform()) return pickFile('image/*', source === 'camera' ? 'environment' : undefined);
  try {
    const photo = await Camera.getPhoto({
      source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.Uri,
      quality: 88,
      width: 2400, // 너무 큰 원본은 줄여서 저장 (필기 앱 용도로 충분)
      correctOrientation: true,
    });
    if (!photo.webPath) return null;
    const blob = await (await fetch(photo.webPath)).blob();
    const type = blob.type || `image/${photo.format === 'jpg' ? 'jpeg' : photo.format}`;
    return new File([blob], `photo-${Date.now()}.${photo.format}`, { type });
  } catch (e) {
    if (/cancel/i.test(String(e))) return null;
    throw e;
  }
}
