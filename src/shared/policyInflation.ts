import { addDays, monthKey } from './dates';
import { transformPoints, type Point } from './timeseries';
import type { Bar } from './types';

/**
 * 政策利率 vs 通膨（參考面板，不計分）
 * - 上窗格：Fed 目標區間上緣（階梯）、核心 CPI 年增（主線）、整體 CPI 年增（副線）、核心 PCE 年增（可開）
 * - 下窗格：實質政策利率＝Fed 上緣 − 核心 CPI 年增（pp）
 *   < 0 寬鬆（Fed 歷來不會在這裡停止升息）；≥ +1 緊縮（才有降息空間）
 * 只拿來解釋 FOMC 為什麼那樣做，與現有「Fed 120 天」「核心 CPI ±0.2pp」規則重疊，不再計分。
 */

/** 實質利率門檻（pp） */
export const REAL_RATE_TIGHT = 1;
export const FED_TARGET = 2;

export type RealRateState = 'loose' | 'mid' | 'tight';

export function realRateState(realRate: number): RealRateState {
  if (realRate < 0) return 'loose';
  if (realRate >= REAL_RATE_TIGHT) return 'tight';
  return 'mid';
}

export const REAL_RATE_STATE_TEXT: Record<RealRateState, string> = {
  loose: '寬鬆（Fed < 核心CPI）',
  mid: '中間（0～+1pp）',
  tight: '緊縮（≥ +1pp）',
};

/**
 * 拼接 Fed 政策利率：2008-12-16 起 FRED 有目標區間上緣（DFEDTARU），之前只有單一目標利率（DFEDTAR）。
 * 兩者都是日資料；舊序列只取新序列第一天之前的部分。
 */
export function splicePolicyRate(upper: readonly Bar[], legacy: readonly Bar[] = []): Point[] {
  const firstUpper = upper[0]?.[0] ?? '9999-12-31';
  const out: Point[] = legacy.filter((b) => b[0] < firstUpper).map((b) => [b[0], b[4]]);
  for (const b of upper) out.push([b[0], b[4]]);
  return out;
}

/** 年增率數列（FRED 指數 → yoy %） */
export function yoyPoints(bars: readonly Bar[]): Point[] {
  return transformPoints({ transform: 'yoy' }, bars.map((b) => [b[0], b[4]]));
}

/** ≤ date 的最後一個值（pts 遞增） */
export function valueAtOrBefore(pts: readonly Point[], date: string): number | null {
  let lo = 0;
  let hi = pts.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]![0] <= date) {
      ans = pts[mid]![1];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 該月最後一天 */
export function monthEnd(date: string): string {
  const [y, m] = monthKey(date).split('-').map(Number) as [number, number];
  const nextFirst = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  return addDays(nextFirst, -1);
}

export type RealRateRow = [date: string, fed: number, inflation: number, real: number];

/**
 * 實質政策利率：每個通膨月份 d（FRED 以月初日期標示）取「該月月底時的 Fed 利率」減該月年增率。
 * 通膨資料開始前的 Fed 月份略過；Fed 尚未有資料的月份略過。
 */
export function realRateSeries(fed: readonly Point[], inflation: readonly Point[]): RealRateRow[] {
  const out: RealRateRow[] = [];
  for (const [d, yoy] of inflation) {
    const f = valueAtOrBefore(fed, monthEnd(d));
    if (f === null) continue;
    out.push([d, f, yoy, f - yoy]);
  }
  return out;
}

export interface PolicyInflationSummary {
  fedDate: string;
  fed: number;
  inflationDate: string;
  inflation: number;
  /** 以最新 Fed 與最新通膨年增算出的實質利率（pp） */
  real: number;
  state: RealRateState;
  /** 核心通膨距 Fed 2% 目標（pp，正＝高於目標） */
  gapToTarget: number;
}

/** 目前讀數：最新 Fed 利率對最新通膨年增（兩者日期可能不同月） */
export function summarize(fed: readonly Point[], inflation: readonly Point[]): PolicyInflationSummary | null {
  const f = fed.at(-1);
  const i = inflation.at(-1);
  if (!f || !i) return null;
  const real = f[1] - i[1];
  return { fedDate: f[0], fed: f[1], inflationDate: i[0], inflation: i[1], real, state: realRateState(real), gapToTarget: i[1] - FED_TARGET };
}

/** 本波：實質利率最近一次由負轉正（或由正轉負）的月份 */
export function lastSignFlip(rows: readonly RealRateRow[]): { date: string; to: 'positive' | 'negative' } | null {
  for (let k = rows.length - 1; k >= 1; k--) {
    const prev = rows[k - 1]![3];
    const cur = rows[k]![3];
    if (prev < 0 && cur >= 0) return { date: rows[k]![0], to: 'positive' };
    if (prev >= 0 && cur < 0) return { date: rows[k]![0], to: 'negative' };
  }
  return null;
}
