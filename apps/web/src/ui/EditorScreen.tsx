import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { InkDocument } from '@inknote/core';
import { Editor } from '../engine/Editor';
import { exportPdf } from '../engine/exportPdf';
import { ImageManager } from '../engine/images';
import { PdfManager } from '../engine/pdf';
import { getServerUrl, type Repo } from '../storage/repo';
import { DocSession, type SyncStatus } from '../sync/DocSession';
import { importImage, importPdf, pickFile, pickPhoto, saveFile } from './files';
import { Icon } from './icons';
import { PageSidebar } from './PageSidebar';
import { SelectionMenu, ToolButtons, ToolOptions } from './Toolbar';
import { ThemeButton } from './ThemeButton';
import { usePdfDrop } from './usePdfDrop';
import { SearchPanel } from './SearchPanel';
import { HwrScheduler, createRecognizer, type RecognitionStatus } from '../recognize/scheduler';
import { StickerLibrary } from '../stickers/library';
import { StickerPanel } from './StickerPanel';

interface Loaded {
  editor: Editor;
  session: DocSession;
  hwr: HwrScheduler;
  stickers: StickerLibrary;
}

const STATUS_LABEL: Record<SyncStatus, string> = {
  local: '이 기기에만 저장',
  offline: '오프라인 (재연결 중)',
  connecting: '연결 중…',
  syncing: '동기화 중…',
  synced: '동기화됨',
};

export function EditorScreen({ repo, docId, query, onClose }: { repo: Repo; docId: string; query?: string; onClose: () => void }) {
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
      // 스티커 보관함 (노트와 별도 문서로 동기화)
      const stickers = await StickerLibrary.open(repo, (id) => images.retry(id));
      const images = new ImageManager(async (id) => {
        const bytes = await repo.getBlob(id);
        const asset = doc.assets().find((a) => a.id === id) ?? stickers.doc.assets().find((a) => a.id === id);
        return bytes ? { bytes, mime: asset?.mime ?? 'image/jpeg' } : null;
      });
      const editor = new Editor(hostRef.current, doc, pdf, images);
      const session = new DocSession(doc, repo, getServerUrl(), rec?.lastSeq ?? 0, rec?.outbox ?? [], (id) => {
        pdf.retry(id);
        images.retry(id);
      });
      const hwr = new HwrScheduler(doc, await createRecognizer());
      cleanup = () => {
        hwr.close();
        void stickers.close();
        editor.destroy();
        pdf.destroy();
        images.destroy();
        void session.close();
      };
      // 개발/테스트용 디버그 핸들
      (window as unknown as { __inknote?: unknown }).__inknote = { editor, session, doc, hwr, stickers };
      setLoaded({ editor, session, hwr, stickers });
    })().catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [repo, docId]);

  return (
    <div className="editor-screen">
      {loaded ? <EditorChrome {...loaded} repo={repo} query={query} onClose={onClose} /> : <div className="topbar" />}
      <div className="editor-body">
        {loaded && <SidebarSlot editor={loaded.editor} />}
        <div ref={hostRef} className="editor-host">
          {loaded && <SelectionOverlay editor={loaded.editor} stickers={loaded.stickers} />}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function portal(node: ReactNode) {
  const host = document.querySelector('.editor-host');
  return host ? createPortal(node, host) : node;
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

function SelectionOverlay({ editor, stickers }: { editor: Editor; stickers: StickerLibrary }) {
  const st = useEditorState(editor);
  const [saved, setSaved] = useState(false);
  const save = () => {
    const objs = editor.selectedObjects();
    const ids = new Set(objs.flatMap((o) => (o.type === 'image' ? [o.assetId] : [])));
    stickers.add(objs, editor.doc.assets().filter((a) => ids.has(a.id)));
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };
  return (
    <>
      <SelectionMenu editor={editor} st={st} onSaveSticker={save} />
      {saved && <div className="toast">내 스티커에 저장했어요</div>}
    </>
  );
}

function EditorChrome({ editor, session, hwr, stickers, repo, query, onClose }: Loaded & { repo: Repo; query?: string; onClose: () => void }) {
  const st = useEditorState(editor);
  const [status, setStatus] = useState<SyncStatus>(session.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(!!query);
  const [panel, setPanel] = useState<'stickers' | 'image' | null>(null);
  const [recog, setRecog] = useState<RecognitionStatus>(hwr.status);
  useEffect(() => session.onStatus(setStatus), [session]);
  useEffect(() => hwr.onStatus(setRecog), [hwr]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const doc = editor.doc;

  const addPage = () => {
    const cur = st.currentPageId ? doc.page(st.currentPageId) : doc.pages.at(-1);
    const bg = cur && cur.bg.kind !== 'pdf' ? cur.bg : { kind: 'blank' as const };
    const [p] = doc.insertPages(cur?.id ?? null, [{ width: cur?.width ?? 595.28, height: cur?.height ?? 841.89, bg }]);
    requestAnimationFrame(() => editor.scrollToPage(p.id));
  };

  /** 이미지 넣기: 파일·사진 보관함 / 카메라 */
  const insertImage = async (source: 'photos' | 'camera' | 'file') => {
    setPanel(null);
    const file = source === 'file' ? await pickFile('image/*') : await pickPhoto(source);
    if (!file) return;
    setBusy('이미지 넣는 중…');
    try {
      const { asset, width, height } = await importImage(file, repo);
      if (!doc.assets().some((a) => a.id === asset.id)) doc.addAsset(asset);
      editor.insertImage(asset.id, width, height);
    } catch (e) {
      alert(`이미지를 열 수 없습니다: ${e}`);
    } finally {
      setBusy(null);
    }
  };

  const insertPdf = async (dropped?: File) => {
    const file = dropped ?? (await pickFile('application/pdf'));
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

  const dragging = usePdfDrop((f) => void insertPdf(f));

  const doExport = async () => {
    setBusy('PDF 내보내는 중…');
    try {
      const bytes = await exportPdf(doc, { getBlob: (id) => repo.getBlob(id), mimeOf: (id) => doc.assets().find((a) => a.id === id)?.mime });
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
          <button className="icon-btn" title="다시 실행 (⇧⌘Z · 세 손가락 탭)" disabled={!st.canRedo} onClick={() => editor.redo()}><Icon.redo /></button>
          <span className="divider" />
          <button className={`icon-btn${searchOpen ? ' active' : ''}`} title="찾기 (⌘F) — 손글씨·텍스트·PDF" onClick={() => setSearchOpen((v) => !v)}><Icon.search /></button>
          <button className="icon-btn" title="페이지 추가" onClick={addPage}><Icon.plus /></button>
          <button className={`icon-btn${panel === 'stickers' ? ' active' : ''}`} title="스티커" onClick={() => setPanel(panel === 'stickers' ? null : 'stickers')}><Icon.sticker /></button>
          <span className="menu-anchor">
            <button className={`icon-btn${panel === 'image' ? ' active' : ''}`} title="사진·이미지 넣기" onClick={() => setPanel(panel === 'image' ? null : 'image')}><Icon.image /></button>
            {panel === 'image' && (
              <div className="pop-menu" role="menu">
                <button role="menuitem" onClick={() => insertImage('photos')}><Icon.image /> 사진 보관함</button>
                <button role="menuitem" onClick={() => insertImage('camera')}><Icon.camera /> 카메라로 찍기</button>
                <button role="menuitem" onClick={() => insertImage('file')}><Icon.file /> 파일에서</button>
              </div>
            )}
          </span>
          <button className="icon-btn" title="PDF 삽입 (파일을 끌어다 놓아도 됩니다)" onClick={() => insertPdf()}><Icon.file /></button>
          <button className="icon-btn" title="PDF로 내보내기" onClick={doExport}><Icon.share /></button>
          <ThemeButton />
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
      {/* 패널은 편집 영역 안에 띄운다 (툴바가 두 줄로 바뀌어도 위치가 맞도록) */}
      {panel === 'stickers' && portal(<StickerPanel editor={editor} library={stickers} repo={repo} onClose={() => setPanel(null)} />)}
      {searchOpen && portal(<SearchPanel editor={editor} docVersion={st.docVersion} initial={query} recognition={recog} onClose={() => setSearchOpen(false)} />)}
      {busy && <div className="toast">{busy}</div>}
      {dragging && <div className="drop-zone">PDF를 놓으면 현재 페이지 뒤에 삽입해요</div>}
    </>
  );
}
