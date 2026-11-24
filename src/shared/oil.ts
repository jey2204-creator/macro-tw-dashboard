import type { Point } from './timeseries';

/** 依日期找序列索引（當天或之前最後一筆） */
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
/** WTI 讀數：價格、年增（一年前同日或之前最後一筆）、20 個交易日漲跌 */
export function oilReading(pts: readonly Point[], date: string): { date: string; price: number; yoy: number | null; d20: number | null } | null {
  const k = idxAtOrBefore(pts, date);
  if (k < 0) return null;
  const [d, v] = pts[k]!;
  const yearAgo = `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
  const j = idxAtOrBefore(pts, yearAgo);
  const yoy = j >= 0 && pts[0]![0] <= yearAgo ? (v / pts[j]![1] - 1) * 100 : null;
  const d20 = k >= 20 ? (v / pts[k - 20]![1] - 1) * 100 : null;
  return { date: d, price: v, yoy, d20 };
}
