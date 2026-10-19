import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { Zone } from '../shared/indicators';

/**
 * 景氣燈號的背景色帶：每個分區（9–16 藍燈…38–45 紅燈）畫一條水平色帶，畫在格線之下。
 * 以 lightweight-charts 的 series primitive 實作（zOrder 'bottom'），不另外加序列，
 * 所以不影響十字線讀值與價格軸自動縮放。
 */

export interface Band {
  /** 下緣（含），-Infinity＝到底 */
  from: number;
  /** 上緣（不含），Infinity＝到頂 */
  to: number;
  /** 已解析的填色（rgba） */
  color: string;
}

/** 分區（由低到高，取第一個 v < max）→ 色帶 [前一區上限, 本區上限)；沒有顏色的分區不畫 */
export function bandsFromZones(zones: readonly Zone[], fill: (cssVar: string) => string): Band[] {
  const out: Band[] = [];
  let from = -Infinity;
  for (const z of zones) {
    if (z.color) out.push({ from, to: z.max, color: fill(z.color) });
    from = z.max;
  }
  return out;
}

/** #rrggbb → rgba(r,g,b,a)；非 6 位十六進位就原樣回傳 */
export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => parseInt(x, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export class ZoneBands implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private readonly bands: readonly Band[]) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.drawBands(target) };
    this.views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
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

  private drawBands(target: DrawTarget): void {
    const s = this.series;
    if (!s) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, verticalPixelRatio: vr }) => {
      const height = bitmapSize.height / vr;
      for (const b of this.bands) {
        const yTop = Number.isFinite(b.to) ? s.priceToCoordinate(b.to) : 0;
        const yBottom = Number.isFinite(b.from) ? s.priceToCoordinate(b.from) : height;
        if (yTop === null || yBottom === null) continue;
        const top = Math.max(0, Math.round(Math.min(yTop, yBottom) * vr));
        const bottom = Math.min(bitmapSize.height, Math.round(Math.max(yTop, yBottom) * vr));
        if (bottom <= top) continue;
        context.fillStyle = b.color;
        context.fillRect(0, top, bitmapSize.width, bottom - top);
      }
    });
  }
}
