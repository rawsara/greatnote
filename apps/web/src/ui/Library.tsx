import { useCallback, useEffect, useState } from 'react';
import { A4, type PaperKind, type RemoteDocInfo } from '@inknote/core';
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
}

const PAPERS: Array<[PaperKind, string]> = [['blank', '무지'], ['lined', '줄노트'], ['grid', '모눈'], ['dotted', '점선']];

export function Library({ repo, onOpen }: { repo: Repo; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [remoteState, setRemoteState] = useState<'off' | 'ok' | 'error'>('off');
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [server, setServer] = useState(getServerUrl());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<GoodnotesImportResult | null>(null);

  const refresh = useCallback(async () => {
    const local: DocMetaRecord[] = await repo.list();
    const map = new Map<string, Item>(local.map((d) => [d.id, { ...d, local: true, remote: false }]));
    const url = getServerUrl();
    if (url) {
      try {
        const res = await fetch(`${httpBase(url)}/api/docs`);
        const remote = (await res.json()) as RemoteDocInfo[];
        for (const r of remote) {
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
        {items.map((it) => (
          <div key={it.id} className="card">
            <button className="card-cover" onClick={() => onOpen(it.id)} aria-label={`${it.title} 열기`}>
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
