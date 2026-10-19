import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { InkObject } from '@inknote/core';
import type { Editor } from '../engine/Editor';
import { drawObjects } from '../engine/render';
import type { StickerLibrary } from '../stickers/library';
import { BUILTIN_STICKERS, type Sticker } from '../stickers/pack';
import type { Repo } from '../storage/repo';
import { importImage, pickPhoto } from './files';
import { Icon } from './icons';

/** 스티커 고르기: 기본 팩 / 내 스티커 (선택 항목·사진으로 만들기) */
export function StickerPanel({ editor, library, repo, onClose }: { editor: Editor; library: StickerLibrary; repo: Repo; onClose: () => void }) {
  const [tab, setTab] = useState<'builtin' | 'mine'>('builtin');
  const [busy, setBusy] = useState(false);
  const mine = useSyncExternalStore(
    (l) => library.onChange(l),
    () => library.doc.store.maxClock(), // 보관함이 바뀔 때만 다시 계산
  );
  const myStickers = useMemoByKey(mine, () => library.list());
  const selection = useSyncExternalStore(editor.subscribe, () => editor.state.selection);
  // 이미지 스티커 미리보기: 원본이 디코딩되면 다시 그림
  const [imgTick, setImgTick] = useState(0);
  useEffect(() => editor.images?.onUpdate(() => setImgTick((t) => t + 1)), [editor]);

  const place = (s: Sticker) => {
    const doc = editor.doc;
    // 이미지 스티커: 원본 정보를 이 노트에도 등록 (blob 은 기기 저장소에 이미 있음)
    for (const a of library.assetsOf(s)) if (!doc.assets().some((x) => x.id === a.id)) doc.addAsset(a);
    editor.insertSticker(s.objects, s.w, s.h);
  };

  const fromSelection = () => {
    const objs = editor.selectedObjects();
    const ids = new Set(objs.flatMap((o) => (o.type === 'image' ? [o.assetId] : [])));
    library.add(objs, editor.doc.assets().filter((a) => ids.has(a.id)));
    setTab('mine');
  };

  const fromPhoto = async (source: 'camera' | 'photos') => {
    const file = await pickPhoto(source);
    if (!file) return;
    setBusy(true);
    try {
      const { asset, width, height } = await importImage(file, repo);
      library.addImage(asset, width, height);
      setTab('mine');
    } catch (e) {
      alert(`사진을 열 수 없습니다: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const list = tab === 'builtin' ? BUILTIN_STICKERS : myStickers;

  return (
    <div className="sticker-panel" role="dialog" aria-label="스티커">
      <div className="sticker-head">
        <div className="seg">
          <button className={tab === 'builtin' ? 'active' : ''} onClick={() => setTab('builtin')}>기본 스티커</button>
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>내 스티커 {myStickers.length ? myStickers.length : ''}</button>
        </div>
        <button className="icon-btn small" title="닫기" onClick={onClose}><Icon.close /></button>
      </div>
      {tab === 'mine' && (
        <div className="sticker-make">
          <button className="text-btn" disabled={!selection?.ids.length} onClick={fromSelection} title="올가미로 고른 필기·도형·이미지를 스티커로 저장">
            <Icon.lasso /> 선택한 것으로 만들기
          </button>
          <button className="text-btn" disabled={busy} onClick={() => fromPhoto('photos')}><Icon.image /> 사진으로</button>
          <button className="text-btn" disabled={busy} onClick={() => fromPhoto('camera')}><Icon.camera /> 촬영</button>
        </div>
      )}
      <div className="sticker-grid">
        {list.map((s) => (
          <div key={s.id} className="sticker-cell">
            <button className="sticker-btn" title={s.name || '스티커 붙이기'} onClick={() => place(s)} aria-label={`${s.name || '내 스티커'} 붙이기`}>
              <StickerPreview sticker={s} tick={imgTick} />
            </button>
            {tab === 'mine' && (
              <button className="sticker-del" title="보관함에서 삭제" aria-label="스티커 삭제" onClick={() => confirm('이 스티커를 삭제할까요?') && library.remove(s.id)}>×</button>
            )}
          </div>
        ))}
        {tab === 'mine' && !myStickers.length && (
          <p className="sticker-empty">올가미로 필기나 그림을 고른 뒤 “선택한 것으로 만들기”를 누르거나, 사진으로 스티커를 만들어 보세요. 만든 스티커는 다른 기기와 동기화돼요.</p>
        )}
      </div>
    </div>
  );
}

function useMemoByKey<T>(key: unknown, fn: () => T): T {
  const ref = useRef<{ key: unknown; v: T } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, v: fn() };
  return ref.current.v;
}

function StickerPreview({ sticker, tick }: { sticker: Sticker; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const size = 64, dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    const k = (size - 8) / Math.max(sticker.w, sticker.h);
    ctx.setTransform(k * dpr, 0, 0, k * dpr, ((size - sticker.w * k) / 2) * dpr, ((size - sticker.h * k) / 2) * dpr);
    drawObjects(ctx, sticker.objects as InkObject[]);
  }, [sticker, tick]);
  return <canvas ref={ref} className="sticker-canvas" />;
}
