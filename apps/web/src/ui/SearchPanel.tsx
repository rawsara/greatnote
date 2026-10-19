import { useEffect, useRef, useState } from 'react';
import { searchDocument, type SearchHit } from '@inknote/core';
import type { Editor } from '../engine/Editor';
import type { RecognitionStatus } from '../recognize/scheduler';
import { Icon } from './icons';

const KIND_LABEL: Record<SearchHit['kind'], string> = { ink: '손글씨', text: '텍스트', pdf: 'PDF' };

/** 노트 안 검색: 손글씨 인식 결과 · 텍스트 상자 · PDF 글자 */
export function SearchPanel({ editor, docVersion, initial, recognition, onClose }: {
  editor: Editor;
  docVersion: number;
  initial?: string;
  recognition: RecognitionStatus;
  onClose: () => void;
}) {
  const [q, setQ] = useState(initial ?? '');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const lastQ = useRef('');

  useEffect(() => input.current?.focus(), []);
  useEffect(() => () => editor.setSearch(null), [editor]);

  useEffect(() => {
    let stale = false;
    const t = window.setTimeout(async () => {
      const doc = editor.doc;
      if (!q.trim()) {
        setHits([]);
        editor.setSearch(null);
        return;
      }
      // PDF 페이지 글자는 처음 검색할 때 한 번 읽어 둔다
      const missing = doc.pages.flatMap((p) => (p.bg.kind === 'pdf' && !editor.pdf.textItems(p.bg.assetId, p.bg.pageIndex) ? [p.bg] : []));
      if (missing.length) {
        setReading(true);
        await Promise.all(missing.map((bg) => editor.pdf.loadTextItems(bg.assetId, bg.pageIndex)));
        setReading(false);
      }
      if (stale) return;
      const found = searchDocument(
        { pages: doc.pages, objects: (id) => doc.objects(id), hwr: (id) => doc.hwr(id) },
        q,
        { pdfItems: (p) => (p.bg.kind === 'pdf' ? editor.pdf.textItems(p.bg.assetId, p.bg.pageIndex) : null) },
      );
      const newQuery = lastQ.current !== q;
      lastQ.current = q;
      const idx = newQuery ? firstAfterCurrentPage(editor, found) : Math.min(active, Math.max(0, found.length - 1));
      setHits(found);
      setActive(idx);
      // 문서가 바뀌어 다시 찾은 경우에는 화면을 옮기지 않는다
      editor.setSearch(found, idx, newQuery);
    }, 180);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, docVersion, editor]);

  const go = (i: number) => {
    if (!hits.length) return;
    const n = (i + hits.length) % hits.length;
    setActive(n);
    editor.setSearch(hits, n);
  };

  return (
    <div className="search-panel" role="search">
      <div className="search-row">
        <Icon.search />
        <input
          ref={input}
          value={q}
          placeholder="손글씨·텍스트·PDF에서 찾기"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') go(active + (e.shiftKey ? -1 : 1));
            if (e.key === 'Escape') onClose();
          }}
          aria-label="노트에서 찾기"
        />
        <span className="search-count">{q.trim() ? (hits.length ? `${active + 1}/${hits.length}` : reading ? '…' : '0') : ''}</span>
        <button className="icon-btn small" title="이전 (⇧Enter)" disabled={!hits.length} onClick={() => go(active - 1)}><Icon.up /></button>
        <button className="icon-btn small" title="다음 (Enter)" disabled={!hits.length} onClick={() => go(active + 1)}><Icon.down /></button>
        <button className="icon-btn small" title="닫기 (Esc)" onClick={onClose}><Icon.close /></button>
      </div>
      {q.trim() && (
        <ul className="search-results">
          {hits.slice(0, 200).map((h, i) => (
            <li key={i}>
              <button className={i === active ? 'active' : ''} onClick={() => go(i)}>
                <span className="search-page">{h.pageIndex + 1}쪽</span>
                <span className={`search-kind ${h.kind}`}>{KIND_LABEL[h.kind]}</span>
                <span className="search-snippet">{h.snippet}</span>
              </button>
            </li>
          ))}
          {!hits.length && !reading && <li className="search-empty">찾는 내용이 없어요</li>}
        </ul>
      )}
      <div className="search-foot">{recognitionText(recognition)}</div>
    </div>
  );
}

function recognitionText(r: RecognitionStatus): string {
  if (r.engine === 'none') {
    return r.indexed
      ? `손글씨 ${r.indexed}쪽 검색 가능 (다른 기기·굿노트에서 인식된 결과). 이 기기에서는 새 손글씨를 인식할 수 없어요 — iPad/Android 앱에서 인식됩니다`
      : '손글씨 인식은 iPad/Android 앱에서 동작해요. 텍스트 상자와 PDF 글자는 여기서도 찾을 수 있어요';
  }
  if (r.pending) return `손글씨 인식 중… (${r.indexed}/${r.indexed + r.pending}쪽)`;
  return `손글씨 ${r.indexed}쪽 인식됨 · 기기 내장 인식(${r.engine === 'vision' ? 'Apple' : 'Google ML Kit'})`;
}

/** 지금 보고 있는 페이지부터 첫 결과 */
function firstAfterCurrentPage(editor: Editor, hits: SearchHit[]): number {
  const cur = editor.doc.pages.findIndex((p) => p.id === editor.state.currentPageId);
  const i = hits.findIndex((h) => h.pageIndex >= cur);
  return i < 0 ? 0 : i;
}
