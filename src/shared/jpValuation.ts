import { addDays, monthKey } from './dates';
import { zoneAt, type Zone } from './indicators';
import type { Point } from './timeseries';
import { valueAtOrBefore } from './timeseries';
import { ratioStats, valuationBacktest, type RatioStats, type ValBacktest } from './twValuation';
import { bandPosition, type BandPosition } from './usValuation';

/**
 * 日股估值（參考面板，不計分）
 * 資料：日經平均プロフィル日次投資指標（2004-09 起、每日）：預估 PER（指數基準／加重平均）、PBR、殖利率；
 * 日經 225 日收盤（Yahoo ^N225）；日本 10 年期公債殖利率（OECD 月均，FRED）。
 * - 日經公布的 PER 用「今期預估利益」→ 本來就是預估本益比。預估 EPS（以指數點計）＝收盤 ÷ 指數基準 PER，每天都有
 * - 河流圖＝預估 EPS × 11／14／17／20／23／26 倍（2010 起月底值：25 分位 16.8、中位數 18.8、75 分位 21.1、90 分位 23.8）
 * - 換年度：本決算公布日翌日起逐家切換到下一年度預估（多在 4 月底～5 月中），EPS 會在幾週內整批上移、本益比跳一格；
 *   面板把單日 EPS 變動超過 EPS_JUMP_PCT 的日子標成「換年度／修正」
 * - 加重平均 PER（總市值 ÷ 預估利益總額，日經新聞刊登值）不受價格加權影響；兩者差距＝少數高本益比權值股的影響
 */

export const JP_RIVER_MULTIPLES = [11, 14, 17, 20, 23, 26] as const;
/** 百分位、中位數基期（與美股相同：2010 起） */
export const JP_BASE_START = '2010-01-01';
/** 單日預估 EPS 變動超過此比例 → 視為換年度或大幅修正 */
export const EPS_JUMP_PCT = 3;
/** 日債 10Y 月資料最多落後幾天仍採用（OECD 約晚 1～2 個月） */
const Y10_MAX_LAG_DAYS = 100;

export interface JpRow {
  date: string;
  price: number;
  /** 預估 EPS（指數點）＝收盤 ÷ 指數基準 PER */
  eps: number;
  /** 指數基準預估本益比 */
  pe: number;
  /** 加重平均預估本益比（日經新聞刊登值） */
  peW: number | null;
  pb: number | null;
  /** 盈餘殖利率（預估）− 日債 10Y（pp） */
  spread: number | null;
}

/** 日債 10Y（月均，YYYY-MM-01）：取月份早於 date 所在月的最近一筆 */
export function jp10yBefore(jp10y: readonly Point[], date: string): Point | null {
  const firstOfMonth = `${monthKey(date)}-01`;
  const p = valueAtOrBefore(jp10y, addDays(firstOfMonth, -1));
  if (!p) return null;
  return Date.parse(date) - Date.parse(p[0]) <= Y10_MAX_LAG_DAYS * 86_400_000 ? p : null;
}

/** 以日期配對（兩邊都是日資料、同交易日曆）；PER 缺的日子略過 */
function byDate(pts: readonly Point[]): Map<string, number> {
  return new Map(pts.map((p) => [p[0], p[1]]));
}

/** 每個交易日一列：日經收盤與當天 PER 配對（同日才算，不補值） */
export function jpRiverRows(
  nikkei: readonly Point[],
  peIndex: readonly Point[],
  peWeighted: readonly Point[],
  pbIndex: readonly Point[],
  jp10y: readonly Point[],
): JpRow[] {
  const pe = byDate(peIndex);
  const peW = byDate(peWeighted);
  const pb = byDate(pbIndex);
  const out: JpRow[] = [];
  for (const [date, price] of nikkei) {
    const r = pe.get(date);
    if (!(price > 0) || r === undefined || !(r > 0)) continue;
    const eps = price / r;
    const y = jp10yBefore(jp10y, date);
    out.push({
      date,
      price,
      eps,
      pe: r,
      peW: peW.get(date) ?? null,
      pb: pb.get(date) ?? null,
      spread: y ? (eps / price) * 100 - y[1] : null,
    });
  }
  return out;
}

export function jpRowAtOrBefore(rows: readonly JpRow[], date: string): JpRow | null {
  let lo = 0;
  let hi = rows.length - 1;
  let ans: JpRow | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.date <= date) {
      ans = rows[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 每月最後一個交易日的列（百分位、回測用月底值） */
export function monthEndRows(rows: readonly JpRow[]): JpRow[] {
  const out: JpRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const next = rows[i + 1];
    if (!next || monthKey(next.date) !== monthKey(rows[i]!.date)) out.push(rows[i]!);
  }
  return out;
}

export interface EpsJump {
  date: string;
  /** 當日 EPS 變動（%） */
  pct: number;
}

/** 單日預估 EPS 變動超過門檻的日子（換年度或大幅修正）；連續幾天都跳只標第一天 */
export function epsJumps(rows: readonly JpRow[], thresholdPct = EPS_JUMP_PCT): EpsJump[] {
  const out: EpsJump[] = [];
  let inRun = false;
  for (let i = 1; i < rows.length; i++) {
    const pct = (rows[i]!.eps / rows[i - 1]!.eps - 1) * 100;
    if (Math.abs(pct) >= thresholdPct) {
      if (!inRun) out.push({ date: rows[i]!.date, pct });
      inRun = true;
    } else inRun = false;
  }
  return out;
}

export interface JpValuationSummary {
  date: string;
  price: number;
  eps: number;
  /** 預估 EPS 與一年前（約 245 個交易日前）相比（%） */
  epsYoy: number | null;
  /** 預估 EPS 與 20 個交易日前相比（%）：看預估是否下修 */
  epsChg20: number | null;
  pe: number;
  zone: string | null;
  peStats: RatioStats | null;
  /** 近 5 年月底本益比平均 */
  avg5: number | null;
  needGrowth: number | null;
  needDrop: number | null;
  position: BandPosition;
  peW: number | null;
  peWStats: RatioStats | null;
  /** 指數基準 − 加重平均（倍）：權值股集中的影響 */
  peGap: number | null;
  pb: number | null;
  pbZone: string | null;
  pbStats: RatioStats | null;
  dy: number | null;
  earningsYield: number;
  y10: number | null;
  y10Month: string | null;
  spread: number | null;
  /** 盈餘殖利率 − 美債 10Y（pp） */
  usSpread: number | null;
  /** 最近一次換年度／大幅修正 */
  lastJump: EpsJump | null;
}

const AVG_MONTHS = 60;
const TRADING_DAYS_1Y = 245;

export function summarizeJp(
  rows: readonly JpRow[],
  dy: readonly Point[],
  jp10y: readonly Point[],
  us10y: readonly Point[],
  peZones: readonly Zone[] | undefined,
  pbZones: readonly Zone[] | undefined,
): JpValuationSummary | null {
  const last = rows.at(-1);
  if (!last) return null;
  const me = monthEndRows(rows);
  const peMonthly: Point[] = me.map((r) => [r.date, r.pe]);
  const peWMonthly: Point[] = me.flatMap((r) => (r.peW === null ? [] : [[r.date, r.peW] as Point]));
  const pbMonthly: Point[] = me.flatMap((r) => (r.pb === null ? [] : [[r.date, r.pb] as Point]));
  const recent = peMonthly.slice(-AVG_MONTHS).map((p) => p[1]);
  const avg5 = recent.length >= AVG_MONTHS ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  const ago = (n: number) => (rows.length > n ? rows[rows.length - 1 - n]!.eps : null);
  const pctChg = (prev: number | null) => (prev && prev > 0 ? (last.eps / prev - 1) * 100 : null);
  const earningsYield = (last.eps / last.price) * 100;
  const y = jp10yBefore(jp10y, last.date);
  const us = valueAtOrBefore(us10y, last.date);
  const usFresh = us && Date.parse(last.date) - Date.parse(us[0]) <= 10 * 86_400_000 ? us : null;
  const dyLast = valueAtOrBefore(dy, last.date);
  const jumps = epsJumps(rows);
  return {
    date: last.date,
    price: last.price,
    eps: last.eps,
    epsYoy: pctChg(ago(TRADING_DAYS_1Y)),
    epsChg20: pctChg(ago(20)),
    pe: last.pe,
    zone: zoneAt(peZones, last.pe)?.label ?? null,
    peStats: ratioStats(peMonthly, last.pe, JP_BASE_START),
    avg5,
    needGrowth: avg5 ? (last.pe / avg5 - 1) * 100 : null,
    needDrop: avg5 ? (avg5 / last.pe - 1) * 100 : null,
    position: bandPosition(last.price, last.eps, JP_RIVER_MULTIPLES),
    peW: last.peW,
    peWStats: last.peW === null ? null : ratioStats(peWMonthly, last.peW, JP_BASE_START),
    peGap: last.peW === null ? null : last.pe - last.peW,
    pb: last.pb,
    pbZone: last.pb === null ? null : (zoneAt(pbZones, last.pb)?.label ?? null),
    pbStats: last.pb === null ? null : ratioStats(pbMonthly, last.pb, JP_BASE_START),
    dy: dyLast && Date.parse(last.date) - Date.parse(dyLast[0]) <= 10 * 86_400_000 ? dyLast[1] : null,
    earningsYield,
    y10: y ? y[1] : null,
    y10Month: y ? monthKey(y[0]) : null,
    spread: last.spread,
    usSpread: usFresh ? earningsYield - usFresh[1] : null,
    lastJump: jumps.at(-1) ?? null,
  };
}

// ── 回測：估值區間 vs 之後日經報酬（月底值，日資料不必等公布） ──

/** 分組＝指標表的區間 */
export const JP_PE_BUCKETS: readonly [number, number, string][] = [
  [0, 14, '<14'],
  [14, 17, '14–17'],
  [17, 20, '17–20'],
  [20, 23, '20–23'],
  [23, Infinity, '≥23'],
];
export const JP_PB_BUCKETS: readonly [number, number, string][] = [
  [0, 1.2, '<1.2'],
  [1.2, 1.6, '1.2–1.6'],
  [1.6, 2, '1.6–2.0'],
  [2, Infinity, '≥2.0'],
];
/** 股債利差（pp）：日債長期接近 0，利差幾乎等於盈餘殖利率 */
export const JP_SPREAD_BUCKETS: readonly [number, number, string][] = [
  [-Infinity, 4, '<4'],
  [4, 6, '4–6'],
  [6, Infinity, '≥6'],
];
/** 前後段分界：2013 年起安倍經濟學、日銀 ETF 購買 */
export const JP_BACKTEST_SPLIT = '2013-01';

export function jpValuationBacktest(rows: readonly JpRow[], nikkei: readonly Point[], jp10y: readonly Point[]): ValBacktest | null {
  const me = monthEndRows(rows);
  const peM: Point[] = me.map((r) => [`${monthKey(r.date)}-01`, r.pe]);
  const pbM: Point[] = me.flatMap((r) => (r.pb === null ? [] : [[`${monthKey(r.date)}-01`, r.pb] as Point]));
  return valuationBacktest(peM, pbM, nikkei, jp10y, {
    pe: JP_PE_BUCKETS,
    pb: JP_PB_BUCKETS,
    spread: JP_SPREAD_BUCKETS,
    split: JP_BACKTEST_SPLIT,
    lagDays: 0,
  });
}

export { spreadText } from './usValuation';
