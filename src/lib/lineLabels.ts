import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
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
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

const PAD_X = 4;
const PAD_Y = 2;
const LEFT = 6;

export class LineLabels implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(
    private readonly labels: readonly LineLabel[],
    private readonly style: LineLabelStyle,
  ) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.drawLabels(target) };
    this.views = [{ zOrder: () => 'top', renderer: () => renderer }];
  }

  attached({ series }: SeriesAttachedParameter<Time>): void {
    this.series = series;
  }

  detached(): void {
    this.series = null;
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
        const y = s.priceToCoordinate(l.price);
        // 線在窗格外（含標籤會被切到）就不畫
        const bottom = mediaSize.height * (this.style.maxYFrac ?? 1);
        if (y === null || y - h / 2 < 0 || y + h / 2 > bottom) continue;
        const w = ctx.measureText(l.text).width + PAD_X * 2;
        const x = LEFT;
        const top = Math.round(y - h / 2) + 0.5;
        ctx.beginPath();
        ctx.roundRect(x, top, w, h, 3);
        ctx.fillStyle = this.style.background;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.style.border;
        ctx.stroke();
        ctx.fillStyle = this.style.color;
        ctx.fillText(l.text, x + PAD_X, Math.round(y));
      }
    });
  }
}
