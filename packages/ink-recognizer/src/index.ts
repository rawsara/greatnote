import { registerPlugin } from '@capacitor/core';

/**
 * 기기 내장 손글씨 인식 플러그인.
 *  - iOS/iPadOS: Apple Vision (VNRecognizeTextRequest) — 필기만 그린 페이지 이미지를 인식 (한국어는 iOS 16+)
 *  - Android: Google ML Kit Digital Ink — 줄 단위 획 좌표를 인식 (언어 모델은 처음 한 번 내려받음, 약 20MB)
 * 웹 브라우저에서는 available=false.
 */
export interface RecognizerInfo {
  available: boolean;
  engine: 'vision' | 'mlkit' | 'none';
  languages: string[];
  /** Android: 언어 모델이 아직 없으면 false (prepare 로 내려받기) */
  ready?: boolean;
}

/** 정규화 좌표 (0~1, 좌상단 원점) */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageLine extends NormRect {
  text: string;
  /** 다른 후보 (줄 전체) */
  alts: string[];
  words: Array<NormRect & { text: string }>;
}

export interface StrokeLineInput {
  /** 획마다 [x, y, t(ms), x, y, t, ...] */
  strokes: number[][];
  /** 쓰기 영역 크기 (인식 정확도 향상) */
  width: number;
  height: number;
}

export interface InkRecognizerPlugin {
  info(): Promise<RecognizerInfo>;
  /** Android: 언어 모델 내려받기 (Wi-Fi 아니어도 진행) */
  prepare(opts: { language: string }): Promise<{ ready: boolean }>;
  /** iOS: PNG(base64, 머리말 없이) 속 손글씨 인식 */
  recognizeImage(opts: { image: string; languages: string[] }): Promise<{ lines: ImageLine[] }>;
  /** Android: 줄마다 획 인식 → 줄마다 후보 문자열 (1순위 먼저) */
  recognizeStrokes(opts: { language: string; lines: StrokeLineInput[] }): Promise<{ lines: Array<{ candidates: string[] }> }>;
}

export const InkRecognizer = registerPlugin<InkRecognizerPlugin>('InkRecognizer', {
  web: {
    info: async () => ({ available: false, engine: 'none', languages: [] }),
    prepare: async () => ({ ready: false }),
    recognizeImage: async () => ({ lines: [] }),
    recognizeStrokes: async () => ({ lines: [] }),
  },
});
