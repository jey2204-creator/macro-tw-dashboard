import { addMonths, monthKey } from './dates';
import { zoneAt, type Zone } from './indicators';
import { monthEnd } from './policyInflation';
import { valueAtOrBefore, type Point } from './timeseries';

/**
 * 美股估值（參考面板，不計分）
 * - 河流圖：S&P 500 日收盤 vs 近 12 月 EPS × 固定倍數（15／19／23／27／31）。指數貼近上緣＝估值高、貼近下緣＝便宜；
 *   河道隨 EPS 上升而上移，所以指數橫盤也能從貴變合理
 * - 本益比：日收盤 ÷ 當時 EPS（EPS 取 ≤ 該日的最後一筆月資料）；百分位與中位數以 2010 年起為基期
 * - 股債利差：盈餘殖利率（EPS ÷ 指數）− 美債 10Y（pp）。負值＝無風險的債券報酬已高於股票的盈餘報酬，股票沒有估值緩衝
 * EPS（名目）＝ multpl 月均價 ÷ multpl 本益比（multpl 的 EPS 頁是通膨調整後的實質值，不能直接用）。
 */

export const RIVER_MULTIPLES = [15, 19, 23, 27, 31] as const;
/** 本益比百分位、中位數的基期起點（2010 年起：量化寬鬆後的估值常態） */
export const PE_BASE_START = '2010-01-01';

export function closesOf(bars: readonly (readonly [string, number, number, number, number])[]): Point[] {
  return bars.map((b) => [b[0], b[4]]);
}

/** 近 12 月 EPS（名目）＝月均價 ÷ 本益比；兩表依月份配對，日期取較晚的一筆（當月「今天」列） */
export function epsSeries(pe: readonly Point[], price: readonly Point[]): Point[] {
  const priceByMonth = new Map(price.map((p) => [monthKey(p[0]), p]));
  const out: Point[] = [];
  for (const [d, ratio] of pe) {
    const p = priceByMonth.get(monthKey(d));
    if (!p || ratio <= 0 || p[1] <= 0) continue;
    out.push([d > p[0] ? d : p[0], p[1] / ratio]);
  }
  return out;
}

export interface RiverRow {
  date: string;
  price: number;
  /** 當時適用的近 12 月 EPS */
  eps: number;
  pe: number;
  /** 盈餘殖利率 − 美債 10Y（pp）；10Y 尚無資料時為 null */
  spread: number | null;
}

/** 10Y 距該日超過這些天就不算（FRED 日資料通常落後 1–2 天） */
const Y10_MAX_LAG_DAYS = 10;

/** 每個交易日一列：EPS 取 ≤ 該日的最後一筆月資料；EPS 資料開始前的日子略過 */
export function riverRows(spx: readonly Point[], eps: readonly Point[], us10y: readonly Point[]): RiverRow[] {
  const out: RiverRow[] = [];
  if (eps.length === 0) return out;
  let j = 0; // eps 指標
  let k = 0; // us10y 指標
  for (const [date, price] of spx) {
    while (j + 1 < eps.length && eps[j + 1]![0] <= date) j++;
    if (eps[j]![0] > date) continue;
    const e = eps[j]![1];
    if (!(e > 0) || !(price > 0)) continue;
    while (k + 1 < us10y.length && us10y[k + 1]![0] <= date) k++;
    const y = us10y[k];
    const fresh = y && y[0] <= date && daysApart(y[0], date) <= Y10_MAX_LAG_DAYS ? y[1] : null;
    out.push({ date, price, eps: e, pe: price / e, spread: fresh === null ? null : (e / price) * 100 - fresh });
  }
  return out;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/** v 在樣本中的百分位（0–100）：低於 v 的比例，同值算一半 */
export function percentile(values: readonly number[], v: number): number | null {
  if (values.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const x of values) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return ((below + equal / 2) / values.length) * 100;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface PeStats {
  n: number;
  median: number;
  /** 最新值的百分位（0–100） */
  pct: number;
}

/** 本益比月資料自 since 起的中位數與最新值百分位 */
export function peStats(peMonthly: readonly Point[], latest: number, since = PE_BASE_START): PeStats | null {
  const vals = peMonthly.filter((p) => p[0] >= since).map((p) => p[1]);
  const med = median(vals);
  const pct = percentile(vals, latest);
  if (med === null || pct === null) return null;
  return { n: vals.length, median: med, pct };
}

/** 月資料的股債利差（每個 EPS 月份：EPS ÷ 月均價 − 該月月底 10Y）；用來判斷「幾年以來最低」 */
export function monthlySpread(eps: readonly Point[], priceMonthly: readonly Point[], us10y: readonly Point[]): Point[] {
  const priceByMonth = new Map(priceMonthly.map((p) => [monthKey(p[0]), p[1]]));
  const out: Point[] = [];
  for (const [d, e] of eps) {
    const p = priceByMonth.get(monthKey(d));
    const y = valueAtOrBefore(us10y, monthEnd(d));
    if (!p || !y || y[0] < addMonths(monthEnd(d), -1)) continue;
    out.push([d, (e / p) * 100 - y[1]]);
  }
  return out;
}

/**
 * 最新值 v 是「哪個月以來最低」：往回找最後一個低於 v 的月份，回傳它的下一個月（YYYY-MM）；
 * 歷史上從未更低回傳資料起點月份。只看 before（不含）之前的月份，避免拿自己跟自己比。
 */
export function lowestSince(pts: readonly Point[], v: number, before: string): string | null {
  const prior = pts.filter((p) => monthKey(p[0]) < monthKey(before));
  if (prior.length === 0) return null;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i]![1] < v) return i + 1 < prior.length ? monthKey(prior[i + 1]![0]) : monthKey(before);
  }
  return monthKey(prior[0]![0]);
}

/** 與 12 個月前（同月份鍵）相比的變化率（%） */
export function yoyOfLast(pts: readonly Point[]): number | null {
  const last = pts.at(-1);
  if (!last) return null;
  const want = monthKey(addMonths(`${monthKey(last[0])}-01`, -12));
  const prev = pts.find((p) => monthKey(p[0]) === want);
  return prev && prev[1] !== 0 ? (last[1] / prev[1] - 1) * 100 : null;
}

export interface BandPosition {
  /** 指數下方最近的倍數線（null＝低於最低線） */
  below: number | null;
  /** 指數上方最近的倍數線（null＝高於最高線） */
  above: number | null;
  /** 指數距下方線的漲幅（%，正） */
  distBelow: number | null;
  /** 指數距上方線的差距（%，負） */
  distAbove: number | null;
}

/** 指數落在哪兩條倍數線之間 */
export function bandPosition(price: number, eps: number, multiples: readonly number[] = RIVER_MULTIPLES): BandPosition {
  let below: number | null = null;
  let above: number | null = null;
  for (const m of multiples) {
    const line = eps * m;
    if (line <= price) below = m;
    else if (above === null) above = m;
  }
  const pctTo = (m: number | null) => (m === null ? null : (price / (eps * m) - 1) * 100);
  return { below, above, distBelow: pctTo(below), distAbove: pctTo(above) };
}

export interface UsValuationSummary {
  date: string;
  price: number;
  eps: number;
  epsDate: string;
  epsYoy: number | null;
  pe: number;
  zone: string | null;
  peStats: PeStats | null;
  position: BandPosition;
  earningsYield: number;
  y10: number | null;
  spread: number | null;
  /** 股債利差自哪個月以來最低（YYYY-MM）；非多年新低時為 null */
  spreadLowestSince: string | null;
  cape: number | null;
  capeDate: string | null;
  /** CAPE 全期（1881 起）百分位 */
  capePct: number | null;
}

/** 只有拉到 24 個月以上才說「X 以來最低」，否則不值得提 */
const LOWEST_SINCE_MIN_MONTHS = 24;

export function summarize(
  rows: readonly RiverRow[],
  peMonthly: readonly Point[],
  eps: readonly Point[],
  priceMonthly: readonly Point[],
  us10y: readonly Point[],
  cape: readonly Point[],
  zones: readonly Zone[] | undefined,
): UsValuationSummary | null {
  const last = rows.at(-1);
  const epsLast = eps.at(-1);
  if (!last || !epsLast) return null;
  const earningsYield = (last.eps / last.price) * 100;
  const y10 = last.spread === null ? null : earningsYield - last.spread;
  let spreadLowestSince: string | null = null;
  if (last.spread !== null) {
    const since = lowestSince(monthlySpread(eps, priceMonthly, us10y), last.spread, last.date);
    if (since && monthsBetween(since, monthKey(last.date)) >= LOWEST_SINCE_MIN_MONTHS) spreadLowestSince = since;
  }
  const capeLast = cape.at(-1);
  return {
    date: last.date,
    price: last.price,
    eps: last.eps,
    epsDate: epsLast[0],
    epsYoy: yoyOfLast(eps),
    pe: last.pe,
    zone: zoneAt(zones, last.pe)?.label ?? null,
    peStats: peStats(peMonthly, last.pe),
    position: bandPosition(last.price, last.eps),
    earningsYield,
    y10,
    spread: last.spread,
    spreadLowestSince,
    cape: capeLast?.[1] ?? null,
    capeDate: capeLast?.[0] ?? null,
    capePct: capeLast ? percentile(cape.map((p) => p[1]), capeLast[1]) : null,
  };
}

function monthsBetween(fromYm: string, toYm: string): number {
  const [fy, fm] = fromYm.split('-').map(Number) as [number, number];
  const [ty, tm] = toYm.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/** 股債利差的判讀（pp）：≥ +1 股票較划算、0～+1 接近打平、< 0 債券較划算 */
export function spreadText(spread: number | null): string {
  if (spread === null) return '—';
  if (spread >= 1) return '股票較划算';
  if (spread >= 0) return '接近打平';
  return '債券較划算';
}

/** 讀數列用的 Point 查詢（rows 依日期遞增） */
export function rowAtOrBefore(rows: readonly RiverRow[], date: string): RiverRow | null {
  let lo = 0;
  let hi = rows.length - 1;
  let ans: RiverRow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.date <= date) {
      ans = rows[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
