import { useEffect, useState } from 'react';
import type { Repo } from './storage/repo';
import { EditorScreen } from './ui/EditorScreen';
import { Library } from './ui/Library';

export function App({ repo }: { repo: Repo }) {
  const [docId, setDocId] = useState<string | null>(() => new URLSearchParams(location.hash.slice(1)).get('doc'));

  useEffect(() => {
    const onHash = () => setDocId(new URLSearchParams(location.hash.slice(1)).get('doc'));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const open = (id: string | null) => {
    location.hash = id ? `doc=${id}` : '';
    setDocId(id);
  };

  return docId ? (
    <EditorScreen key={docId} repo={repo} docId={docId} onClose={() => open(null)} />
  ) : (
    <Library repo={repo} onOpen={open} />
  );
}
