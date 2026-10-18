import { clamp, distSq } from './geometry';
import { STRIDE } from './model';

/**
 * 필압 + 속도 기반 굵기 모델.
 *
 *   ratio = pressureFactor × velocityFactor × taper
 *
 * - pressureFactor: 필압 곡선(gamma) 적용 후 [minRatio, 1] 로 매핑, `pressure` 로 영향도 조절
 * - velocityFactor: 빠르게 그을수록 얇아짐(실제 만년필의 잉크 흐름 모사)
 * - 필압 센서가 없는 입력(마우스/손가락)은 속도로 필압을 추정한다 (느릴수록 꾹 누른 것처럼 굵게)
 * - 시작·끝은 항상 가늘게(taper) — 필압 입력은 짧게, 필압 없는 입력은 길게
 *
 * 계산된 비율은 포인트마다 저장(stride 의 w)되어, 모든 기기에서 동일하게 재현된다.
 */
export interface WidthProfile {
  /** 필압 영향도 0..1 */
  pressure: number;
  /** 필압 0 일 때의 굵기 비율 */
  minRatio: number;
  /** 필압 곡선 (1 = 선형, <1 = 가벼운 필압에도 빨리 굵어짐) */
  gamma: number;
  /** 고속 시 최대 얇아짐 비율 0..1 */
  velocity: number;
  /** 이 속도(px/ms) 이상이면 velocity 만큼 최대로 얇아짐 */
  velocityRef: number;
  /** 시작·끝 taper 길이 (px, 필압 입력은 절반) */
  taper: number;
  /** 굵기 변화 평활화 (새 값 반영 비율 0..1) */
  smoothing: number;
}

export const CONSTANT_PROFILE: WidthProfile = {
  pressure: 0,
  minRatio: 1,
  gamma: 1,
  velocity: 0,
  velocityRef: 1,
  taper: 0,
  smoothing: 1,
};

export class WidthEstimator {
  private lastX = 0;
  private lastY = 0;
  private lastT = -1;
  private speed = 0;
  private w = -1;
  private traveled = 0;

  constructor(
    private readonly profile: WidthProfile,
    private readonly hasPressure: boolean,
  ) {}

  /** x, y: 화면 px / pressure: 0..1 / t: ms */
  next(x: number, y: number, pressure: number, t: number): number {
    const p = this.profile;
    if (this.lastT >= 0) {
      const d = Math.sqrt(distSq(x, y, this.lastX, this.lastY));
      const dt = Math.max(1, t - this.lastT);
      this.speed += 0.3 * (d / dt - this.speed);
      this.traveled += d;
    }
    this.lastX = x;
    this.lastY = y;
    this.lastT = t;

    const pr = this.hasPressure ? clamp(pressure, 0, 1) : estimatePressure(this.speed, p.velocityRef);
    const pTerm = p.minRatio + (1 - p.minRatio) * Math.pow(pr, p.gamma);
    const pressureFactor = 1 - p.pressure + p.pressure * pTerm;
    const velocityFactor = 1 - p.velocity * clamp(this.speed / p.velocityRef, 0, 1);
    let target = pressureFactor * velocityFactor;
    const taper = taperLength(p, this.hasPressure);
    if (taper > 0) target *= taperEase(this.traveled / taper);

    this.w = this.w < 0 ? target : this.w + (target - this.w) * p.smoothing;
    return Math.round(this.w * 1000) / 1000;
  }
}

/** 속도 → 가상 필압: 멈춰 있으면 0.85, velocityRef 의 1.5배 이상이면 0.3 */
export function estimatePressure(speed: number, velocityRef: number): number {
  return 0.85 - 0.55 * clamp(speed / (velocityRef * 1.5), 0, 1);
}

export function taperLength(p: WidthProfile, hasPressure: boolean): number {
  return hasPressure ? p.taper * 0.5 : p.taper;
}

function taperEase(u: number): number {
  if (u >= 1) return 1;
  return 0.35 + 0.65 * Math.sin((u * Math.PI) / 2);
}

/** 펜을 뗀 뒤 끝부분 taper 적용 (필압 없는 입력용). length 는 페이지 단위 */
export function applyEndTaper(pts: number[], length: number): void {
  const n = pts.length / STRIDE;
  if (n < 3 || length <= 0) return;
  let acc = 0;
  for (let i = n - 1; i > 0; i--) {
    const k = i * STRIDE;
    const u = acc / length;
    if (u >= 1) break;
    pts[k + 2] = Math.round(pts[k + 2] * taperEase(u) * 1000) / 1000;
    acc += Math.sqrt(distSq(pts[k], pts[k + 1], pts[k - STRIDE], pts[k - STRIDE + 1]));
  }
}
