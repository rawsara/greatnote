import { useEffect, useRef, useState } from 'react';
import type { PaperKind } from '@inknote/core';
import type { Editor } from '../engine/Editor';
import type { EditorUIState } from '../engine/types';
import { Icon } from './icons';

function Thumb({ editor, pageId, version, tick }: { editor: Editor; pageId: string; version: number; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    // 필기 중 썸네일 갱신이 입력을 방해하지 않도록 지연 렌더
    const t = window.setTimeout(() => ref.current && editor.renderThumbnail(ref.current, pageId), 250);
    return () => clearTimeout(t);
  }, [editor, pageId, version, tick]);
  return <canvas ref={ref} width={220} height={300} className="thumb-canvas" />;
}

export function PageSidebar({ editor, st }: { editor: Editor; st: EditorUIState }) {
  const [tick, setTick] = useState(0);
  useEffect(() => editor.pdf.onUpdate(() => setTick((t) => t + 1)), [editor]);
  const pages = editor.doc.pages;
  const cur = st.currentPageId;
  const curPage = cur ? editor.doc.page(cur) : undefined;

  return (
    <aside className="sidebar" aria-label="페이지">
      <div className="thumbs">
        {pages.map((p, i) => (
          <button
            key={p.id}
            className={`thumb ${p.id === cur ? 'active' : ''}`}
            onClick={() => editor.scrollToPage(p.id)}
            aria-label={`${i + 1} 페이지`}
          >
            <Thumb editor={editor} pageId={p.id} version={editor.pageVersion(p.id)} tick={tick} />
            <span className="thumb-num">{i + 1}</span>
          </button>
        ))}
      </div>
      {cur && (
        <div className="page-actions">
          <div className="row">
            <button className="icon-btn" title="위로" onClick={() => editor.doc.movePage(cur, -1)}><Icon.up /></button>
            <button className="icon-btn" title="아래로" onClick={() => editor.doc.movePage(cur, 1)}><Icon.down /></button>
            <button className="icon-btn" title="페이지 복제" onClick={() => editor.doc.duplicatePage(cur)}><Icon.copy /></button>
            <button
              className="icon-btn danger"
              title="페이지 삭제"
              disabled={pages.length <= 1}
              onClick={() => editor.doc.deletePage(cur)}
            >
              <Icon.trash />
            </button>
          </div>
          {curPage && curPage.bg.kind !== 'pdf' && (
            <select
              value={curPage.bg.kind}
              onChange={(e) => editor.doc.setPageBackground(cur, { kind: e.target.value as PaperKind })}
              aria-label="속지"
            >
              <option value="blank">무지</option>
              <option value="lined">줄노트</option>
              <option value="grid">모눈</option>
              <option value="dotted">점선</option>
            </select>
          )}
        </div>
      )}
    </aside>
  );
}
