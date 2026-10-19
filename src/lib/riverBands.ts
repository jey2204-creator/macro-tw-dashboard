import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

/**
 * 本益比河流圖的色帶：相鄰兩條倍數線之間填色（15–19、19–23、23–27、27–31 倍）。
 * 以 series primitive 畫在格線之下（zOrder 'bottom'），不另外加序列，所以不影響十字線讀值。
 * 倍數線本身是一般 LineSeries（讓價格軸自動縮放把整條河道包進來），色帶只負責填色。
 *
 * 前提：同一張圖所有序列的時間點完全相同（都來自同一組 RiverRow），所以「邏輯索引＝列索引」，
 * x 座標用 timeScale.logicalToCoordinate(i) 取得，不必逐點查 timeToCoordinate。
 */

export interface RiverBand {
  /** 下緣每列的值（列索引＝圖表邏輯索引） */
  lower: readonly number[];
  upper: readonly number[];
  /** 已解析的填色（rgba） */
  color: string;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export class RiverBands implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private readonly bands: readonly RiverBand[]) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.drawBands(target) };
    this.views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  }

  attached({ chart, series }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private drawBands(target: DrawTarget): void {
    const chart = this.chart;
    const s = this.series;
    if (!chart || !s || this.bands.length === 0) return;
    const ts = chart.timeScale();
    const lr = ts.getVisibleLogicalRange();
    if (!lr) return;
    const n = this.bands[0]!.lower.length;
    const from = Math.max(0, Math.floor(lr.from));
    const to = Math.min(n - 1, Math.ceil(lr.to));
    if (to < from) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      // 每個 CSS 像素最多取一點：全部區間（約 2.5 萬根）也只畫幾百個頂點
      const widthCss = bitmapSize.width / hr;
      const step = Math.max(1, Math.floor((to - from) / Math.max(1, widthCss)));
      const idx: number[] = [];
      for (let i = from; i < to; i += step) idx.push(i);
      idx.push(to);
      const xs = idx.map((i) => ts.logicalToCoordinate(i as never));
      for (const b of this.bands) {
        context.beginPath();
        let started = false;
        const trace = (vals: readonly number[], reverse: boolean) => {
          for (let q = 0; q < idx.length; q++) {
            const p = reverse ? idx.length - 1 - q : q;
            const x = xs[p];
            const y = s.priceToCoordinate(vals[idx[p]!]!);
            if (x === null || x === undefined || y === null) continue;
            const bx = x * hr;
            const by = y * vr;
            if (!started) {
              context.moveTo(bx, by);
              started = true;
            } else context.lineTo(bx, by);
          }
        };
        trace(b.upper, false);
        trace(b.lower, true);
        if (!started) continue;
        context.closePath();
        context.fillStyle = b.color;
        context.fill();
      }
    });
  }
}
