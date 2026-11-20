import { useState } from 'react';
import type { RangeKey } from '../shared/timeseries';
import { loadPref, savePref } from './storage';

/** 指數窗格的畫法：折線（預設）或 K 線 */
export type IndexStyle = 'line' | 'candle';
const STYLE_KEYS = ['line', 'candle'] as const;

/** K 線只在 1 年以內的區間畫：手機上 5 年約 1,200 根、每根不到 0.3px，K 棒比折線更難讀 → 自動退回折線 */
export const CANDLE_RANGES: readonly RangeKey[] = ['3M', '6M', '1Y'];

export const candleOn = (style: IndexStyle, range: RangeKey, hasOhl: boolean): boolean => style === 'candle' && hasOhl && CANDLE_RANGES.includes(range);

/** 每個面板各自記住（localStorage key 不同），預設折線 */
export function useIndexStyle(key: string): [IndexStyle, (v: IndexStyle) => void] {
  const [style, setState] = useState<IndexStyle>(() => loadPref(key, STYLE_KEYS, 'line'));
  return [
    style,
    (v) => {
      setState(v);
      savePref(key, v);
    },
  ];
}
