import type { EraserMode, InkDocument, InkTool, Page, ShapeKind } from '@inknote/core';

export type ToolId = InkTool | 'eraser' | 'lasso' | 'shape' | 'tape';

export interface Selection {
  pageId: string;
  ids: string[];
}

export interface EditorUIState {
  tool: ToolId;
  inkStyles: Record<InkTool, { color: string; width: number }>;
  eraserMode: EraserMode;
  /** 화면 px 지름 */
  eraserSize: number;
  shapeKind: ShapeKind;
  shapeStyle: { color: string; width: number };
  tapeStyle: { color: string; width: number };
  ruler: boolean;
  /** 펜이 감지되면 손가락은 스크롤/줌 전용 (팜 리젝션) */
  penOnly: boolean;
  zoom: number;
  currentPageId: string | null;
  selection: Selection | null;
  canUndo: boolean;
  canRedo: boolean;
  docVersion: number;
}

/** 월드(레이아웃) 좌표에서의 페이지 위치 */
export interface PageRect {
  page: Page;
  x: number;
  y: number;
}

/** 자: 월드 좌표 중심 + 각도. 크기는 화면 px 고정 */
export interface RulerState {
  cx: number;
  cy: number;
  angle: number;
  length: number;
  thickness: number;
}

/** 페이지 좌표의 직선 (점 + 단위 방향) */
export interface SnapLine {
  ax: number;
  ay: number;
  dx: number;
  dy: number;
}

export interface Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  /** 형광펜 라이브 미리보기는 overlay 에 multiply 블렌딩이 필요 */
  readonly blendMultiply?: boolean;
  move(e: PointerEvent, coalesced: PointerEvent[], predicted: PointerEvent[]): void;
  up(e: PointerEvent): void;
  cancel(): void;
  drawOverlay(ctx: CanvasRenderingContext2D): void;
}

export interface EditorHost {
  readonly doc: InkDocument;
  readonly state: EditorUIState;
  readonly zoom: number;
  readonly ruler: RulerState;
  readonly hidden: Set<string>;
  local(e: PointerEvent): [number, number];
  toPage(rect: PageRect, sx: number, sy: number): [number, number];
  pageToScreen(rect: PageRect, x: number, y: number): [number, number];
  pageTransform(ctx: CanvasRenderingContext2D, rect: PageRect): void;
  rulerSnapLine(rect: PageRect, sx: number, sy: number): SnapLine | null;
  setSelection(sel: Selection | null): void;
  setHidden(ids: string[]): void;
  invalidate(base?: boolean): void;
  rulerMoved(): void;
}
