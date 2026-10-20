import { addDays, addMonths, monthKey } from './dates';
import { zoneAt, type Zone } from './indicators';
import type { Point } from './timeseries';
import { bandPosition, median, percentile, type BandPosition } from './usValuation';

/**
 * 台股估值（參考面板，不計分）
 * 資料：證交所「證券市場統計概要」月報的大盤本益比、股價淨值比、殖利率（1999 年起，月底值）；加權指數日收盤；
 * 央行「資本市場利率」的十年期公債次級市場利率（月）。
 * - 每股（以指數點計）EPS＝當月最後一個交易日收盤 ÷ 當月本益比；淨值同理。之後每天的本益比＝收盤 ÷ 最近一期 EPS
 *   （財報季中途個別公司申報不會反映，與證交所每日值可能差 1% 以內）
 * - 河流圖倍數線與美股相同（15／19／23／27／31），再加 11 倍：台股獲利循環大，2009、2022 年谷底都在 9～10 倍
 * - 百分位、中位數以 2005 年起為基期：證交所自 2005 年起總市值改以發行股數計算，前後口徑不同
 */

export const TW_RIVER_MULTIPLES = [11, 15, 19, 23, 27, 31] as const;
export const TW_BASE_START = '2005-01-01';
/** 「近 5 年平均」用的月數 */
export const AVG_MONTHS = 60;
/** 台債 10Y 月資料最多落後幾天仍採用（央行約晚 1.5 個月公布） */
const Y10_MAX_LAG_DAYS = 100;

/** 每月比率（YYYY-MM-01）→ 該月最後一個交易日的「每股」值（收盤 ÷ 比率）；daily 依日期遞增 */
export function perShareSeries(ratio: readonly Point[], daily: readonly Point[]): Point[] {
  const out: Point[] = [];
  let j = 0;
  for (const [m, r] of ratio) {
    if (!(r > 0)) continue;
    const key = monthKey(m);
    while (j < daily.length && monthKey(daily[j]![0]) < key) j++;
    let k = j;
    let last: Point | null = null;
    while (k < daily.length && monthKey(daily[k]![0]) === key) last = daily[k++]!;
    if (last) out.push([last[0], last[1] / r]);
  }
  return out;
}

export interface TwRow {
  date: string;
  price: number;
  eps: number;
  pe: number;
  bv: number | null;
  pb: number | null;
  /** 盈餘殖利率 − 台債 10Y（pp） */
  spread: number | null;
}

/** 最近一筆 ≤ date 的值（pts 依日期遞增） */
function valueOnOrBefore(pts: readonly Point[], date: string): Point | null {
  let lo = 0;
  let hi = pts.length - 1;
  let ans: Point | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]![0] <= date) {
      ans = pts[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 台債 10Y（月均，YYYY-MM-01）：取月份早於 date 所在月的最近一筆（當月平均要月底後才有） */
export function y10Before(tw10y: readonly Point[], date: string): Point | null {
  const firstOfMonth = `${monthKey(date)}-01`;
  const p = valueOnOrBefore(tw10y, addDays(firstOfMonth, -1));
  if (!p) return null;
  return Date.parse(date) - Date.parse(p[0]) <= Y10_MAX_LAG_DAYS * 86_400_000 ? p : null;
}

/** 每個交易日一列：EPS／淨值取 ≤ 該日最近一期（月底）；第一期 EPS 之前的日子略過 */
export function twRiverRows(taiex: readonly Point[], eps: readonly Point[], bv: readonly Point[], tw10y: readonly Point[]): TwRow[] {
  const out: TwRow[] = [];
  if (eps.length === 0) return out;
  let j = 0;
  let k = 0;
  for (const [date, price] of taiex) {
    if (!(price > 0) || date < eps[0]![0]) continue;
    while (j + 1 < eps.length && eps[j + 1]![0] <= date) j++;
    while (k + 1 < bv.length && bv[k + 1]![0] <= date) k++;
    const e = eps[j]![1];
    if (!(e > 0)) continue;
    const b = bv[k] && bv[k]![0] <= date ? bv[k]![1] : null;
    const y = y10Before(tw10y, date);
    out.push({
      date,
      price,
      eps: e,
      pe: price / e,
      bv: b,
      pb: b ? price / b : null,
      spread: y ? (e / price) * 100 - y[1] : null,
    });
  }
  return out;
}

export function twRowAtOrBefore(rows: readonly TwRow[], date: string): TwRow | null {
  let lo = 0;
  let hi = rows.length - 1;
  let ans: TwRow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.date <= date) {
      ans = rows[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface RatioStats {
  n: number;
  median: number;
  /** 最新值在基期月資料中的百分位（0–100） */
  pct: number;
}

export function ratioStats(monthly: readonly Point[], latest: number, since = TW_BASE_START): RatioStats | null {
  const vals = monthly.filter((p) => p[0] >= since).map((p) => p[1]);
  const med = median(vals);
  const pct = percentile(vals, latest);
  if (med === null || pct === null) return null;
  return { n: vals.length, median: med, pct };
}

export interface TwValuationSummary {
  date: string;
  price: number;
  eps: number;
  /** 最近一期月報的月份（YYYY-MM） */
  epsMonth: string;
  /** 近四季 EPS 與 12 個月前那期相比（%） */
  epsYoy: number | null;
  pe: number;
  zone: string | null;
  peStats: RatioStats | null;
  /** 近 5 年（60 個月）月底本益比平均 */
  avg5: number | null;
  /** 指數不動、本益比回到 5 年平均，EPS 需要再成長多少（%） */
  needGrowth: number | null;
  /** EPS 不動、本益比回到 5 年平均，指數要跌多少（%，負值） */
  needDrop: number | null;
  position: BandPosition;
  pb: number | null;
  pbZone: string | null;
  pbStats: RatioStats | null;
  /** 最近一期大盤殖利率（%） */
  dy: number | null;
  earningsYield: number;
  y10: number | null;
  y10Month: string | null;
  spread: number | null;
  /** 盈餘殖利率 − 美債 10Y（外資的比較基準，pp） */
  usSpread: number | null;
}

export function summarizeTw(
  rows: readonly TwRow[],
  peMonthly: readonly Point[],
  pbMonthly: readonly Point[],
  dyMonthly: readonly Point[],
  eps: readonly Point[],
  tw10y: readonly Point[],
  us10y: readonly Point[],
  peZones: readonly Zone[] | undefined,
  pbZones: readonly Zone[] | undefined,
): TwValuationSummary | null {
  const last = rows.at(-1);
  const peLast = peMonthly.at(-1);
  if (!last || !peLast) return null;
  const recent = peMonthly.slice(-AVG_MONTHS).map((p) => p[1]);
  const avg5 = recent.length >= AVG_MONTHS ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  const epsLast = eps.at(-1);
  const epsPrev = epsLast ? eps.find((p) => monthKey(p[0]) === monthKey(addMonths(`${monthKey(epsLast[0])}-01`, -12))) : undefined;
  const earningsYield = (last.eps / last.price) * 100;
  const y = y10Before(tw10y, last.date);
  const us = valueOnOrBefore(us10y, last.date);
  const usFresh = us && Date.parse(last.date) - Date.parse(us[0]) <= 10 * 86_400_000 ? us : null;
  return {
    date: last.date,
    price: last.price,
    eps: last.eps,
    epsMonth: monthKey(peLast[0]),
    epsYoy: epsLast && epsPrev && epsPrev[1] > 0 ? (epsLast[1] / epsPrev[1] - 1) * 100 : null,
    pe: last.pe,
    zone: zoneAt(peZones, last.pe)?.label ?? null,
    peStats: ratioStats(peMonthly, last.pe),
    avg5,
    needGrowth: avg5 ? (last.pe / avg5 - 1) * 100 : null,
    needDrop: avg5 ? (avg5 / last.pe - 1) * 100 : null,
    position: bandPosition(last.price, last.eps, TW_RIVER_MULTIPLES),
    pb: last.pb,
    pbZone: last.pb === null ? null : (zoneAt(pbZones, last.pb)?.label ?? null),
    pbStats: last.pb === null ? null : ratioStats(pbMonthly, last.pb),
    dy: dyMonthly.at(-1)?.[1] ?? null,
    earningsYield,
    y10: y ? y[1] : null,
    y10Month: y ? monthKey(y[0]) : null,
    spread: last.spread,
    usSpread: usFresh ? earningsYield - usFresh[1] : null,
  };
}

// ── 回測：估值區間 vs 之後加權報酬 ─────────────────────────────

export interface ValBucket {
  label: string;
  lo: number;
  hi: number;
  /** 落在這個區間的月數 */
  months: number;
  /** 之後 1 年報酬：有完整一年資料的月數、平均（%）、上漲機率（%） */
  n1: number;
  avg1: number | null;
  win1: number | null;
  /** 前段（SPLIT 之前）與後段的 1 年平均（%）；看方向穩不穩 */
  early1: number | null;
  late1: number | null;
  /** 之後 3 年年化報酬（%） */
  n3: number;
  avg3: number | null;
}

export interface ValBacktest {
  /** 第一個與最後一個樣本月份（YYYY-MM） */
  start: string;
  end: string;
  split: string;
  base: ValBucket;
  pe: ValBucket[];
  pb: ValBucket[];
  /** 股債利差（月底盈餘殖利率 − 當月台債 10Y 平均）；沒有台債資料時為空 */
  spread: ValBucket[];
}

/** 回測分組＝指標表的區間（本益比：偏低以下／合理／偏高／昂貴；淨值比：便宜／合理／偏高／昂貴） */
export const PE_BUCKETS: readonly [number, number, string][] = [
  [0, 15, '<15'],
  [15, 19, '15–19'],
  [19, 23, '19–23'],
  [23, Infinity, '≥23'],
];
export const PB_BUCKETS: readonly [number, number, string][] = [
  [0, 1.5, '<1.5'],
  [1.5, 2, '1.5–2.0'],
  [2, 2.5, '2.0–2.5'],
  [2.5, Infinity, '≥2.5'],
];
/** 股債利差（pp）：負值＝債券殖利率高於盈餘殖利率（只出現在 1999–2001 年台債 5% 以上時） */
export const SPREAD_BUCKETS: readonly [number, number, string][] = [
  [-Infinity, 0, '<0'],
  [0, 3, '0–3'],
  [3, Infinity, '≥3'],
];
/** 前後段分界：前段含 2000 年泡沫、2008 金融海嘯；後段是 2013 年後的長多 */
export const BACKTEST_SPLIT = '2013-01';
/** 月報約在下個月第 7 個營業日公布 → 月底後 10 天起算報酬 */
const PUBLISH_LAG_DAYS = 10;
const Y1 = 250;
const Y3 = 750;

interface Obs {
  month: string;
  pe: number;
  pb: number | null;
  spread: number | null;
  r1: number | null;
  r3: number | null;
}

function observations(peM: readonly Point[], pbM: readonly Point[], taiex: readonly Point[], tw10y: readonly Point[]): Obs[] {
  const pbBy = new Map(pbM.map((p) => [monthKey(p[0]), p[1]]));
  // 當月台債 10Y 平均：月底時市場上已看得到這個利率水準（央行月資料晚公布，但不是未來資訊）
  const y10By = new Map(tw10y.map((p) => [monthKey(p[0]), p[1]]));
  const dates = taiex.map((p) => p[0]);
  const lowerBound = (d: string) => {
    let lo = 0;
    let hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid]! < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out: Obs[] = [];
  for (const [m, pe] of peM) {
    const key = monthKey(m);
    const nextMonth = addMonths(`${key}-01`, 1);
    const me = lowerBound(nextMonth) - 1; // 當月最後一個交易日
    if (me < 0 || monthKey(dates[me]!) !== key) continue;
    const s = lowerBound(addDays(dates[me]!, PUBLISH_LAG_DAYS));
    const p0 = taiex[s]?.[1];
    const r1 = p0 && s + Y1 < taiex.length ? (taiex[s + Y1]![1] / p0 - 1) * 100 : null;
    const r3 = p0 && s + Y3 < taiex.length ? ((taiex[s + Y3]![1] / p0) ** (1 / 3) - 1) * 100 : null;
    const y = y10By.get(key);
    out.push({ month: key, pe, pb: pbBy.get(key) ?? null, spread: y !== undefined && pe > 0 ? 100 / pe - y : null, r1, r3 });
  }
  return out;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function bucket(label: string, lo: number, hi: number, obs: readonly Obs[]): ValBucket {
  const r1 = obs.flatMap((o) => (o.r1 === null ? [] : [o.r1]));
  const r3 = obs.flatMap((o) => (o.r3 === null ? [] : [o.r3]));
  const part = (early: boolean) =>
    mean(obs.filter((o) => o.r1 !== null && (o.month < BACKTEST_SPLIT) === early).map((o) => o.r1!));
  return {
    label,
    lo,
    hi,
    months: obs.length,
    n1: r1.length,
    avg1: mean(r1),
    win1: r1.length ? (r1.filter((v) => v > 0).length / r1.length) * 100 : null,
    early1: part(true),
    late1: part(false),
    n3: r3.length,
    avg3: mean(r3),
  };
}

export function valuationBacktest(
  peM: readonly Point[],
  pbM: readonly Point[],
  taiex: readonly Point[],
  tw10y: readonly Point[] = [],
): ValBacktest | null {
  const obs = observations(peM, pbM, taiex, tw10y);
  if (obs.length < 24) return null;
  const inRange = (v: number | null, lo: number, hi: number) => v !== null && v >= lo && v < hi;
  return {
    start: obs[0]!.month,
    end: obs.at(-1)!.month,
    split: BACKTEST_SPLIT,
    base: bucket('全部（基準）', -Infinity, Infinity, obs),
    pe: PE_BUCKETS.map(([lo, hi, label]) => bucket(label, lo, hi, obs.filter((o) => inRange(o.pe, lo, hi)))),
    pb: PB_BUCKETS.map(([lo, hi, label]) => bucket(label, lo, hi, obs.filter((o) => inRange(o.pb, lo, hi)))),
    spread: obs.some((o) => o.spread !== null)
      ? SPREAD_BUCKETS.map(([lo, hi, label]) => bucket(label, lo, hi, obs.filter((o) => inRange(o.spread, lo, hi))))
      : [],
  };
}

/** 股債利差判讀（pp）：與美股面板相同 */
export { spreadText } from './usValuation';
