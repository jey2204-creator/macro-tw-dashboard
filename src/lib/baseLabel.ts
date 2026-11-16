import {
  MismatchDirection,
  type IChartApiBase,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
} from 'lightweight-charts';

/**
 * 基準點（百分比軸 0% 起算的那一根）旁的文字標籤。
 *
 * 事件用的 MarkerLabels 只會往上或往下推，基準點後面的折線一上漲，字就被推到窗格頂端甚至畫面外；
 * 基準點只有一個，改成在圓點四周找「離圓點最近、又不壓到折線」的位置，離得遠時畫一條細線連回圓點。
 */

export type Rect = { cx: number; cy: number };

/**
 * 在圓點 (x, y) 附近替寬 w、高 h 的標籤找位置。
 * 候選：水平置中／放左側／放右側 × 折線上方／下方；超出窗格的不要；取離圓點最近的。
 * band(x0, x1) 回傳該水平範圍內折線的 y 區間（lo＝最上、hi＝最下）。
 */
export function placeBaseLabel(
  x: number,
  y: number,
  w: number,
  h: number,
  size: { width: number; height: number },
  band: (x0: number, x1: number) => { lo: number; hi: number } | null,
  gap = 4,
): Rect | null {
  const half = w / 2;
  const clampX = (cx: number) => Math.min(Math.max(cx, half + 1), size.width - half - 1);
  const xs = [...new Set([clampX(x), clampX(x + half + 8), clampX(x - half - 8)])];
  let best: (Rect & { score: number }) | null = null;
  for (const cx of xs) {
    const b = band(cx - half, cx + half) ?? { lo: y, hi: y };
    const lo = Math.min(b.lo, y - 5);
    const hi = Math.max(b.hi, y + 5);
    for (const cy of [lo - gap - h / 2, hi + gap + h / 2]) {
      if (cy - h / 2 < 0 || cy + h / 2 > size.height) continue;
      const score = Math.abs(cy - y) + Math.abs(cx - x) * 0.5;
      if (!best || score < best.score) best = { cx, cy, score };
    }
  }
  return best && { cx: best.cx, cy: best.cy };
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

const PAD_X = 3;
const PAD_Y = 1;

export class BaseLabel implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    readonly label: { time: Time; value: number; text: string; color: string },
    private readonly style: { background: string; fontSize: number; fontFamily: string },
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: () => 'top', renderer: () => renderer }];
  }

  attached({ series, chart }: SeriesAttachedParameter<Time>): void {
    this.series = series;
    this.chart = chart;
  }

  detached(): void {
    this.series = null;
    this.chart = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: DrawTarget): void {
    const s = this.series;
    const chart = this.chart;
    if (!s || !chart) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const px = ts.timeToCoordinate(this.label.time);
      const py = s.priceToCoordinate(this.label.value);
      if (px === null || py === null) return;
      const x = Number(px);
      const y = Number(py);
      // 基準點在畫面外就不標（圖例的「自 M/D 起」仍看得到日期）
      if (x < -8 || x > mediaSize.width + 8 || y < 0 || y > mediaSize.height) return;
      const { fontSize, fontFamily } = this.style;
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const w = ctx.measureText(this.label.text).width + PAD_X * 2;
      const h = fontSize + PAD_Y * 2;
      const band = (x0: number, x1: number): { lo: number; hi: number } | null => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let cx = x0; cx <= x1 + 3; cx += 3) {
          const logical = ts.coordinateToLogical(Math.min(cx, x1));
          if (logical === null) continue;
          const d = s.dataByIndex(Math.round(logical), MismatchDirection.NearestLeft) as { value?: number } | null;
          if (d?.value === undefined) continue;
          const cy = s.priceToCoordinate(d.value);
          if (cy === null) continue;
          lo = Math.min(lo, Number(cy));
          hi = Math.max(hi, Number(cy));
        }
        return lo === Infinity ? null : { lo, hi };
      };
      const pos = placeBaseLabel(x, y, w, h, mediaSize, band);
      if (!pos) return;
      // 離圓點遠（字被折線擠開）時畫細線連回去
      const edgeY = pos.cy < y ? pos.cy + h / 2 : pos.cy - h / 2;
      if (Math.abs(edgeY - y) > 12) {
        ctx.beginPath();
        ctx.moveTo(x, y + (pos.cy < y ? -5 : 5));
        ctx.lineTo(Math.min(Math.max(x, pos.cx - w / 2 + 4), pos.cx + w / 2 - 4), edgeY);
        ctx.strokeStyle = this.label.color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.roundRect(Math.round(pos.cx - w / 2) + 0.5, Math.round(pos.cy - h / 2) + 0.5, w, h, 2);
      ctx.fillStyle = this.style.background;
      ctx.fill();
      ctx.fillStyle = this.label.color;
      ctx.fillText(this.label.text, pos.cx, Math.round(pos.cy));
    });
  }
}
