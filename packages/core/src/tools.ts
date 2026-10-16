import type { InkTool } from './model';
import { CONSTANT_PROFILE, type WidthProfile } from './width';

export interface ToolPreset {
  label: string;
  /** true: 필압/속도로 굵기가 변하는 외곽선 렌더링, false: 일정 굵기 중심선 렌더링 */
  variable: boolean;
  profile: WidthProfile;
  opacity: number;
  widths: number[];
  defaultWidth: number;
  defaultColor: string;
  cap: 'round' | 'butt';
  /** 'under' 는 잉크 아래(형광펜) */
  layer: 'ink' | 'under';
  blend: 'normal' | 'multiply';
  /** 시작~끝을 잇는 직선으로 보정 */
  straight: boolean;
  /** 손떨림 보정 강도 0..1 */
  stabilization: number;
  texture?: 'grain';
}

export const TOOL_PRESETS: Record<InkTool, ToolPreset> = {
  pen: {
    label: '만년필',
    variable: true,
    profile: { pressure: 0.85, minRatio: 0.28, gamma: 0.7, velocity: 0.35, velocityRef: 2.2, taper: 14, smoothing: 0.45 },
    opacity: 1,
    widths: [1.2, 2, 3.2, 5],
    defaultWidth: 2,
    defaultColor: '#1b1f3b',
    cap: 'round',
    layer: 'ink',
    blend: 'normal',
    straight: false,
    stabilization: 0.5,
  },
  pencil: {
    label: '연필',
    variable: true,
    profile: { pressure: 0.6, minRatio: 0.45, gamma: 0.9, velocity: 0.1, velocityRef: 3, taper: 6, smoothing: 0.5 },
    opacity: 0.82,
    widths: [0.9, 1.5, 2.4],
    defaultWidth: 1.5,
    defaultColor: '#3a3a3a',
    cap: 'round',
    layer: 'ink',
    blend: 'normal',
    straight: false,
    stabilization: 0.35,
    texture: 'grain',
  },
  ballpoint: {
    label: '볼펜(필압 없음)',
    variable: false,
    profile: CONSTANT_PROFILE,
    opacity: 1,
    widths: [0.8, 1.4, 2.2, 3.2],
    defaultWidth: 1.4,
    defaultColor: '#1d4ed8',
    cap: 'round',
    layer: 'ink',
    blend: 'normal',
    straight: false,
    stabilization: 0.55,
  },
  marker: {
    label: '마카',
    variable: false,
    profile: CONSTANT_PROFILE,
    opacity: 1,
    widths: [4, 6, 9],
    defaultWidth: 6,
    defaultColor: '#dc2626',
    cap: 'round',
    layer: 'ink',
    blend: 'normal',
    straight: false,
    stabilization: 0.6,
  },
  highlighter: {
    label: '형광펜',
    variable: false,
    profile: CONSTANT_PROFILE,
    opacity: 0.38,
    widths: [10, 14, 20],
    defaultWidth: 14,
    defaultColor: '#facc15',
    cap: 'butt',
    layer: 'under',
    blend: 'multiply',
    straight: false,
    stabilization: 0.7,
  },
  underline: {
    label: '밑줄',
    variable: false,
    profile: CONSTANT_PROFILE,
    opacity: 1,
    widths: [1, 1.8, 3],
    defaultWidth: 1.8,
    defaultColor: '#dc2626',
    cap: 'round',
    layer: 'ink',
    blend: 'normal',
    straight: true,
    stabilization: 0,
  },
};

export const PALETTE = [
  '#1b1f3b', '#3a3a3a', '#1d4ed8', '#0891b2', '#16a34a', '#dc2626',
  '#ea580c', '#9333ea', '#db2777', '#facc15', '#86efac', '#93c5fd',
];
