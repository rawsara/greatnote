/**
 * InkNote 벡터 데이터 모델.
 *
 * 모든 필기/도형은 래스터 이미지가 아니라 "좌표 배열 + 스타일" 객체로 저장된다.
 * 좌표 단위는 PDF 포인트(1/72 inch)이며, 페이지 좌상단이 원점(y 아래로 증가)이다.
 * → 줌과 무관하게 동일한 데이터를 렌더링하고, PDF 내보내기 시 좌표를 그대로 사용할 수 있다.
 */

/** 획 포인트 배열의 stride: [x, y, w] — w 는 기준 굵기 대비 폭 비율(필압·속도 반영 결과) */
export const STRIDE = 3;

/** 펜 계열 도구 (획 객체로 저장되는 도구) */
export type InkTool =
  | 'pen' // 만년필: 필압 + 속도 반영
  | 'pencil' // 연필: 필압 반영 + 질감
  | 'ballpoint' // 필압 없는 펜(볼펜): 일정 굵기
  | 'marker' // 마카: 굵고 일정
  | 'highlighter' // 형광펜: 반투명, 잉크 아래 레이어
  | 'underline'; // 밑줄 도구: 직선 보정

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';

interface ObjBase {
  id: string;
  pageId: string;
  /** z-order (Lamport 시계 기반이라 기기 간에도 인과 순서가 보존됨) */
  z: number;
}

export interface StrokeObj extends ObjBase {
  type: 'stroke';
  tool: InkTool;
  /** #rrggbb */
  color: string;
  /** 기준 굵기 (pt) */
  width: number;
  opacity: number;
  /** [x, y, w, x, y, w, ...] */
  pts: number[];
}

export interface ShapeObj extends ObjBase {
  type: 'shape';
  shape: ShapeKind;
  color: string;
  width: number;
  opacity: number;
  /** line/arrow: 시작→끝, rect/ellipse: 대각선 두 꼭짓점 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 단어 암기용 테이프: 탭하면 가림/보임이 토글된다 */
export interface TapeObj extends ObjBase {
  type: 'tape';
  color: string;
  thickness: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  revealed: boolean;
}

export type InkObject = StrokeObj | ShapeObj | TapeObj;

export type PaperKind = 'blank' | 'lined' | 'grid' | 'dotted';

export type PageBackground =
  | { kind: PaperKind }
  | { kind: 'pdf'; assetId: string; pageIndex: number };

export interface Page {
  id: string;
  /** fractional index — 동시 편집에도 안전한 페이지 순서 키 */
  order: string;
  width: number;
  height: number;
  bg: PageBackground;
}

export interface DocMeta {
  title: string;
  createdAt: number;
}

/** PDF 원본 파일. id 는 내용의 SHA-256 (content-addressed) */
export interface PdfAsset {
  id: string;
  name: string;
  pageCount: number;
  size: number;
}

export const A4 = { width: 595.28, height: 841.89 } as const;
