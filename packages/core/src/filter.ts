import { lerp } from './geometry';

/**
 * 2D One Euro Filter (Casiez et al. 2012) — 입력 단계의 손떨림 보정.
 *
 * 느리게 그릴 때는 cutoff 가 낮아져 떨림을 강하게 제거하고,
 * 빠르게 그릴 때는 cutoff 가 높아져 지연(lag)을 최소화한다.
 * 필터는 인과적(causal)이라 이미 출력된 점은 이후에 바뀌지 않는다
 * → 펜을 떼는 순간 획 모양이 "튀는" 현상이 없다.
 *
 * 좌표는 화면 px, 시간은 ms 단위로 넣는다 (줌과 무관한 손떨림 크기 기준).
 */
export class PointFilter {
  private x = 0;
  private y = 0;
  private dx = 0;
  private dy = 0;
  private rawX = 0;
  private rawY = 0;
  private lastT = -1;

  constructor(
    public minCutoff = 6,
    public beta = 0.06,
    public dCutoff = 1,
  ) {}

  /** stabilization 0(보정 없음)…1(강한 보정) */
  static fromStabilization(s: number): PointFilter {
    return new PointFilter(lerp(30, 1.2, s), lerp(0.2, 0.03, s));
  }

  reset(): void {
    this.lastT = -1;
  }

  filter(x: number, y: number, tMs: number): [number, number] {
    if (this.lastT < 0) {
      this.x = this.rawX = x;
      this.y = this.rawY = y;
      this.dx = this.dy = 0;
      this.lastT = tMs;
      return [x, y];
    }
    let dt = (tMs - this.lastT) / 1000;
    if (!(dt > 0)) dt = 1 / 240;
    this.lastT = tMs;

    const ad = alpha(this.dCutoff, dt);
    this.dx += ad * ((x - this.rawX) / dt - this.dx);
    this.dy += ad * ((y - this.rawY) / dt - this.dy);
    this.rawX = x;
    this.rawY = y;

    const speed = Math.hypot(this.dx, this.dy); // px/s
    const a = alpha(this.minCutoff + this.beta * speed, dt);
    this.x += a * (x - this.x);
    this.y += a * (y - this.y);
    return [this.x, this.y];
  }

  /** 예측(predicted) 포인트를 상태 오염 없이 계산하기 위한 복제 */
  clone(): PointFilter {
    const f = new PointFilter(this.minCutoff, this.beta, this.dCutoff);
    Object.assign(f, this);
    return f;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
