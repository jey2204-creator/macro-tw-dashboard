import { addDays, monthKey } from './dates';
import { zoneAt, type Zone } from './indicators';
import type { Point } from './timeseries';
import { valueAtOrBefore } from './timeseries';
import { perShareSeries, ratioStats, valuationBacktest, type RatioStats, type ValBacktest } from './twValuation';
import { bandPosition, median, type BandPosition } from './usValuation';

/**
 * 韓股估值（參考面板，不計分）
 * 資料：KRX 月底值（韓國銀行 ECOS 轉載的本益比、殖利率；KOSIS 轉載的淨值比；2004-01 起）、KOSPI 日收盤（Yahoo ^KS11）、
 * 韓國 10 年期公債（ECOS 月均）、MSCI 韓國 factsheet（預估本益比、近 12 月本益比、淨值比；每月一點）。
 * - 主角是淨值比：KOSPI 由三星、SK 海力士等循環股主導，本益比在獲利高峰時最低、谷底時飆高（單看會給反向訊號）；
 *   韓國在地「PBR 1 倍」是著名的底部參考。河流圖畫 KOSPI vs 每股淨值（指數點）× 0.7／0.9／1.1／1.3／1.6／2.0 倍
 * - 每股淨值（指數點）＝當月最後一個交易日收盤 ÷ 當月淨值比；之後每天的淨值比＝收盤 ÷ 最近一期每股淨值（與台股面板同法）；EPS 同理
 * - KRX 本益比用「最近一期年度（含半年報）實績純益」，年報（4 月）、半年報（9 月）併入時整批換分母，不是估值變了；
 *   面板把單月 EPS 變動超過 EPS_JUMP_PCT 的月份標成「換財報」
 * - 百分位、中位數以 2004 年起為基期（資料起點）
 */

/** 淨值比河流圖倍數線＝指標表 kr_pb 的區間邊界再加兩端 */
export const KR_PB_MULTIPLES = [0.7, 0.9, 1.1, 1.3, 1.6, 2.0] as const;
export const KR_BASE_START = '2004-01-01';
/** 本益比窗格 Y 軸固定範圍（倍）：2010、2021、2026 年獲利低基期時 24～32 倍會把常態帶壓扁 */
export const KR_PE_AXIS = [5, 35] as const;
/** 單月每股純益（指數點）變動超過此比例 → 視為年報／半年報併入 */
export const EPS_JUMP_PCT = 8;
/** 韓債 10Y 月資料最多落後幾天仍採用 */
const Y10_MAX_LAG_DAYS = 100;
const AVG_MONTHS = 60;

export interface KrRow {
  date: string;
  price: number;
  /** 每股淨值（指數點）＝月底收盤 ÷ 當月淨值比 */
  bv: number;
  pb: number;
  /** 每股純益（指數點）＝月底收盤 ÷ 當月本益比 */
  eps: number | null;
  pe: number | null;
  /** 盈餘殖利率 − 韓債 10Y（pp） */
  spread: number | null;
}

/** 韓債 10Y（月均，YYYY-MM-01）：取月份早於 date 所在月的最近一筆 */
export function kr10yBefore(kr10y: readonly Point[], date: string): Point | null {
  const firstOfMonth = `${monthKey(date)}-01`;
  const p = valueAtOrBefore(kr10y, addDays(firstOfMonth, -1));
  if (!p) return null;
  return Date.parse(date) - Date.parse(p[0]) <= Y10_MAX_LAG_DAYS * 86_400_000 ? p : null;
}

/** 每個交易日一列：淨值／EPS 取 ≤ 該日最近一期（月底）；第一期淨值之前的日子略過 */
export function krRiverRows(kospi: readonly Point[], bv: readonly Point[], eps: readonly Point[], kr10y: readonly Point[]): KrRow[] {
  const out: KrRow[] = [];
  if (bv.length === 0) return out;
  let j = 0;
  let k = 0;
  for (const [date, price] of kospi) {
    if (!(price > 0) || date < bv[0]![0]) continue;
    while (j + 1 < bv.length && bv[j + 1]![0] <= date) j++;
    while (k + 1 < eps.length && eps[k + 1]![0] <= date) k++;
    const b = bv[j]![1];
    if (!(b > 0)) continue;
    const e = eps[k] && eps[k]![0] <= date && eps[k]![1] > 0 ? eps[k]![1] : null;
    const y = kr10yBefore(kr10y, date);
    out.push({
      date,
      price,
      bv: b,
      pb: price / b,
      eps: e,
      pe: e ? price / e : null,
      spread: e && y ? (e / price) * 100 - y[1] : null,
    });
  }
  return out;
}

export function krRowAtOrBefore(rows: readonly KrRow[], date: string): KrRow | null {
  let lo = 0;
  let hi = rows.length - 1;
  let ans: KrRow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.date <= date) {
      ans = rows[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface EpsJump {
  /** 月底日期（每股純益序列的日期） */
  date: string;
  pct: number;
}

/** 每股純益（月底值）單月變動超過門檻的月份＝年報／半年報併入 */
export function epsJumps(eps: readonly Point[], thresholdPct = EPS_JUMP_PCT): EpsJump[] {
  const out: EpsJump[] = [];
  for (let i = 1; i < eps.length; i++) {
    const prev = eps[i - 1]![1];
    if (!(prev > 0)) continue;
    const pct = (eps[i]![1] / prev - 1) * 100;
    if (Math.abs(pct) >= thresholdPct) out.push({ date: eps[i]![0], pct });
  }
  return out;
}

/** MSCI 韓國 factsheet 月底值（三個序列日期相同） */
export interface KrMsciSummary {
  asOf: string;
  fwdPe: number;
  pe: number | null;
  pbv: number | null;
  /** 近 12 月 ÷ 預估 − 1：市場押注的未來 12 月 EPS 成長（%） */
  impliedGrowth: number | null;
  /** 預估本益比與上一期比（倍） */
  prevAsOf: string | null;
  prevFwdPe: number | null;
  n: number;
  min: Point;
  max: Point;
  median: number;
  /** 超過 2 個月未更新 */
  stale: boolean;
}

export function krMsciSummary(fwd: readonly Point[], pe: readonly Point[], pbv: readonly Point[], today: string): KrMsciSummary | null {
  const last = fwd.at(-1);
  if (!last) return null;
  const peAt = valueAtOrBefore(pe, last[0]);
  const pbAt = valueAtOrBefore(pbv, last[0]);
  const peV = peAt && peAt[0] === last[0] ? peAt[1] : null;
  const pbV = pbAt && pbAt[0] === last[0] ? pbAt[1] : null;
  const prev = fwd.length >= 2 ? fwd[fwd.length - 2]! : null;
  const vals = fwd.map((p) => p[1]);
  let min = fwd[0]!;
  let max = fwd[0]!;
  for (const p of fwd) {
    if (p[1] < min[1]) min = p;
    if (p[1] > max[1]) max = p;
  }
  return {
    asOf: last[0],
    fwdPe: last[1],
    pe: peV,
    pbv: pbV,
    impliedGrowth: peV && last[1] > 0 ? (peV / last[1] - 1) * 100 : null,
    prevAsOf: prev ? prev[0] : null,
    prevFwdPe: prev ? prev[1] : null,
    n: fwd.length,
    min,
    max,
    median: median(vals) ?? last[1],
    stale: Date.parse(today) - Date.parse(last[0]) > 70 * 86_400_000,
  };
}

export interface KrValuationSummary {
  date: string;
  price: number;
  /** 最新一期月底資料的月份（YYYY-MM） */
  dataMonth: string;
  bv: number;
  /** 每股淨值與一年前相比（%） */
  bvYoy: number | null;
  pb: number;
  pbZone: string | null;
  pbStats: RatioStats | null;
  /** 近 5 年月底淨值比平均 */
  pbAvg5: number | null;
  /** 回到近 5 年均：淨值需再成長／指數需跌（%） */
  needGrowth: number | null;
  needDrop: number | null;
  position: BandPosition;
  eps: number | null;
  epsYoy: number | null;
  pe: number | null;
  peZone: string | null;
  peStats: RatioStats | null;
  /** 最近一次年報／半年報併入 */
  lastJump: EpsJump | null;
  dy: number | null;
  earningsYield: number | null;
  y10: number | null;
  y10Month: string | null;
  spread: number | null;
  /** 盈餘殖利率 − 美債 10Y（pp） */
  usSpread: number | null;
}

export function summarizeKr(
  rows: readonly KrRow[],
  pbMonthly: readonly Point[],
  peMonthly: readonly Point[],
  dyMonthly: readonly Point[],
  bv: readonly Point[],
  eps: readonly Point[],
  kr10y: readonly Point[],
  us10y: readonly Point[],
  pbZones: readonly Zone[] | undefined,
  peZones: readonly Zone[] | undefined,
): KrValuationSummary | null {
  const last = rows.at(-1);
  if (!last) return null;
  const recent = pbMonthly.slice(-AVG_MONTHS).map((p) => p[1]);
  const pbAvg5 = recent.length >= AVG_MONTHS ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  const yoy = (series: readonly Point[]) => {
    const cur = series.at(-1);
    const ago = cur ? valueAtOrBefore(series, addDays(cur[0], -360)) : null;
    return cur && ago && ago[1] > 0 && Date.parse(cur[0]) - Date.parse(ago[0]) >= 300 * 86_400_000 ? (cur[1] / ago[1] - 1) * 100 : null;
  };
  const y = kr10yBefore(kr10y, last.date);
  const us = valueAtOrBefore(us10y, last.date);
  const usFresh = us && Date.parse(last.date) - Date.parse(us[0]) <= 10 * 86_400_000 ? us : null;
  const earningsYield = last.eps ? (last.eps / last.price) * 100 : null;
  const dyLast = dyMonthly.at(-1);
  const jumps = epsJumps(eps);
  return {
    date: last.date,
    price: last.price,
    dataMonth: monthKey(pbMonthly.at(-1)?.[0] ?? bv.at(-1)![0]),
    bv: last.bv,
    bvYoy: yoy(bv),
    pb: last.pb,
    pbZone: zoneAt(pbZones, last.pb)?.label ?? null,
    pbStats: ratioStats(pbMonthly, last.pb, KR_BASE_START),
    pbAvg5,
    needGrowth: pbAvg5 ? (last.pb / pbAvg5 - 1) * 100 : null,
    needDrop: pbAvg5 ? (pbAvg5 / last.pb - 1) * 100 : null,
    position: bandPosition(last.price, last.bv, KR_PB_MULTIPLES),
    eps: last.eps,
    epsYoy: yoy(eps),
    pe: last.pe,
    peZone: last.pe === null ? null : (zoneAt(peZones, last.pe)?.label ?? null),
    peStats: last.pe === null ? null : ratioStats(peMonthly, last.pe, KR_BASE_START),
    lastJump: jumps.at(-1) ?? null,
    dy: dyLast && Date.parse(last.date) - Date.parse(dyLast[0]) <= 75 * 86_400_000 ? dyLast[1] : null,
    earningsYield,
    y10: y ? y[1] : null,
    y10Month: y ? monthKey(y[0]) : null,
    spread: last.spread,
    usSpread: earningsYield !== null && usFresh ? earningsYield - usFresh[1] : null,
  };
}

// ── 回測：估值區間 vs 之後 KOSPI 報酬（月底值；KRX 月底值約下月初公布 → 延遲 5 天） ──

export const KR_PE_BUCKETS: readonly [number, number, string][] = [
  [0, 9, '<9'],
  [9, 12, '9–12'],
  [12, 15, '12–15'],
  [15, 18, '15–18'],
  [18, Infinity, '≥18'],
];
export const KR_PB_BUCKETS: readonly [number, number, string][] = [
  [0, 0.9, '<0.9'],
  [0.9, 1.1, '0.9–1.1'],
  [1.1, 1.3, '1.1–1.3'],
  [1.3, 1.6, '1.3–1.6'],
  [1.6, Infinity, '≥1.6'],
];
/** 股債利差（pp）＝盈餘殖利率 − 韓債 10Y（2004–2011 韓債 4～6%，之後 1.5～4%） */
export const KR_SPREAD_BUCKETS: readonly [number, number, string][] = [
  [-Infinity, 3, '<3'],
  [3, 6, '3–6'],
  [6, Infinity, '≥6'],
];
/** 前後段分界：與台股、日股相同（2013 起） */
export const KR_BACKTEST_SPLIT = '2013-01';
const PUBLISH_LAG_DAYS = 5;

export function krValuationBacktest(peM: readonly Point[], pbM: readonly Point[], kospi: readonly Point[], kr10y: readonly Point[]): ValBacktest | null {
  return valuationBacktest(peM, pbM, kospi, kr10y, {
    pe: KR_PE_BUCKETS,
    pb: KR_PB_BUCKETS,
    spread: KR_SPREAD_BUCKETS,
    split: KR_BACKTEST_SPLIT,
    lagDays: PUBLISH_LAG_DAYS,
  });
}

export { perShareSeries };
export { spreadText } from './usValuation';
