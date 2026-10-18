import type { ReactNode } from 'react';

const S = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const Icon = {
  pen: () => <S><path d="M4 20l3.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11z" /><path d="M14 6l3 3" /></S>,
  pencil: () => <S><path d="M5 19l2-6 9-9 4 4-9 9z" /><path d="M7 13l4 4" /><path d="M5 19l2.5-.8" /></S>,
  ballpoint: () => <S><path d="M6 18l12-12" /><path d="M15 4l5 5" /><path d="M6 18l-2 2" /></S>,
  marker: () => <S><path d="M7 17l-3 3h6l2-2" /><path d="M9 15l8-8 3 3-8 8z" /></S>,
  highlighter: () => <S><path d="M9 14l-4 4v2h5l3-3" /><path d="M9 14l7-9 4 4-9 7z" /><path d="M4 22h16" strokeWidth={3} stroke="#facc15" /></S>,
  underline: () => <S><path d="M7 4v6a5 5 0 0 0 10 0V4" /><path d="M5 20h14" /></S>,
  eraser: () => <S><path d="M7 21h10" /><path d="M5.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L13 18H8z" /><path d="M9.5 11.5l4 4" /></S>,
  lasso: () => <S><ellipse cx="12" cy="9" rx="8" ry="5" strokeDasharray="3 2.4" /><path d="M8 13.5c-1 2 0 4 2 4 1.5 0 1.5 2-.5 3" /></S>,
  shape: () => <S><rect x="3" y="11" width="9" height="9" rx="1" /><circle cx="16" cy="8" r="5" /></S>,
  tape: () => <S><rect x="3" y="8" width="18" height="8" rx="1.5" /><path d="M7 8l-2 8M12 8l-2 8M17 8l-2 8" opacity=".5" /></S>,
  ruler: () => <S><rect x="2" y="8" width="20" height="8" rx="1.5" transform="rotate(-20 12 12)" /><path d="M7 10.3l.7 2M10.5 9l.7 2M14 7.8l.7 2" /></S>,
  undo: () => <S><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></S>,
  redo: () => <S><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></S>,
  back: () => <S><path d="M15 18l-6-6 6-6" /></S>,
  pages: () => <S><rect x="4" y="3" width="11" height="14" rx="1.5" /><path d="M9 21h9.5A1.5 1.5 0 0 0 20 19.5V8" /></S>,
  plus: () => <S><path d="M12 5v14M5 12h14" /></S>,
  share: () => <S><path d="M12 3v12" /><path d="M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></S>,
  file: () => <S><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></S>,
  trash: () => <S><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></S>,
  copy: () => <S><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></S>,
  up: () => <S><path d="M6 15l6-6 6 6" /></S>,
  down: () => <S><path d="M6 9l6 6 6-6" /></S>,
  zoomIn: () => <S><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6M11 8v6" /></S>,
  zoomOut: () => <S><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" /></S>,
  eye: () => <S><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></S>,
  eyeOff: () => <S><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6" /></S>,
  cloud: () => <S><path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z" /></S>,
  sun: () => <S><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></S>,
  moon: () => <S><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></S>,
  monitor: () => <S><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></S>,
  paste: () => <S><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h6" /></S>,
  settings: () => <S><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>,
};
