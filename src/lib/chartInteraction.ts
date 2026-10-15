import type { DeepPartial, IChartApi, ChartOptions } from 'lightweight-charts';

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
