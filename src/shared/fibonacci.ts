import type { Bar } from './types';

/**
 * 費波那契回撤（參考、不計分）：取時間區間內的最高價與最低價當波段起訖，
 * 高點在低點之後＝多頭回撤（由高點往下畫支撐），反之＝空頭反彈（由低點往上畫壓力）。
 */
export const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786] as const;
export type FibRatio = (typeof FIB_RATIOS)[number];
/** 高低點至少相隔幾根 K 棒才算一段波段（避免區間剛好切在波段中途、畫出沒意義的線） */
export const FIB_MIN_GAP = 20;

export type FibLevel = { ratio: FibRatio; price: number };
export type Fib = {
  /** up＝多頭回撤（高點在後）、down＝空頭反彈（低點在後） */
  direction: 'up' | 'down';
  hi: number;
  hiDate: string;
  lo: number;
  loDate: string;
  levels: FibLevel[];
  /** 最新收盤已回撤（或反彈）波段的比例，0＝還在極值、1＝整段吐回 */
  current: number;
  /** 最新收盤落在哪兩條線之間（null＝超出 0 或 1） */
  between: [number, number] | null;
};

/** 在 [startDate, ∞) 的 K 棒內找波段高低點；bars 需依日期遞增 */
export function fibRetracement(bars: readonly Bar[], startDate: string | null, minGap = FIB_MIN_GAP): Fib | null {
  let from = 0;
  if (startDate) {
    while (from < bars.length && bars[from]![0] < startDate) from++;
  }
  const seg = bars.slice(from);
  if (seg.length < 2) return null;
  let hiI = 0;
  let loI = 0;
  seg.forEach((b, i) => {
    if (b[2] > seg[hiI]![2]) hiI = i;
    if (b[3] < seg[loI]![3]) loI = i;
  });
  if (Math.abs(hiI - loI) < minGap) return null;
  const hi = seg[hiI]![2];
  const lo = seg[loI]![3];
  const span = hi - lo;
  if (!(span > 0)) return null;
  const direction = hiI > loI ? 'up' : 'down';
  const levels = FIB_RATIOS.map((ratio) => ({ ratio, price: direction === 'up' ? hi - span * ratio : lo + span * ratio }));
  const close = seg.at(-1)![4];
  const current = direction === 'up' ? (hi - close) / span : (close - lo) / span;
  let between: [number, number] | null = null;
  if (current >= 0 && current <= 1) {
    const grid = [0, ...FIB_RATIOS, 1];
    for (let i = 0; i + 1 < grid.length; i++) {
      if (current >= grid[i]! && current <= grid[i + 1]!) {
        between = [grid[i]!, grid[i + 1]!];
        break;
      }
    }
  }
  return { direction, hi, hiDate: seg[hiI]![0], lo, loDate: seg[loI]![0], levels, current, between };
}

export const FIB_DIRECTION_TEXT = { up: '多頭回撤', down: '空頭反彈' } as const;

/** fibRetracement 回 null 時的說明：區分「極值就是最新一根（還在創新高／新低）」與單純相隔太近 */
export function fibSkipText(bars: readonly Bar[], startDate: string | null, rangeLabel: string, minGap = FIB_MIN_GAP): string {
  let from = 0;
  if (startDate) {
    while (from < bars.length && bars[from]![0] < startDate) from++;
  }
  const seg = bars.slice(from);
  if (seg.length < 2) return '資料不足，不畫';
  let hiI = 0;
  let loI = 0;
  seg.forEach((b, i) => {
    if (b[2] > seg[hiI]![2]) hiI = i;
    if (b[3] < seg[loI]![3]) loI = i;
  });
  const last = seg.length - 1;
  if (loI === last && hiI !== last) return `最低點就是最新一根（創${rangeLabel}新低），下方沒有費波支撐，不畫`;
  if (hiI === last && loI !== last) return `最高點就是最新一根（創${rangeLabel}新高），上方沒有費波壓力，不畫`;
  return `高低點相隔不到 ${minGap} 根 K 棒，不畫`;
}
