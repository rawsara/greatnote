import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { InkDocument } from '@inknote/core';
import { Editor } from '../engine/Editor';
import { exportPdf } from '../engine/exportPdf';
import { PdfManager } from '../engine/pdf';
import { getServerUrl, type Repo } from '../storage/repo';
import { DocSession, type SyncStatus } from '../sync/DocSession';
import { importPdf, pickFile, saveFile } from './files';
import { Icon } from './icons';
import { PageSidebar } from './PageSidebar';
import { SelectionMenu, ToolButtons, ToolOptions } from './Toolbar';

interface Loaded {
  editor: Editor;
  session: DocSession;
}

const STATUS_LABEL: Record<SyncStatus, string> = {
  local: '이 기기에만 저장',
  offline: '오프라인 (재연결 중)',
  connecting: '연결 중…',
  syncing: '동기화 중…',
  synced: '동기화됨',
};

export function EditorScreen({ repo, docId, onClose }: { repo: Repo; docId: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    (async () => {
      const rec = await repo.load(docId);
      // 다른 기기에서 만든 문서(로컬에 없음)는 빈 문서로 열고 서버에서 전부 받아온다
      const doc = rec ? InkDocument.fromSnapshot(rec.snapshot, repo.clientId) : new InkDocument(docId, repo.clientId);
      if (disposed || !hostRef.current) return;
      const pdf = new PdfManager((id) => repo.getBlob(id));
      const editor = new Editor(hostRef.current, doc, pdf);
      const session = new DocSession(doc, repo, getServerUrl(), rec?.lastSeq ?? 0, rec?.outbox ?? [], (id) => pdf.retry(id));
      cleanup = () => {
        editor.destroy();
        pdf.destroy();
        void session.close();
      };
      // 개발/테스트용 디버그 핸들
      (window as unknown as { __inknote?: unknown }).__inknote = { editor, session, doc };
      setLoaded({ editor, session });
    })().catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [repo, docId]);

  return (
    <div className="editor-screen">
      {loaded ? <EditorChrome {...loaded} repo={repo} onClose={onClose} /> : <div className="topbar" />}
      <div className="editor-body">
        {loaded && <SidebarSlot editor={loaded.editor} />}
        <div ref={hostRef} className="editor-host">
          {loaded && <SelectionOverlay editor={loaded.editor} />}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function useEditorState(editor: Editor) {
  return useSyncExternalStore(editor.subscribe, editor.getState);
}

let sidebarOpen = window.innerWidth > 900;
const sidebarListeners = new Set<() => void>();
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  sidebarListeners.forEach((l) => l());
}
function useSidebar() {
  return useSyncExternalStore(
    (l) => {
      sidebarListeners.add(l);
      return () => sidebarListeners.delete(l);
    },
    () => sidebarOpen,
  );
}

function SidebarSlot({ editor }: { editor: Editor }) {
  const st = useEditorState(editor);
  const open = useSidebar();
  return open ? <PageSidebar editor={editor} st={st} /> : null;
}

function SelectionOverlay({ editor }: { editor: Editor }) {
  const st = useEditorState(editor);
  return <SelectionMenu editor={editor} st={st} />;
}

function EditorChrome({ editor, session, repo, onClose }: Loaded & { repo: Repo; onClose: () => void }) {
  const st = useEditorState(editor);
  const [status, setStatus] = useState<SyncStatus>(session.status);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => session.onStatus(setStatus), [session]);
  const doc = editor.doc;

  const addPage = () => {
    const cur = st.currentPageId ? doc.page(st.currentPageId) : doc.pages.at(-1);
    const bg = cur && cur.bg.kind !== 'pdf' ? cur.bg : { kind: 'blank' as const };
    const [p] = doc.insertPages(cur?.id ?? null, [{ width: cur?.width ?? 595.28, height: cur?.height ?? 841.89, bg }]);
    requestAnimationFrame(() => editor.scrollToPage(p.id));
  };

  const insertPdf = async () => {
    const file = await pickFile('application/pdf');
    if (!file) return;
    setBusy('PDF 가져오는 중…');
    try {
      const { asset, info } = await importPdf(file, repo);
      doc.addAsset(asset);
      const pages = doc.insertPages(
        st.currentPageId,
        info.pages.map((p, i) => ({ width: p.width, height: p.height, bg: { kind: 'pdf' as const, assetId: asset.id, pageIndex: i } })),
        'PDF 삽입',
      );
      requestAnimationFrame(() => pages[0] && editor.scrollToPage(pages[0].id));
    } finally {
      setBusy(null);
    }
  };

  const doExport = async () => {
    setBusy('PDF 내보내는 중…');
    try {
      const bytes = await exportPdf(doc, (id) => repo.getBlob(id));
      await saveFile(bytes, `${doc.meta.title || 'InkNote'}.pdf`);
    } catch (e) {
      alert(`내보내기 실패: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const rename = () => {
    const t = prompt('노트 제목', doc.meta.title);
    if (t?.trim()) doc.setTitle(t.trim());
  };

  return (
    <>
      <header className="topbar">
        <div className="tb-left">
          <button className="icon-btn" title="라이브러리" onClick={onClose}><Icon.back /></button>
          <button className="icon-btn" title="페이지 목록" onClick={toggleSidebar}><Icon.pages /></button>
          <button className="title-btn" onClick={rename} title="제목 변경">{doc.meta.title}</button>
          <span className={`sync-badge ${status}`} title={STATUS_LABEL[status]}>
            <Icon.cloud /> <span className="sync-text">{STATUS_LABEL[status]}</span>
          </span>
        </div>
        <ToolButtons editor={editor} st={st} />
        <div className="tb-right">
          <button className="icon-btn" title="실행 취소 (⌘Z · 두 손가락 탭)" disabled={!st.canUndo} onClick={() => editor.undo()}><Icon.undo /></button>
          <button className="icon-btn" title="다시 실행 (⇧⌘Z)" disabled={!st.canRedo} onClick={() => editor.redo()}><Icon.redo /></button>
          <span className="divider" />
          <button className="icon-btn" title="페이지 추가" onClick={addPage}><Icon.plus /></button>
          <button className="icon-btn" title="PDF 삽입" onClick={insertPdf}><Icon.file /></button>
          <button className="icon-btn" title="PDF로 내보내기" onClick={doExport}><Icon.share /></button>
        </div>
      </header>
      <div className="subbar">
        <ToolOptions editor={editor} st={st} />
        <div className="zoom">
          <label className="pen-only" title="Apple Pencil/S펜이 감지되면 자동으로 켜집니다">
            <input type="checkbox" checked={st.penOnly} onChange={(e) => editor.update({ penOnly: e.target.checked })} />
            펜으로만 쓰기
          </label>
          <button className="icon-btn" onClick={() => editor.zoomBy(1 / 1.25)} title="축소"><Icon.zoomOut /></button>
          <button className="zoom-val" onClick={() => editor.fitWidth()} title="폭 맞춤">{Math.round(st.zoom * 100)}%</button>
          <button className="icon-btn" onClick={() => editor.zoomBy(1.25)} title="확대"><Icon.zoomIn /></button>
        </div>
      </div>
      {busy && <div className="toast">{busy}</div>}
    </>
  );
}
