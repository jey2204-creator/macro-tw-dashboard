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
 * 水平門檻線的名稱標籤，畫在窗格左側、線上（不佔右側價格軸）。
 *
 * 圖表庫的 createPriceLine 若開軸標籤，門檻與序列現值靠近時會在右軸打架（手機窗格矮、
 * 三個標籤擠在一起，現值被蓋住）；關掉軸標籤，線上的 title 也會一起消失。所以門檻線只畫線，
 * 名稱改用 series primitive 自己畫：文字加一層底色貼在線上、靠左，線在畫面外就不畫（不貼邊，
 * 不會讓人以為門檻就在窗格底部）。右軸只留序列現值一個標籤。
 */

export interface LineLabel {
  price: number;
  text: string;
  /** 放不下時的短版（例如只剩數字）；連短版都放不下就不畫 */
  short?: string;
}

export interface LineLabelStyle {
  /** 文字顏色 */
  color: string;
  /** 文字底色（通常是圖表背景色，遮掉底下的虛線與序列線） */
  background: string;
  /** 外框色（通常同線色） */
  border: string;
  /** 字級（px） */
  fontSize: number;
  fontFamily: string;
  /** 只在窗格上方這個比例內畫（0～1）；下方留給疊在同一窗格的柱狀圖時用 */
  maxYFrac?: number;
  /** 貼左（預設，門檻線名稱）或貼右（序列線尾的現值，取代右軸標籤） */
  align?: 'left' | 'right';
  /**
   * 要閃開的折線（貼右時用）：標籤在自己那段 x 範圍內壓到任一條線，就上下找第一個空位，
   * 再畫一條細線指回原本的位置
   */
  avoid?: readonly ISeriesApi<SeriesType>[];
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

const PAD_X = 4;
const PAD_Y = 2;
const LEFT = 6;

const GAP = 3;

export class LineLabels implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private chart: IChartApiBase<Time> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    private readonly labels: readonly LineLabel[],
    private readonly style: LineLabelStyle,
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

  /** 自己這條序列最後一個點的 x 座標 */
  private lineEndX(): number | null {
    const s = this.series;
    const chart = this.chart;
    if (!s || !chart) return null;
    const d = s.data();
    const last = d[d.length - 1];
    return last ? chart.timeScale().timeToCoordinate(last.time) : null;
  }

  /** 標籤 x 範圍內，每條要閃開的折線落在哪些 y（每 3px 取樣一次） */
  private obstacleYs(x0: number, x1: number): number[] {
    const chart = this.chart;
    const avoid = this.style.avoid;
    if (!chart || !avoid?.length) return [];
    const ts = chart.timeScale();
    const ys: number[] = [];
    for (let x = x0; x <= x1; x += 3) {
      const logical = ts.coordinateToLogical(x);
      if (logical === null) continue;
      for (const s of avoid) {
        const d = s.dataByIndex(Math.round(logical), MismatchDirection.NearestLeft) as { value?: number; close?: number } | null;
        const v = d?.value ?? d?.close;
        if (v === undefined) continue;
        const y = s.priceToCoordinate(v);
        if (y !== null) ys.push(y);
      }
    }
    return ys;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private drawLabels(target: DrawTarget): void {
    const s = this.series;
    if (!s) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { fontSize, fontFamily } = this.style;
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const h = fontSize + PAD_Y * 2;
      for (const l of this.labels) {
        const y0 = s.priceToCoordinate(l.price);
        const bottom = mediaSize.height * (this.style.maxYFrac ?? 1);
        if (y0 === null) continue;
        let y: number = y0;
        let text = l.text;
        let w = ctx.measureText(text).width + PAD_X * 2;
        let x = this.style.align === 'right' ? mediaSize.width - LEFT - w : LEFT;
        let moved = false;
        if (this.style.align === 'right') {
          // 線尾現值：只能放在 maxYFrac 以上（下方是柱子區，不進去）；先夾進範圍，再閃開壓到的折線
          // （上下交替找第一個空位）；全版放不下就換短版再找一次；還是沒有就不畫（狀態列有數字）
          const step = h + GAP;
          const xRight = mediaSize.width - LEFT - w;
          // 先在原 x 找上下空位；找不到就把標籤往左挪半個寬度再找，最多挪三個寬度（線尾通常很陡，左邊線平的地方上方有空間）
          const place = (lw: number): { x: number; y: number } | null => {
            for (let j = 0; j <= 6; j++) {
              const lx = mediaSize.width - LEFT - lw - (j * lw) / 2;
              if (lx < LEFT) break;
              const obs = this.obstacleYs(lx, lx + lw);
              const free = (cy: number) => obs.every((oy) => oy < cy - h / 2 - GAP || oy > cy + h / 2 + GAP);
              const c0 = Math.min(Math.max(y0, h / 2), bottom - h / 2);
              if (free(c0)) return { x: lx, y: c0 };
              for (let k = 1; k * step <= bottom; k++) {
                const hit = [y0 - k * step, y0 + k * step].filter((c) => c - h / 2 >= 0 && c + h / 2 <= bottom).find(free);
                if (hit !== undefined) return { x: lx, y: hit };
              }
            }
            return null;
          };
          let got = place(w);
          if (got === null && l.short) {
            text = l.short;
            w = ctx.measureText(text).width + PAD_X * 2;
            got = place(w);
          }
          if (got === null) continue;
          x = got.x;
          y = got.y;
          moved = Math.abs(y - y0) > 1 || x < xRight - 1;
        } else if (y - h / 2 < 0 || y + h / 2 > bottom) {
          // 門檻線在窗格外（含標籤會被切到）就不畫，不貼邊，免得以為門檻就在窗格底部
          continue;
        }
        const top = Math.round(y - h / 2) + 0.5;
        if (moved) {
          // 細線從標籤右緣中點指回線尾原本的位置
          const xEnd = this.lineEndX() ?? mediaSize.width - LEFT;
          ctx.beginPath();
          ctx.moveTo(xEnd, Math.round(y0) + 0.5);
          ctx.lineTo(x + w, Math.round(y) + 0.5);
          ctx.lineWidth = 1;
          ctx.strokeStyle = this.style.border;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.roundRect(x, top, w, h, 3);
        ctx.fillStyle = this.style.background;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.style.border;
        ctx.stroke();
        ctx.fillStyle = this.style.color;
        ctx.fillText(text, x + PAD_X, Math.round(y));
      }
    });
  }
}
