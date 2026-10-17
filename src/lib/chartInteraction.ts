import type { DeepPartial, IChartApi, ChartOptions, Time } from 'lightweight-charts';

/**
 * 手機友善的圖表互動設定（所有圖表共用）
 * - 上下滑：交給網頁捲動，不被圖表攔住（vertTouchDrag: false）
 * - Y 軸：不能拖曳縮放，避免滑動時誤觸改變比例；永遠自動縮放
 * - 窗格分隔線：不能拖曳調整高度（手機上下滑時手指劃過分隔線會把三個窗格高度拉歪）
 * - 時間軸：左右滑、兩指縮放、拖曳時間軸照常
 * - 桌機滾輪：留給網頁捲動
 */
export const CHART_INTERACTION: DeepPartial<ChartOptions> = {
  handleScroll: {
    mouseWheel: false,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: false,
  },
  handleScale: {
    axisPressedMouseMove: { time: true, price: false },
    axisDoubleClickReset: { time: true, price: true },
    mouseWheel: false,
    pinch: true,
  },
  rightPriceScale: { autoScale: true },
  layout: {
    panes: { enableResize: false, separatorHoverColor: 'rgba(0, 0, 0, 0)' },
  },
};

/**
 * 時間軸刻度共用設定
 * - `TIME_AXIS`：各面板 `createChart` 的 `timeScale` 展開引用。tickMarkMaxCharacterLength 5：圖表庫用它估每個
 *   標籤的寬度決定刻度疏密，預設按「2024/01/01」8 個字算，實際年標籤「2024年」只有 5 個字，估太寬會把
 *   5年／10年區間的奇數年省略；設準後放得下就每年顯示（手機 10年約每 2 年一個）
 * - `attachTimeAxis(chart)`：建圖後呼叫一次。tickMarkFormatter 只決定要不要印（文字仍由庫預設格式產生）：
 *   1. 可視範圍超過 2.5 年只印年、超過 4 個月不印日，避免右緣冒出單獨一個「5日」「8月」
 *   2. 刻度離左緣不到半個標籤寬時不印，避免「022年」被切一半（庫只對整段資料的第一根做對齊，
 *      選 5年等區間時左緣不是資料起點，庫認為你可以往左滑所以照切）
 *   圖表庫會把格式化結果依刻度時間快取，換區間後不會重算 → 訂閱可視範圍變動時用 `applyOptions({})` 清快取
 * （不用 uniformDistribution：它是同層級全有或全無，1年會失去月份、10年連年份都不印）
 */
export const TIME_AXIS = { tickMarkMaxCharacterLength: 5 } as const;

/** 左緣內這個距離（px）的刻度不印文字；年標籤約 44px 寬，取一半 */
export const EDGE_LABEL_PX = 21;

const DAY_MS = 86_400_000;

/** 依可視天數決定最細印到哪一層：Year=0、Month=1、DayOfMonth=2、Time=3 */
export function finestTickType(spanDays: number): number {
  if (spanDays > 365 * 2.5) return 0;
  if (spanDays > 120) return 1;
  return 3;
}

function toMs(t: Time): number | null {
  if (typeof t === 'string') return Date.parse(t);
  if (typeof t === 'number') return t * 1000;
  if (t && typeof t === 'object' && 'year' in t) return Date.UTC(t.year, t.month - 1, t.day);
  return null;
}

export function attachTimeAxis(chart: IChartApi): void {
  const ts = chart.timeScale();
  const tickMarkFormatter = (time: Time, type: number) => {
      const vr = ts.getVisibleRange();
      if (vr) {
        const a = toMs(vr.from);
        const b = toMs(vr.to);
        if (a !== null && b !== null && type > finestTickType((b - a) / DAY_MS)) return '';
      }
      const x = ts.timeToCoordinate(time);
      return x !== null && x < EDGE_LABEL_PX ? '' : null;
    };
  chart.applyOptions({ timeScale: { tickMarkFormatter } });
  // 可視範圍一變就清掉格式化快取，讓上面的判斷用新範圍重算（timeScale 的 applyOptions 一律清快取）
  ts.subscribeVisibleLogicalRangeChange(() => ts.applyOptions({}));
}

/** 三層監測面板的窗格高度比例（加權指數／中層指標／底層增減） */
export const PANE_STRETCH = [0.45, 0.33, 0.22] as const;

/** 把每個窗格的右側價格軸恢復自動縮放 */
export function resetPriceScales(chart: IChartApi): void {
  const n = chart.panes().length;
  for (let i = 0; i < n; i++) chart.priceScale('right', i).applyOptions({ autoScale: true });
}

/** 把窗格高度比例設回預設（多窗格圖用；重設按鈕與切換區間時一併呼叫） */
export function resetPaneStretch(chart: IChartApi, stretch: readonly number[] = PANE_STRETCH): void {
  const panes = chart.panes();
  panes.forEach((p, i) => {
    const f = stretch[i];
    if (f !== undefined) p.setStretchFactor(f);
  });
}
