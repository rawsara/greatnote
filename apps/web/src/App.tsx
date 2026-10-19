import { useEffect, useState } from 'react';
import type { Repo } from './storage/repo';
import { EditorScreen } from './ui/EditorScreen';
import { Library } from './ui/Library';
import { onOpenFile } from './native';

export function App({ repo }: { repo: Repo }) {
  const parse = () => new URLSearchParams(location.hash.slice(1));
  const [docId, setDocId] = useState<string | null>(() => parse().get('doc'));
  const [query, setQuery] = useState<string | undefined>(() => parse().get('q') ?? undefined);

  useEffect(() => {
    const onHash = () => {
      setDocId(parse().get('doc'));
      setQuery(parse().get('q') ?? undefined);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 앱: 다른 앱에서 "InkNote 로 열기" 한 PDF·굿노트 파일 → 라이브러리에서 새 노트로 가져오기
  const [incoming, setIncoming] = useState<File | null>(null);
  useEffect(() => onOpenFile((f) => {
    location.hash = '';
    setDocId(null);
    setIncoming(f);
  }), []);

  /** q: 라이브러리 검색에서 열 때 노트 안 검색어 */
  const open = (id: string | null, q?: string) => {
    location.hash = id ? `doc=${id}${q ? `&q=${encodeURIComponent(q)}` : ''}` : '';
    setDocId(id);
    setQuery(q);
  };

  return docId ? (
    <EditorScreen key={docId} repo={repo} docId={docId} query={query} onClose={() => open(null)} />
  ) : (
    <Library repo={repo} onOpen={open} incoming={incoming} onIncomingHandled={() => setIncoming(null)} />
  );
}
