import { useSyncExternalStore } from 'react';

/** 테마: 시스템 설정 따르기 / 라이트 / 다크. 종이(페이지)는 PDF 가독성을 위해 항상 흰색 */
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'inknote.theme';
const listeners = new Set<() => void>();
let current: Theme = read();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function applyTheme(t: Theme = current): void {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  applyTheme(t);
  listeners.forEach((l) => l());
}

export function cycleTheme(): void {
  setTheme(current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system');
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export const THEME_LABEL: Record<Theme, string> = { system: '시스템 테마', light: '라이트 모드', dark: '다크 모드' };
