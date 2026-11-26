import { addMonths, daysBetween } from './dates';
import type { Point } from './timeseries';

/**
 * 美國就業（政策利率面板第五格「就業」與讀數列用；參考——計分仍由指標表的非農、失業率兩列負責，這裡不另外判多空）
 * - 非農：FRED PAYEMS 是就業人數水準（千人，季調），日期＝資料月份的 1 號；月增＝相鄰兩月相減，換成「萬人」
 * - 2020-04 單月 −2,050 萬、2020-06 +460 萬會把刻度撐爆 → 圖上 Y 軸限制在 ±JOBS_CLAMP 萬人（超出的月份畫到窗格邊）
 * - 資料月份畫在當月，但實際公布在下個月第一個週五，之後兩個月還會修正
 */

/** 第五格「就業」Y 軸上下限（萬人）：2021～2022 解封期單月 +60～90 萬仍看得到，2020 的極端值截掉 */
export const JOBS_CLAMP = 100;

/** 就業人數水準（千人）→ 月增（萬人）；只在連續月份間計算，缺月不硬算 */
export function payrollChanges(levels: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < levels.length; i++) {
    const [d0, v0] = levels[i - 1]!;
    const [d1, v1] = levels[i]!;
    if (daysBetween(d0, d1) <= 35) out.push([d1, Math.round(v1 - v0) / 10]);
  }
  return out;
}

/** 近 3 筆平均（與指標表非農列的判斷口徑相同） */
export function avg3(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 2; i < pts.length; i++) out.push([pts[i]![0], Math.round(((pts[i]![1] + pts[i - 1]![1] + pts[i - 2]![1]) / 3) * 10) / 10]);
  return out;
}

/** 下個月 1 號（階梯線把最後一個月畫滿用） */
export function nextMonth(date: string): string {
  return addMonths(`${date.slice(0, 7)}-01`, 1);
}

function idxAtOrBefore(pts: readonly Point[], date: string): number {
  let lo = 0;
  let hi = pts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]![0] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface JobsReading {
  /** 非農資料月份（1 號） */
  date: string;
  /** 月增（萬人） */
  change: number;
  /** 近 3 個月平均（萬人）；不足 3 筆為 null */
  avg: number | null;
  /** 失業率（%）與它的資料月份；沒有資料為 null */
  unrate: number | null;
  unrateDate: string | null;
}

/** 某一天當月（或之前最後一個月）的就業讀數 */
export function jobsReading(changes: readonly Point[], unrate: readonly Point[], date: string): JobsReading | null {
  const k = idxAtOrBefore(changes, date);
  if (k < 0) return null;
  const [d, v] = changes[k]!;
  const avg = k >= 2 ? Math.round(((v + changes[k - 1]![1] + changes[k - 2]![1]) / 3) * 10) / 10 : null;
  const u = idxAtOrBefore(unrate, date);
  return { date: d, change: v, avg, unrate: u >= 0 ? unrate[u]![1] : null, unrateDate: u >= 0 ? unrate[u]![0] : null };
}

/** 「2026-10-01」→「10月」 */
export function monthLabel(date: string): string {
  return `${Number(date.slice(5, 7))}月`;
}
