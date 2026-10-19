import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * 네이티브 앱(iOS/Android) 전용 연결 고리.
 *  - 파일 앱·메일·공유 시트에서 PDF / .goodnotes 를 "InkNote 로 열기"
 *  - PDF 내보내기 → 공유 시트 (파일 앱에 저장, 다른 앱으로 보내기)
 */
export const isNative = () => Capacitor.isNativePlatform();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 열린 파일 URL(file:// 또는 content://) → File. 이름이 없으면 내용으로 종류를 짐작 */
async function readOpenedFile(url: string): Promise<File | null> {
  let bytes: Uint8Array | null = null;
  try {
    const r = await Filesystem.readFile({ path: url });
    bytes = typeof r.data === 'string' ? b64ToBytes(r.data) : new Uint8Array(await r.data.arrayBuffer());
  } catch {
    try {
      bytes = new Uint8Array(await (await fetch(Capacitor.convertFileSrc(url))).arrayBuffer());
    } catch (e) {
      console.warn('열린 파일을 읽지 못함', url, e);
      return null;
    }
  }
  let name = decodeURIComponent(url.split(/[/?#]/).filter(Boolean).pop() ?? 'file');
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // PK (굿노트 파일은 ZIP)
  if (isPdf && !/\.pdf$/i.test(name)) name += '.pdf';
  else if (isZip && !/\.goodnotes$/i.test(name)) name = name.replace(/\.zip$/i, '') + '.goodnotes';
  if (!isPdf && !isZip) return null;
  return new File([bytes as BlobPart], name, { type: isPdf ? 'application/pdf' : '' });
}

/** 다른 앱에서 "InkNote 로 열기" 한 파일 받기 (앱이 꺼져 있다가 열린 경우 포함) */
export function onOpenFile(cb: (file: File) => void): () => void {
  if (!isNative()) return () => {};
  let removed = false;
  const handle = async (url?: string) => {
    if (!url || !/^(file|content):/i.test(url)) return;
    const f = await readOpenedFile(url);
    if (f && !removed) cb(f);
  };
  void App.getLaunchUrl().then((r) => handle(r?.url));
  const sub = App.addListener('appUrlOpen', (e) => void handle(e.url));
  return () => {
    removed = true;
    void sub.then((s) => s.remove());
  };
}

/** 네이티브: 임시 파일로 쓴 뒤 공유 시트 */
export async function shareFile(bytes: Uint8Array, name: string): Promise<void> {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const { uri } = await Filesystem.writeFile({ path: safe, data: bytesToB64(bytes), directory: Directory.Cache });
  try {
    await Share.share({ title: safe, files: [uri] });
  } catch (e) {
    if (!/cancel/i.test(String(e))) throw e;
  }
}
