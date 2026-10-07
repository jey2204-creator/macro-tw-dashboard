import type { IndicatorDef } from '../shared/indicators';
import { closes, resample, transformPoints, type MaPeriod, type Period } from '../shared/timeseries';
import type { Bar } from '../shared/types';

export type ChartKind = 'candle' | 'line' | 'histogram';

/** MA 顏色：依 MA 週期固定（顏色跟著實體走，不隨開關改變）；已用 dataviz 驗證器檢查 */
export const MA_COLOR_VAR: Record<MaPeriod, string> = {
  5: '--ma5',
  10: '--ma10',
  20: '--ma20',
  60: '--ma60',
  120: '--ma120',
  240: '--ma240',
};

/** 將資料檔轉成圖表用 K 棒：總經指標套用轉換（年增率、差值）並以線/柱狀呈現 */
export function chartBars(def: IndicatorDef, data: Bar[], closeOnly: boolean, period: Period): { bars: Bar[]; kind: ChartKind } {
  if (!def.market) {
    const pts = transformPoints(def, closes(data));
    return { bars: pts.map(([d, v]) => [d, v, v, v, v]), kind: def.transform === 'diff' ? 'histogram' : 'line' };
  }
  return { bars: resample(data, period), kind: closeOnly ? 'line' : 'candle' };
}

