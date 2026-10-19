/// <reference lib="webworker" />
import { unzipSync } from 'fflate';
import { convertGoodnotes } from '@inknote/core';

/** 굿노트 파일 압축 해제 + 변환 (수십 MB 도 화면을 멈추지 않도록 워커에서) */
self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  try {
    const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
    const files = new Map(Object.entries(unzipSync(new Uint8Array(e.data))));
    post({ progress: `압축 해제 완료 (${files.size}개 파일)` });
    const result = convertGoodnotes(files, { onProgress: (done, total) => post({ progress: `페이지 변환 ${done}/${total}` }) });
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
