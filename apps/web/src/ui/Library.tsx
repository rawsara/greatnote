import { useCallback, useEffect, useMemo, useState } from 'react';
import { A4, normalizeQuery, searchPlainText, type PaperKind, type RemoteDocInfo } from '@inknote/core';
import { getServerUrl, httpBase, setServerUrl, type DocMetaRecord, type Repo } from '../storage/repo';
import { importPdf, pickFile } from './files';
import { ThemeButton } from './ThemeButton';
import { isPdf, usePdfDrop } from './usePdfDrop';
import { importGoodnotes, isGoodnotesFile, type GoodnotesImportResult } from '../import/goodnotes';
import { Icon } from './icons';

interface Item {
  id: string;
  title: string;
  updatedAt: number;
  pageCount?: number;
  local: boolean;
  remote: boolean;
  /** 페이지별 검색 색인 */
  text?: string[];
}

const PAPERS: Array<[PaperKind, string]> = [['blank', '무지'], ['lined', '줄노트'], ['grid', '모눈'], ['dotted', '점선']];

export function Library({ repo, onOpen, incoming, onIncomingHandled }: {
  repo: Repo;
  onOpen: (id: string, query?: string) => void;
  /** 다른 앱에서 열기로 받은 파일 */
  incoming?: File | null;
  onIncomingHandled?: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [remoteState, setRemoteState] = useState<'off' | 'ok' | 'error'>('off');
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [server, setServer] = useState(getServerUrl());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<GoodnotesImportResult | null>(null);
  const [query, setQuery] = useState('');

  // 노트 전체 검색: 제목 + 손글씨 인식 결과 + 텍스트 상자 (로컬에 있는 노트)
  const shown = useMemo(() => {
    const q = normalizeQuery(query);
    if (!q) return items.map((it) => ({ it, pages: [] as number[] }));
    return items
      .map((it) => ({ it, pages: searchPlainText(it.text ?? [], query), title: normalizeQuery(it.title).includes(q) }))
      .filter((r) => r.title || r.pages.length);
  }, [items, query]);

  const refresh = useCallback(async () => {
    const local: DocMetaRecord[] = await repo.list();
    const map = new Map<string, Item>(local.map((d) => [d.id, { ...d, local: true, remote: false }]));
    const url = getServerUrl();
    if (url) {
      try {
        const res = await fetch(`${httpBase(url)}/api/docs`);
        const remote = (await res.json()) as RemoteDocInfo[];
        for (const r of remote.filter((d) => d.id !== 'stickers')) {
          const cur = map.get(r.id);
          if (cur) cur.remote = true;
          else map.set(r.id, { id: r.id, title: r.title, updatedAt: r.updatedAt, local: false, remote: true });
        }
        setRemoteState('ok');
      } catch {
        setRemoteState('error');
      }
    } else setRemoteState('off');
    setItems([...map.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  }, [repo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (paper: PaperKind) => {
    setNewOpen(false);
    const doc = await repo.create('새 노트', [{ ...A4, bg: { kind: paper } }]);
    onOpen(doc.id);
  };

  const fromPdf = async (dropped?: File) => {
    const file = dropped ?? (await pickFile('application/pdf'));
    if (!file) return;
    setBusy(true);
    try {
      const { asset, info } = await importPdf(file, repo);
      const doc = await repo.create(
        file.name.replace(/\.pdf$/i, ''),
        info.pages.map((p, i) => ({ width: p.width, height: p.height, bg: { kind: 'pdf' as const, assetId: asset.id, pageIndex: i } })),
        [asset],
      );
      onOpen(doc.id);
    } catch (e) {
      alert(`PDF를 열 수 없습니다: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const fromGoodnotes = async (dropped?: File) => {
    const file = dropped ?? (await pickFile('.goodnotes,application/zip,application/octet-stream'));
    if (!file) return;
    setBusy(true);
    try {
      setReport(await importGoodnotes(file, repo));
      void refresh();
    } catch (e) {
      alert(`굿노트 파일을 가져올 수 없습니다: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  const dragging = usePdfDrop(
    (f) => void (isGoodnotesFile(f) ? fromGoodnotes(f) : fromPdf(f)),
    (f) => isPdf(f) || isGoodnotesFile(f),
  );

  useEffect(() => {
    if (!incoming) return;
    onIncomingHandled?.();
    if (isGoodnotesFile(incoming)) void fromGoodnotes(incoming);
    else if (isPdf(incoming)) void fromPdf(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  const remove = async (it: Item) => {
    if (!confirm(`"${it.title}"을(를) 이 기기에서 삭제할까요?`)) return;
    await repo.remove(it.id);
    void refresh();
  };

  return (
    <div className="library">
      {dragging && <div className="drop-zone">PDF나 굿노트(.goodnotes) 파일을 놓으면 새 노트로 열어요</div>}
      {report && (
        <div className="panel import-report" role="status">
          <div>
            <strong>“{report.title}” 가져오기 완료</strong> · {report.pages}쪽
            <div className="card-sub">
              {Object.entries(report.stats).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')}
            </div>
            {report.warnings.map((w) => <div key={w} className="warn">⚠ {w}</div>)}
          </div>
          <div className="lib-actions">
            <button className="primary-btn" onClick={() => onOpen(report.docId)}>열기</button>
            <button className="secondary-btn" onClick={() => setReport(null)}>닫기</button>
          </div>
        </div>
      )}
      <header className="lib-header">
        <h1>InkNote</h1>
        <div className="lib-actions">
          <span className={`sync-badge ${remoteState === 'ok' ? 'synced' : remoteState === 'error' ? 'offline' : 'local'}`}>
            <Icon.cloud /> {remoteState === 'ok' ? '서버 연결됨' : remoteState === 'error' ? '서버 연결 실패' : '로컬 전용'}
          </span>
          <label className="lib-search">
            <Icon.search />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="모든 노트에서 찾기 (손글씨 포함)" aria-label="모든 노트에서 찾기" />
          </label>
          <ThemeButton />
          <button className="icon-btn" title="동기화 설정" onClick={() => setSettingsOpen((v) => !v)}><Icon.settings /></button>
          <button className="primary-btn" onClick={() => setNewOpen((v) => !v)}><Icon.plus /> 새 노트</button>
          <button className="secondary-btn" onClick={() => fromPdf()} disabled={busy}><Icon.file /> {busy ? '가져오는 중…' : 'PDF 가져오기'}</button>
          <button className="secondary-btn" onClick={() => fromGoodnotes()} disabled={busy}><Icon.import /> 굿노트 가져오기</button>
        </div>
      </header>

      {settingsOpen && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            setServerUrl(server);
            setSettingsOpen(false);
            void refresh();
          }}
        >
          <label>
            동기화 서버 주소 (비우면 이 기기에만 저장)
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="ws://192.168.0.10:8787" />
          </label>
          <button className="primary-btn" type="submit">저장</button>
        </form>
      )}

      {newOpen && (
        <div className="panel papers">
          {PAPERS.map(([k, label]) => (
            <button key={k} className="paper-choice" onClick={() => create(k)}>
              <span className={`paper-preview ${k}`} />
              {label}
            </button>
          ))}
        </div>
      )}

      <main className="grid">
        {items.length === 0 && <p className="empty">노트가 없습니다. “새 노트”, “PDF 가져오기”, “굿노트 가져오기” 또는 파일을 이 화면에 끌어다 놓으세요.</p>}
        {items.length > 0 && query.trim() && !shown.length && <p className="empty">“{query}”가 들어 있는 노트가 없어요</p>}
        {shown.map(({ it, pages }) => (
          <div key={it.id} className="card">
            <button className="card-cover" onClick={() => onOpen(it.id, pages.length ? query : undefined)} aria-label={`${it.title} 열기`}>
              <span className="cover-title">{it.title}</span>
            </button>
            <div className="card-meta">
              <div>
                <div className="card-title">{it.title}</div>
                <div className="card-sub">
                  {new Date(it.updatedAt).toLocaleDateString('ko-KR')}
                  {it.pageCount ? ` · ${it.pageCount}쪽` : ''}
                  {it.remote && !it.local ? ' · 클라우드' : it.remote ? ' · 동기화' : ''}
                </div>
                {pages.length > 0 && (
                  <div className="card-hit">
                    {pages.slice(0, 6).map((p) => `${p + 1}쪽`).join(', ')}{pages.length > 6 ? ` 외 ${pages.length - 6}쪽` : ''}에서 찾음
                  </div>
                )}
              </div>
              {it.local && (
                <button className="icon-btn small" title="이 기기에서 삭제" onClick={() => remove(it)}><Icon.trash /></button>
              )}
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
