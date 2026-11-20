import type { BreadthStressFile } from '../shared/breadthStress';
import { rangeStart, type RangeKey } from '../shared/timeseries';

export type PctRange = { min: number; max: number };

/** 區間起點（第一根可見 K 棒）與其收盤＝百分比基準 */
export function rangeBase(data: BreadthStressFile, range: RangeKey): { from: number; base: number } {
  const last = data.rows.at(-1);
  const start = last ? rangeStart(last[0], range) : null;
  const from = start ? Math.max(0, data.rows.findIndex((r) => r[0] >= start)) : 0;
  return { from, base: data.rows[from]?.[1] || 1 };
}

/** 畫面內的日期範圍（含兩端） */
export type DateWindow = { from: string; to: string };

/**
 * 兩市累計漲跌幅（基準＝各自區間起點）的高低點聯集。
 * 沒給 win：取區間起點到最新一根；給 win：只取畫面內 [from, to] 的 K 棒——
 * 往左拖曳看更早的資料時 Y 軸跟著畫面內高低點伸縮，折線不會掉出窗格（基準不變、兩市仍同一刻度）。
 */
export function sharedPctRange(list: BreadthStressFile[], range: RangeKey, win?: DateWindow | null, withOhl = false): PctRange | null {
  if (list.length < 2) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const d of list) {
    const { from, base } = rangeBase(d, range);
    const start = win ? lowerBound(d.rows, win.from) : from;
    for (let i = start; i < d.rows.length; i++) {
      const r = d.rows[i]!;
      if (win && r[0] > win.to) break;
      // K 線時連影線一起算，K 棒才不會被窗格切掉
      const k = withOhl ? d.ohl?.[i] : undefined;
      const lo = ((k ? Math.min(k[2], r[1]) : r[1]) / base - 1) * 100;
      const hi = ((k ? Math.max(k[1], r[1]) : r[1]) / base - 1) * 100;
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
  }
  if (min > max) return null;
  // 畫面內幾乎水平時留最小幅度，避免刻度被放到極大
  if (max - min < 1) {
    const mid = (min + max) / 2;
    return { min: mid - 0.5, max: mid + 0.5 };
  }
  return { min, max };
}

/** 第一根日期 ≥ date 的索引（rows 依日期遞增） */
function lowerBound(rows: BreadthStressFile['rows'], date: string): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (rows[m]![0] < date) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** lightweight-charts 的 Time（字串／BusinessDay／秒數）→ YYYY-MM-DD */
export function timeToDate(t: unknown): string | null {
  if (typeof t === 'string') return t.slice(0, 10);
  if (typeof t === 'number') return new Date(t * 1000).toISOString().slice(0, 10);
  if (t && typeof t === 'object' && 'year' in t) {
    const b = t as { year: number; month: number; day: number };
    return `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
  }
  return null;
}

/** 同一個畫面範圍只算一次（兩張圖同步後範圍相同，每次重繪各問一次） */
export function makePctRangeAt(list: BreadthStressFile[], range: RangeKey, withOhl = false): (win: DateWindow | null) => PctRange | null {
  let key: string | null = null;
  let cached: PctRange | null = null;
  return (win) => {
    const k = win ? `${win.from}|${win.to}` : '';
    if (k !== key) {
      key = k;
      cached = sharedPctRange(list, range, win, withOhl);
    }
    return cached;
  };
}

/** 基準日的短寫法：與參照日同一年寫 M/D，跨年寫 YYYY/M/D */
export function baseDateLabel(date: string, ref: string): string {
  const [y, m, d] = date.split('-');
  const md = `${Number(m)}/${Number(d)}`;
  return y === ref.slice(0, 4) ? md : `${y}/${md}`;
}
