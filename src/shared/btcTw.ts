import { alignToTwCalendar, dropWeekendBars, pairedReturns, pearson } from './crossMarket';
import { daysBetween } from './dates';
import type { Bar } from './types';

/**
 * 比特幣 vs 加權：回測比特幣對台股有沒有「費半以外」的資訊。
 *
 * 時間對齊：Yahoo BTC-USD 日 K 以 UTC 日期切，收盤＝台北隔天 08:00（台股開盤前）。
 * 與美股相同做 alignToTwCalendar：日期 d 的 K 棒 → 第一個 ≥ d+1 的台股交易日；週末三根合併到週一。
 * 所以配對報酬＝「台股開盤前 24 小時（連假則整段休市）比特幣漲跌」vs「台股當日收盤漲跌」。
 *
 * 四個問題：
 * 1. 同步相關：比特幣與加權日報酬的相關，跟費半比；扣掉費半之後還剩多少（偏相關）
 * 2. 週末訊號：台股休市期間（週末、連假）比特幣漲跌，對連假後第一天加權有沒有預測力（扣掉費半週五）
 * 3. 大跌事件：比特幣單日 ≤ −7% 之後加權表現；特別看「費半沒跌」的那些天
 * 4. 領先：前一天比特幣報酬 vs 今天加權
 *
 * 參考、不計分。分段：2015–2019（散戶期）、2020 起（機構、ETF 期）。
 */

export interface Period {
  key: string;
  label: string;
  from: string;
  to: string;
}

export const BTC_PERIODS: Period[] = [
  { key: 'early', label: '2015–2019', from: '2015-01-01', to: '2019-12-31' },
  { key: 'late', label: '2020 起', from: '2020-01-01', to: '9999-12-31' },
  { key: 'all', label: '全期', from: '2015-01-01', to: '9999-12-31' },
];

/** 大跌門檻：比特幣對齊後單日（含週末合併）跌幅 */
export const BTC_CRASH_PCT = -7;
/** 「費半沒跌」：同一段期間費半 ≥ −1% */
export const SOX_CALM_PCT = -1;
/** 事件去重：前一個事件後 N 個台股交易日內的不再計 */
export const CRASH_GAP_DAYS = 5;
/** 判定門檻：扣掉費半後比特幣與加權的相關 */
export const INCR_USEFUL = 0.2;
export const INCR_WEAK = 0.1;

/** 休市期間比特幣漲跌分組（%） */
export const GAP_BUCKETS: { key: string; label: string; lo: number; hi: number }[] = [
  { key: 'b1', label: '≤ −5%', lo: -Infinity, hi: -5 },
  { key: 'b2', label: '−5 ~ −2%', lo: -5, hi: -2 },
  { key: 'b3', label: '−2 ~ +2%', lo: -2, hi: 2 },
  { key: 'b4', label: '+2 ~ +5%', lo: 2, hi: 5 },
  { key: 'b5', label: '≥ +5%', lo: 5, hi: Infinity },
];

const pct = (a: number, b: number) => (b / a - 1) * 100;

/** 日期 ≤ d 的最後一根索引（bars 遞增）；沒有則 −1 */
export function lastIndexAtOrBefore(bars: readonly Bar[], d: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]![0] <= d) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 最小平方法斜率 y = a + βx；資料不足或 x 無變異回 null */
export function olsBeta(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : null;
}

/** 偏相關：y 先對 z 迴歸取殘差，再與 x 求相關（「扣掉費半後還剩多少」） */
export function partialCorr(x: readonly number[], y: readonly number[], z: readonly number[]): number | null {
  const b = olsBeta(z, y);
  if (b === null) return null;
  const n = Math.min(x.length, y.length, z.length);
  let mz = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mz += z[i]!;
    my += y[i]!;
  }
  mz /= n;
  my /= n;
  const resid = Array.from({ length: n }, (_, i) => y[i]! - my - b * (z[i]! - mz));
  return pearson(x.slice(0, n), resid);
}

/** 每個台股交易日的配對（三邊都有報酬才算） */
export interface DayRow {
  date: string;
  /** 加權當日收盤報酬 % */
  tw: number;
  /** 對齊後比特幣報酬 %（開盤前 24 小時；連假為整段） */
  btc: number;
  /** 對齊後費半報酬 %（前一晚美股） */
  sox: number;
}

export interface GapRow {
  date: string;
  /** 休市日曆天數（週末 3、連假更長） */
  days: number;
  /** 休市期間比特幣漲跌 %：上個台股日的 UTC 日 K 收盤（台北隔天 08:00）→ 開盤前一根收盤 */
  btcGap: number;
  /** 加權開盤跳空 %（開 vs 前收）；開盤價不可信時為 null */
  open: number | null;
  /** 加權收盤報酬 % */
  close: number;
  /** 前一晚費半 %（休市前最後一個美股交易日） */
  sox: number;
}

export interface CrashRow {
  date: string;
  btc: number;
  sox: number;
  /** 加權當天、之後 5 日、20 日 %（不足為 null） */
  d0: number;
  d5: number | null;
  d20: number | null;
}

/** 把三條序列配成日資料（以加權交易日為準）。btcRaw 須含週末 K 棒 */
export function buildDayRows(tw: readonly Bar[], btcRaw: readonly Bar[], soxRaw: readonly Bar[]): DayRow[] {
  const twDates = tw.map((b) => b[0]);
  const btc = pairedReturns(tw, alignToTwCalendar(btcRaw, twDates));
  const sox = pairedReturns(tw, alignToTwCalendar(dropWeekendBars([...soxRaw]), twDates));
  const out: DayRow[] = [];
  for (let i = 0; i < tw.length; i++) {
    const t = btc.tw[i];
    const b = btc.cmp[i];
    const s = sox.cmp[i];
    const t2 = sox.tw[i];
    // 兩組配對的台股報酬要是同一段期間（兩邊都是前一個台股日起算）才合併
    if (t == null || b == null || s == null || t2 == null || Math.abs(t - t2) > 1e-12) continue;
    out.push({ date: twDates[i]!, tw: (Math.exp(t) - 1) * 100, btc: (Math.exp(b) - 1) * 100, sox: (Math.exp(s) - 1) * 100 });
  }
  return out;
}

/** 台股休市後第一天（距上個台股日 ≥ 3 日曆天） */
export function buildGapRows(tw: readonly Bar[], btcRaw: readonly Bar[], days: readonly DayRow[]): GapRow[] {
  const soxByDate = new Map(days.map((d) => [d.date, d.sox]));
  const out: GapRow[] = [];
  for (let i = 1; i < tw.length; i++) {
    const prev = tw[i - 1]!;
    const cur = tw[i]!;
    const gap = daysBetween(prev[0], cur[0]);
    if (gap < 3) continue;
    const sox = soxByDate.get(cur[0]);
    if (sox === undefined) continue;
    // 上個台股日那根 UTC 日 K（收盤＝台北隔天 08:00，已過美股收盤）→ 開盤日前一天那根（收盤＝開盤日 08:00）
    const a = lastIndexAtOrBefore(btcRaw, prev[0]);
    const b = lastIndexAtOrBefore(btcRaw, addDay(cur[0], -1));
    if (a < 0 || b <= a || btcRaw[a]![0] !== prev[0]) continue;
    const pc = prev[4];
    const op = cur[1];
    // Yahoo 早年部分 K 棒開＝收或開＝前收（沒有真實開盤價）→ 不算跳空
    const openOk = op > 0 && op !== cur[4] && op !== pc && Math.abs(pct(pc, op)) < 10;
    out.push({ date: cur[0], days: gap, btcGap: pct(btcRaw[a]![4], btcRaw[b]![4]), open: openOk ? pct(pc, op) : null, close: pct(pc, cur[4]), sox });
  }
  return out;
}

function addDay(d: string, n: number): string {
  const t = Date.parse(`${d}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const inPeriod = (d: string, p: Period) => d >= p.from && d <= p.to;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const upPct = (xs: readonly number[]) => (xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null);

export interface CorrStat {
  period: Period;
  n: number;
  /** 比特幣 vs 加權 */
  btc: number | null;
  /** 費半 vs 加權（對照組） */
  sox: number | null;
  /** 扣掉費半後比特幣 vs 加權（偏相關）＝比特幣的增量資訊 */
  btcExSox: number | null;
  /** 前一天比特幣 vs 今天加權（領先一天） */
  btcLag: number | null;
  /** 比特幣 vs 費半 */
  btcSox: number | null;
}

export function corrStats(days: readonly DayRow[]): CorrStat[] {
  return BTC_PERIODS.map((p) => {
    const idx = days.map((d, i) => (inPeriod(d.date, p) ? i : -1)).filter((i) => i >= 0);
    const r = idx.map((i) => days[i]!);
    const tw = r.map((d) => d.tw);
    const btc = r.map((d) => d.btc);
    const sox = r.map((d) => d.sox);
    const lagPairs = idx.filter((i) => i > 0);
    return {
      period: p,
      n: r.length,
      btc: pearson(btc, tw),
      sox: pearson(sox, tw),
      btcExSox: partialCorr(btc, tw, sox),
      btcLag: pearson(
        lagPairs.map((i) => days[i - 1]!.btc),
        lagPairs.map((i) => days[i]!.tw),
      ),
      btcSox: pearson(btc, sox),
    };
  });
}

export interface YearCorr {
  year: string;
  n: number;
  btc: number | null;
  sox: number | null;
  btcExSox: number | null;
}

export function yearlyCorr(days: readonly DayRow[]): YearCorr[] {
  const by = new Map<string, DayRow[]>();
  for (const d of days) {
    const y = d.date.slice(0, 4);
    if (y < '2015') continue;
    (by.get(y) ?? by.set(y, []).get(y)!).push(d);
  }
  return [...by.entries()].map(([year, r]) => ({
    year,
    n: r.length,
    btc: pearson(r.map((d) => d.btc), r.map((d) => d.tw)),
    sox: pearson(r.map((d) => d.sox), r.map((d) => d.tw)),
    btcExSox: partialCorr(r.map((d) => d.btc), r.map((d) => d.tw), r.map((d) => d.sox)),
  }));
}

export interface GapBucketStat {
  key: string;
  label: string;
  n: number;
  open: number | null;
  close: number | null;
  up: number | null;
  /** 扣掉費半後的加權報酬（收盤 − β×費半） */
  resid: number | null;
}

export interface GapStat {
  period: Period;
  n: number;
  beta: number | null;
  buckets: GapBucketStat[];
  /** 休市期間比特幣 vs 連假後加權收盤（原始／扣費半）／開盤跳空 */
  corrClose: number | null;
  corrResid: number | null;
  corrOpen: number | null;
  /** 開盤跳空扣掉費半後 */
  corrOpenResid: number | null;
}

export function gapStats(gaps: readonly GapRow[]): GapStat[] {
  return BTC_PERIODS.map((p) => {
    const r = gaps.filter((g) => inPeriod(g.date, p));
    const beta = olsBeta(r.map((g) => g.sox), r.map((g) => g.close));
    const resid = (g: GapRow) => (beta === null ? g.close : g.close - beta * g.sox);
    const withOpen = r.filter((g) => g.open !== null);
    const betaOpen = olsBeta(withOpen.map((g) => g.sox), withOpen.map((g) => g.open!));
    return {
      period: p,
      n: r.length,
      beta,
      buckets: GAP_BUCKETS.map((b) => {
        const xs = r.filter((g) => g.btcGap > b.lo && g.btcGap <= b.hi);
        const opens = xs.flatMap((g) => (g.open === null ? [] : [g.open]));
        return {
          key: b.key,
          label: b.label,
          n: xs.length,
          open: mean(opens),
          close: mean(xs.map((g) => g.close)),
          up: upPct(xs.map((g) => g.close)),
          resid: mean(xs.map(resid)),
        };
      }),
      corrClose: pearson(r.map((g) => g.btcGap), r.map((g) => g.close)),
      corrResid: pearson(r.map((g) => g.btcGap), r.map(resid)),
      corrOpen: pearson(withOpen.map((g) => g.btcGap), withOpen.map((g) => g.open!)),
      corrOpenResid:
        betaOpen === null ? null : pearson(withOpen.map((g) => g.btcGap), withOpen.map((g) => g.open! - betaOpen * g.sox)),
    };
  });
}

/** 比特幣對齊後單日 ≤ BTC_CRASH_PCT 的台股交易日（去重：前一事件後 CRASH_GAP_DAYS 日內不計） */
export function crashRows(tw: readonly Bar[], days: readonly DayRow[]): CrashRow[] {
  const idxOf = new Map(tw.map((b, i) => [b[0], i]));
  const out: CrashRow[] = [];
  let lastI = -Infinity;
  for (const d of days) {
    if (d.btc > BTC_CRASH_PCT || d.date < '2015-01-01') continue;
    const i = idxOf.get(d.date)!;
    if (i - lastI <= CRASH_GAP_DAYS) continue;
    lastI = i;
    const c = tw[i]![4];
    out.push({
      date: d.date,
      btc: d.btc,
      sox: d.sox,
      d0: d.tw,
      d5: i + 5 < tw.length ? pct(c, tw[i + 5]![4]) : null,
      d20: i + 20 < tw.length ? pct(c, tw[i + 20]![4]) : null,
    });
  }
  return out;
}

export interface CrashGroupStat {
  period: Period;
  key: 'all' | 'calm' | 'base';
  label: string;
  n: number;
  d0: number | null;
  d0Down: number | null;
  d5: number | null;
  d20: number | null;
}

/** 大跌事件分組：全部、費半沒跌、對照（所有台股交易日） */
export function crashStats(tw: readonly Bar[], days: readonly DayRow[], allCrashes: readonly CrashRow[], period: Period): CrashGroupStat[] {
  const crashes = allCrashes.filter((c) => inPeriod(c.date, period));
  const group = (key: CrashGroupStat['key'], label: string, xs: readonly CrashRow[]): CrashGroupStat => {
    const d5 = xs.flatMap((x) => (x.d5 === null ? [] : [x.d5]));
    const d20 = xs.flatMap((x) => (x.d20 === null ? [] : [x.d20]));
    return {
      period,
      key,
      label,
      n: xs.length,
      d0: mean(xs.map((x) => x.d0)),
      d0Down: xs.length ? (xs.filter((x) => x.d0 < 0).length / xs.length) * 100 : null,
      d5: mean(d5),
      d20: mean(d20),
    };
  };
  // 對照組：同期間所有配對日（同樣的當天、之後 5／20 日）
  const idxOf = new Map(tw.map((b, i) => [b[0], i]));
  const base: CrashRow[] = days
    .filter((d) => inPeriod(d.date, period))
    .map((d) => {
      const i = idxOf.get(d.date)!;
      const c = tw[i]![4];
      return {
        date: d.date,
        btc: d.btc,
        sox: d.sox,
        d0: d.tw,
        d5: i + 5 < tw.length ? pct(c, tw[i + 5]![4]) : null,
        d20: i + 20 < tw.length ? pct(c, tw[i + 20]![4]) : null,
      };
    });
  return [
    group('all', `比特幣 ≤ ${BTC_CRASH_PCT}%`, crashes),
    group('calm', `↳ 其中費半 ≥ ${SOX_CALM_PCT}%`, crashes.filter((c) => c.sox >= SOX_CALM_PCT)),
    group('base', '對照：所有交易日', base),
  ];
}

export type BtcVerdict = 'useful' | 'weak' | 'none';

export const VERDICT_TEXT: Record<BtcVerdict, string> = {
  useful: '有費半以外的資訊',
  weak: '只有微弱的額外資訊',
  none: '幾乎沒有費半以外的資訊',
};
export const VERDICT_COLOR: Record<BtcVerdict, string> = {
  useful: '--lamp-green',
  weak: '--lamp-yellowred',
  none: '--neutral',
};

/** 以 2020 起的「扣費半後相關」（日資料與休市期間取絕對值較大者）判定 */
export function verdictOf(corr: readonly CorrStat[], gap: readonly GapStat[]): { verdict: BtcVerdict; score: number | null } {
  const c = corr.find((x) => x.period.key === 'late')?.btcExSox ?? null;
  const g = gap.find((x) => x.period.key === 'late')?.corrResid ?? null;
  const vals = [c, g].filter((v): v is number => v !== null);
  if (!vals.length) return { verdict: 'none', score: null };
  const score = vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  const abs = Math.abs(score);
  return { verdict: abs >= INCR_USEFUL ? 'useful' : abs >= INCR_WEAK ? 'weak' : 'none', score };
}

export interface BtcNow {
  date: string;
  close: number;
  chg20: number | null;
  /** 最近 60 個配對日的相關 */
  rho60Btc: number | null;
  rho60Sox: number | null;
  /** 最近一次休市期間比特幣漲跌 */
  lastGap: GapRow | null;
  /** 下一個台股交易日前（目前週末／連假進行中）比特幣已漲跌多少：最後一個台股日那根收盤 → 最新一根 */
  pendingGap: { from: string; to: string; pct: number } | null;
}

export function btcNow(tw: readonly Bar[], btcRaw: readonly Bar[], days: readonly DayRow[], gaps: readonly GapRow[]): BtcNow | null {
  const last = btcRaw.at(-1);
  if (!last) return null;
  const i20 = lastIndexAtOrBefore(btcRaw, addDay(last[0], -20));
  const r60 = days.slice(-60);
  const lastTw = tw.at(-1)?.[0];
  let pendingGap: BtcNow['pendingGap'] = null;
  if (lastTw && last[0] > lastTw) {
    const a = lastIndexAtOrBefore(btcRaw, lastTw);
    if (a >= 0 && btcRaw[a]![0] === lastTw && a < btcRaw.length - 1)
      pendingGap = { from: lastTw, to: last[0], pct: pct(btcRaw[a]![4], last[4]) };
  }
  return {
    date: last[0],
    close: last[4],
    chg20: i20 >= 0 ? pct(btcRaw[i20]![4], last[4]) : null,
    rho60Btc: r60.length >= 60 ? pearson(r60.map((d) => d.btc), r60.map((d) => d.tw)) : null,
    rho60Sox: r60.length >= 60 ? pearson(r60.map((d) => d.sox), r60.map((d) => d.tw)) : null,
    lastGap: gaps.at(-1) ?? null,
    pendingGap,
  };
}

export interface BtcTwAnalysis {
  corr: CorrStat[];
  years: YearCorr[];
  gap: GapStat[];
  crashes: CrashRow[];
  crash: CrashGroupStat[];
  verdict: { verdict: BtcVerdict; score: number | null };
  now: BtcNow | null;
}

export function analyzeBtcTw(tw: readonly Bar[], btcRaw: readonly Bar[], soxRaw: readonly Bar[]): BtcTwAnalysis {
  const days = buildDayRows(tw, btcRaw, soxRaw);
  const gaps = buildGapRows(tw, btcRaw, days);
  const corr = corrStats(days);
  const gap = gapStats(gaps);
  const crashes = crashRows(tw, days);
  return {
    corr,
    years: yearlyCorr(days),
    gap,
    crashes,
    crash: BTC_PERIODS.filter((p) => p.key !== 'early').flatMap((p) => crashStats(tw, days, crashes, p)),
    verdict: verdictOf(corr, gap),
    now: btcNow(tw, btcRaw, days, gaps),
  };
}
