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
 * 事件標記的文字標籤，自己畫、會互相閃避。
 *
 * 圖表庫的 marker 文字只能置中在該根 K 棒、不會閃避；融資斷頭監測的事件天生擠在一波的幾天內
 * （150 → 140 → 斷頭、限空令／國安基金／清洗完成常同一週），5 年視角一根 K 棒不到 1px，字一定疊。
 * 所以 marker 只畫符號，文字改由這個 primitive 畫：同一側（K 棒上方／下方）的標籤由左到右排，
 * 水平重疊就往外錯開一行；畫面外的不畫。
 */

export interface MarkerLabel {
  time: Time;
  /** 標籤對應的序列值（K 棒收盤），用來算 y */
  value: number;
  text: string;
  color: string;
  /** true＝K 棒上方（符號也在上方），false＝下方 */
  above: boolean;
}

export interface MarkerLabelStyle {
  background: string;
  fontSize: number;
  fontFamily: string;
}

/**
 * 由左到右排；每個標籤從自己的基準 y 開始，和已放好的標籤重疊就往外（上方往上、下方往下）推一格，
 * 直到不重疊。回傳每個標籤的中心 y。
 * 和單純「行號」不同：相鄰兩根 K 棒高度不同時，同一行的字也可能疊，所以用實際矩形判斷。
 */
export function layoutStacked(items: { x: number; w: number; y: number }[], h: number, dir: 1 | -1, gap = 2): number[] {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.x - b.x);
  const placed: { x: number; w: number; cy: number }[] = [];
  const out = new Array<number>(items.length).fill(0);
  const hits = (x: number, w: number, cy: number) =>
    placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + gap && Math.abs(p.cy - cy) < h + gap);
  for (const it of order) {
    let cy = it.y;
    let guard = 0;
    while (hits(it.x, it.w, cy) && guard++ < 50) cy += dir * (h + gap);
    placed.push({ x: it.x, w: it.w, cy });
    out[it.i] = cy;
  }
  return out;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

const PAD_X = 3;
const PAD_Y = 1;
/** 符號本身的高度（圖表庫箭頭／方塊約 10～12px）＋間距 */
const SHAPE_OFFSET = 16;

export class MarkerLabels implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    private readonly labels: readonly MarkerLabel[],
    private readonly style: MarkerLabelStyle,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.drawLabels(target) };
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

  private drawLabels(target: DrawTarget): void {
    const s = this.series;
    const chart = this.chart;
    if (!s || !chart) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { fontSize, fontFamily } = this.style;
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const h = fontSize + PAD_Y * 2;
      const ts = chart.timeScale();
      type Placed = { l: MarkerLabel; x: number; y: number; w: number };
      const collect = (above: boolean, extra: Placed[]): Placed[] => {
        const vis: Placed[] = [...extra];
        for (const l of this.labels) {
          if (l.above !== above || !l.text) continue;
          const x = ts.timeToCoordinate(l.time);
          const y = s.priceToCoordinate(l.value);
          if (x === null || y === null || x < 0 || x > mediaSize.width) continue;
          const w = ctx.measureText(l.text).width + PAD_X * 2;
          // 貼近左右邊緣的字往內收，不被切掉
          vis.push({ l, x: Math.min(Math.max(Number(x), w / 2), mediaSize.width - w / 2), y: Number(y), w });
        }
        return vis;
      };
      const draw = (vis: Placed[], above: boolean): Placed[] => {
        const base = vis.map((p) => ({ x: p.x, w: p.w, y: above ? p.y - SHAPE_OFFSET - h / 2 : p.y + SHAPE_OFFSET + h / 2 }));
        const cys = layoutStacked(base, h, above ? -1 : 1);
        const overflow: Placed[] = [];
        vis.forEach((p, i) => {
          const cy = cys[i]!;
          if (cy - h / 2 < 0 || cy + h / 2 > mediaSize.height) {
            overflow.push(p);
            return;
          }
          const left = Math.round(p.x - p.w / 2) + 0.5;
          ctx.beginPath();
          ctx.roundRect(left, Math.round(cy - h / 2) + 0.5, p.w, h, 2);
          ctx.fillStyle = this.style.background;
          ctx.fill();
          ctx.fillStyle = p.l.color;
          ctx.fillText(p.l.text, p.x, Math.round(cy));
        });
        return overflow;
      };
      // 下方先排；放不下（超出窗格底）的改放到 K 棒上方那一疊的最外層
      const belowOverflow = draw(collect(false, []), false);
      draw(collect(true, belowOverflow), true);
    });
  }
}
