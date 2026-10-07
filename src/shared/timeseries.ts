import { addMonths, daysBetween, monthKey, weekKey } from './dates';
import type { IndicatorDef } from './indicators';
import type { Bar } from './types';

export type Point = [date: string, value: number];
export type Period = 'D' | 'W' | 'M';
export type RangeKey = '6M' | '1Y' | '5Y' | 'ALL';

export const MA_PERIODS = [5, 10, 20, 60, 120, 240] as const;
export type MaPeriod = (typeof MA_PERIODS)[number];

/** 簡單移動平均；資料不足處為 null */
export function sma(values: readonly number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (n <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 日 K → 週 K / 月 K。日期採該週期最後一個交易日。輸入需依日期遞增排序。 */
export function resample(bars: readonly Bar[], period: Period): Bar[] {
  if (period === 'D') return bars.slice();
  const keyOf = period === 'W' ? weekKey : monthKey;
  const out: Bar[] = [];
  let curKey: string | null = null;
  let cur: Bar | null = null;
  for (const b of bars) {
    const k = keyOf(b[0]);
    if (k !== curKey || !cur) {
      if (cur) out.push(cur);
      curKey = k;
      cur = [b[0], b[1], b[2], b[3], b[4]];
    } else {
      cur = [b[0], cur[1], Math.max(cur[2], b[2]), Math.min(cur[3], b[3]), b[4]];
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 依時間區間取尾段（以最後一筆日期為基準） */
export function rangeStart(lastDate: string, range: RangeKey): string | null {
  switch (range) {
    case '6M':
      return addMonths(lastDate, -6);
    case '1Y':
      return addMonths(lastDate, -12);
    case '5Y':
      return addMonths(lastDate, -60);
    case 'ALL':
      return null;
  }
}

export function closes(bars: readonly Bar[]): Point[] {
  return bars.map((b) => [b[0], b[4]]);
}

/** 依指標定義轉換顯示數列（年增率、差值等） */
export function transformPoints(def: Pick<IndicatorDef, 'transform'>, pts: readonly Point[]): Point[] {
  switch (def.transform) {
    case 'none':
      return pts.slice();
    case 'yoy': {
      const byMonth = new Map(pts.map(([d, v]) => [monthKey(d), v]));
      const out: Point[] = [];
      for (const [d, v] of pts) {
        const prev = byMonth.get(monthKey(addMonths(`${monthKey(d)}-01`, -12)));
        if (prev !== undefined && prev !== 0) out.push([d, (v / prev - 1) * 100]);
      }
      return out;
    }
    case 'diff': {
      const out: Point[] = [];
      for (let i = 1; i < pts.length; i++) {
        const [d0, v0] = pts[i - 1]!;
        const [d1, v1] = pts[i]!;
        // 只在連續月份間計算差值，避免資料缺漏造成錯誤數字
        if (daysBetween(d0, d1) <= 35) out.push([d1, v1 - v0]);
      }
      return out;
    }
  }
}

export interface ChangeInfo {
  last: Point | null;
  prev: Point | null;
  abs: number | null;
  pct: number | null;
}

/** 最後一筆與前一筆的變化 */
export function lastChange(pts: readonly Point[]): ChangeInfo {
  const last = pts.at(-1) ?? null;
  const prev = pts.length >= 2 ? pts.at(-2)! : null;
  if (!last || !prev) return { last, prev, abs: null, pct: null };
  const abs = last[1] - prev[1];
  const pct = prev[1] !== 0 ? (abs / Math.abs(prev[1])) * 100 : null;
  return { last, prev, abs, pct };
}

/** 與 n 期前比較的變化 */
export function changeOver(
  pts: readonly Point[],
  n: number,
): { abs: number; pct: number | null; from: Point } | null {
  if (pts.length <= n) return null;
  const last = pts.at(-1)!;
  const from = pts.at(-1 - n)!;
  const abs = last[1] - from[1];
  return { abs, pct: from[1] !== 0 ? (abs / Math.abs(from[1])) * 100 : null, from };
}

/** 以日曆天回推，取得 ≤ 目標日期的最後一筆 */
export function valueAtOrBefore(pts: readonly Point[], date: string): Point | null {
  let lo = 0;
  let hi = pts.length - 1;
  let ans: Point | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pts[mid]!;
    if (p[0] <= date) {
      ans = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 依日期合併兩組 K 棒，同日以 incoming 覆蓋；回傳遞增排序結果 */
export function mergeBars(existing: readonly Bar[], incoming: readonly Bar[]): Bar[] {
  const map = new Map<string, Bar>();
  for (const b of existing) map.set(b[0], b);
  for (const b of incoming) map.set(b[0], b);
  return [...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 檢查 K 棒是否為有限數字且 high ≥ low */
export function isValidBar(b: Bar): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(b[0]) &&
    [b[1], b[2], b[3], b[4]].every((v) => Number.isFinite(v)) &&
    b[2] >= b[3]
  );
}
