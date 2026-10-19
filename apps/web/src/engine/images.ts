import { setImageSource } from './render';

/**
 * 이미지 에셋 로더: blob(IndexedDB) → ImageBitmap 캐시.
 * 디코딩은 비동기라 처음엔 자리 표시만 그리고, 준비되면 onUpdate 로 다시 그리게 한다.
 */
export class ImageManager {
  private cache = new Map<string, ImageBitmap | HTMLImageElement | null>();
  private loading = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private readonly load: (assetId: string) => Promise<{ bytes: ArrayBuffer; mime: string } | null>) {
    setImageSource((id) => this.get(id));
  }

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(id: string): ImageBitmap | HTMLImageElement | null {
    const v = this.cache.get(id);
    if (v !== undefined) return v;
    if (!this.loading.has(id)) {
      this.loading.add(id);
      void this.decode(id).finally(() => this.loading.delete(id));
    }
    return null;
  }

  /** 동기화로 원본이 나중에 도착했을 때 */
  retry(id: string): void {
    if (this.cache.get(id) === null) this.cache.delete(id);
    this.listeners.forEach((l) => l());
  }

  private async decode(id: string): Promise<void> {
    const src = await this.load(id);
    if (!src) return; // 원본 없음 → 다음 요청 때 재시도
    const blob = new Blob([src.bytes], { type: src.mime });
    try {
      this.cache.set(id, await createImageBitmap(blob));
    } catch {
      // createImageBitmap 이 못 여는 형식은 <img> 로 한 번 더 시도 (Safari 의 HEIC 등)
      const img = new Image();
      const url = URL.createObjectURL(blob);
      try {
        img.src = url;
        await img.decode();
        this.cache.set(id, img);
      } catch {
        this.cache.set(id, null);
      }
    }
    this.listeners.forEach((l) => l());
  }

  destroy(): void {
    for (const v of this.cache.values()) if (v && 'close' in v) v.close();
    this.cache.clear();
    setImageSource(() => null);
  }
}
