import { useEffect, useRef, useState } from 'react';

export const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** 화면 어디에든 파일(기본: PDF)을 끌어다 놓으면 onFile 호출. 반환값: 지금 끌고 있는지 */
export function usePdfDrop(onFile: (file: File) => void, accept: (f: File) => boolean = isPdf): boolean {
  const [dragging, setDragging] = useState(false);
  const cb = useRef(onFile);
  cb.current = onFile;
  const acc = useRef(accept);
  acc.current = accept;

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => acc.current(f));
      if (file) cb.current(file);
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragover', over);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
    };
  }, []);

  return dragging;
}
