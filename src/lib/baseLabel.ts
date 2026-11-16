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
/** 已放好的標籤（中心＋寬高），後面的標籤要避開 */
export type Box = Rect & { w: number; h: number };

/**
 * 在圓點 (x, y) 附近替寬 w、高 h 的標籤找位置。
 * 候選：水平置中／放左側／放右側 × 折線上方／下方；超出窗格或壓到 taken（已放好的標籤）的不要；取離圓點最近的。
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
  taken: readonly Box[] = [],
  spread = 0,
): Rect | null {
  const half = w / 2;
  const clampX = (cx: number) => Math.min(Math.max(cx, half + 1), size.width - half - 1);
  // spread > 0：除了置中／左右貼著，再往左右每 10px 找一格（窗格矮、折線又貼著基準點時才找得到空位）
  const far: number[] = [];
  for (let d = 10; d <= spread; d += 10) far.push(clampX(x + d), clampX(x - d));
  const xs = [...new Set([clampX(x), clampX(x + half + 8), clampX(x - half - 8), ...far])];
  let best: (Rect & { score: number }) | null = null;
  for (const cx of xs) {
    const b = band(cx - half, cx + half) ?? { lo: y, hi: y };
    const lo = Math.min(b.lo, y - 5);
    const hi = Math.max(b.hi, y + 5);
    for (const cy of [lo - gap - h / 2, hi + gap + h / 2]) {
      if (cy - h / 2 < 0 || cy + h / 2 > size.height) continue;
      if (taken.some((t) => Math.abs(t.cx - cx) < (t.w + w) / 2 + 2 && Math.abs(t.cy - cy) < (t.h + h) / 2 + 1)) continue;
      const score = Math.abs(cy - y) + Math.abs(cx - x) * 0.5;
      if (!best || score < best.score) best = { cx, cy, score };
    }
  }
  return best && { cx: best.cx, cy: best.cy };
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

const PAD_X = 3;
const PAD_Y = 1;

export type BaseLabelItem = { time: Time; value: number; text: string; color: string };
type Style = { background: string; fontSize: number; fontFamily: string };

/**
 * 一組基準點標籤（同一窗格、同一刻度）：依序放，後面的避開前面的；折線障礙取 avoid 內所有序列的聯集。
 * dot＝true 時圓點也由這裡畫（位置在標籤的 value，不一定在折線上）。
 */
export class BaseLabelGroup implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    readonly labels: readonly BaseLabelItem[],
    private readonly style: Style,
    private readonly opts: { avoid?: readonly ISeriesApi<SeriesType>[]; dot?: boolean; spread?: number; minBarSpacing?: number } = {},
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
    const lines = this.opts.avoid?.length ? this.opts.avoid : [s];
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      const { fontSize, fontFamily } = this.style;
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const band = (x0: number, x1: number): { lo: number; hi: number } | null => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let cx = x0; cx <= x1 + 3; cx += 3) {
          const logical = ts.coordinateToLogical(Math.min(cx, x1));
          if (logical === null) continue;
          for (const line of lines) {
            const d = line.dataByIndex(Math.round(logical), MismatchDirection.NearestLeft) as { value?: number } | null;
            if (d?.value === undefined) continue;
            const cy = line.priceToCoordinate(d.value);
            if (cy === null) continue;
            lo = Math.min(lo, Number(cy));
            hi = Math.max(hi, Number(cy));
          }
        }
        return lo === Infinity ? null : { lo, hi };
      };
      const taken: Box[] = [];
      for (const label of this.labels) {
        const px = ts.timeToCoordinate(label.time);
        const py = s.priceToCoordinate(label.value);
        if (px === null || py === null) continue;
        const x = Number(px);
        const y = Number(py);
        // 基準點在畫面外就不標（讀數列的日期仍看得到）
        if (x < -8 || x > mediaSize.width + 8 || y < 0 || y > mediaSize.height) continue;
        if (this.opts.dot) {
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = label.color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = this.style.background;
          ctx.stroke();
        }
        // 長視角（每根不到 minBarSpacing px）兩個圓點擠在一起，字放哪都對不上，只留圓點
        if (this.opts.minBarSpacing && ts.options().barSpacing < this.opts.minBarSpacing) continue;
        const w = ctx.measureText(label.text).width + PAD_X * 2;
        const h = fontSize + PAD_Y * 2;
        const pos = placeBaseLabel(x, y, w, h, mediaSize, band, 4, taken, this.opts.spread ?? 0);
        if (!pos) continue;
        taken.push({ ...pos, w, h });
        // 離圓點遠（字被折線擠開）時畫細線連回去
        const edgeY = pos.cy < y ? pos.cy + h / 2 : pos.cy - h / 2;
        if (Math.abs(edgeY - y) > 12) {
          ctx.beginPath();
          ctx.moveTo(x, y + (pos.cy < y ? -5 : 5));
          ctx.lineTo(Math.min(Math.max(x, pos.cx - w / 2 + 4), pos.cx + w / 2 - 4), edgeY);
          ctx.strokeStyle = label.color;
          ctx.lineWidth = 1;
          ctx.globalAlpha = 0.6;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.roundRect(Math.round(pos.cx - w / 2) + 0.5, Math.round(pos.cy - h / 2) + 0.5, w, h, 2);
        ctx.fillStyle = this.style.background;
        ctx.fill();
        ctx.fillStyle = label.color;
        ctx.fillText(label.text, pos.cx, Math.round(pos.cy));
      }
    });
  }
}

/** 單一基準點（漲跌停面板用；圓點由 series marker 畫） */
export class BaseLabel extends BaseLabelGroup {
  constructor(
    readonly label: BaseLabelItem,
    style: Style,
  ) {
    super([label], style);
  }
}
