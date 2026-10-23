import { addDays, addMonths, daysBetween } from './dates';
import { cycleEvents, fedMoves, sahmSeries, SAHM_TRIGGER, type CycleEvent } from './fedEquity';
import { FED_TARGET, valueAtOrBefore } from './policyInflation';
import type { Point } from './timeseries';
import type { Bar } from './types';

/**
 * 降息性質判定（政策利率面板的子區塊，參考、不計分）
 *
 * 問題不是「降息會不會漲」，而是「這次降息是哪一種」。事後的分類（fedEquity.cycleEvents）用降息後
 * 12 個月內失業率是否觸發 Sahm 規則，但那要一年後才知道；這裡用「降息當下看得到的資料」判：
 *
 *   就業  Sahm 值（失業率 3 月均 − 前 12 個月最低，pp）  ≥ 0.5 衰退、≥ 0.3 警戒
 *   信用  高收益債利差 HY OAS（bp）                      ≥ 600 衰退、≥ 400 警戒
 *   通膨  核心 CPI 年增 − 2% 目標（pp）                  > 1 通膨未解（降息＝停滯型風險）
 *
 *   衰退式      就業、信用兩個都到衰退門檻
 *   衰退警訊    其中一個到衰退門檻（2001-01 只有信用到、2024-09 只有就業到）
 *   預防性（警戒） 沒有到衰退門檻，但至少一個到警戒
 *   預防性      都正常
 *
 * 門檻是事先定的、不依結果調整：HY 600 而不是 500，因為 2011-10（900）、2016-02（890）、2022-07（600）
 * 都沒有衰退，利差單獨看太吵，所以要兩個一起到才叫衰退式。資料可得性：月資料加 45 天公布延遲、
 * 日資料加 1 天（與 backtest.ts 的 PUBLICATION_LAG 一致），避免前視偏誤；HY OAS 自 1996-12 起，
 * 之前的事件信用欄為「無資料」、只能看就業。
 */

export const SAHM_WATCH = 0.3;
export const HY_RECESSION_BP = 600;
export const HY_WATCH_BP = 400;
export const INFLATION_HOT_PP = 1;
export const MONTHLY_LAG_DAYS = 45;
export const DAILY_LAG_DAYS = 1;
/** 降息節奏：最近 90 天累計降息幅度 */
export const PACE_WINDOW_DAYS = 90;

export type Level = 'recession' | 'watch' | 'normal' | 'na';
export type Verdict = 'recession' | 'alert' | 'watch' | 'insurance';

export const LEVEL_TEXT: Record<Level, string> = { recession: '衰退', watch: '警戒', normal: '正常', na: '無資料' };
export const VERDICT_TEXT: Record<Verdict, string> = {
  recession: '衰退式',
  alert: '衰退警訊（2 項中 1 項）',
  watch: '預防性（有警戒）',
  insurance: '預防性',
};
export const VERDICT_SHORT: Record<Verdict, string> = { recession: '衰退式', alert: '衰退警訊', watch: '預防性・警戒', insurance: '預防性' };
/** 顏色沿用景氣燈號五色：衰退紅、警訊橙、警戒黃藍、預防藍 */
export const VERDICT_COLOR: Record<Verdict, string> = {
  recession: '--lamp-red',
  alert: '--lamp-yellowred',
  watch: '--lamp-yellowblue',
  insurance: '--lamp-blue',
};
export const LEVEL_COLOR: Record<Level, string> = {
  recession: '--lamp-red',
  watch: '--lamp-yellowred',
  normal: '--lamp-blue',
  na: '--text-3',
};

export function sahmLevel(v: number | null): Level {
  if (v === null) return 'na';
  if (v >= SAHM_TRIGGER) return 'recession';
  if (v >= SAHM_WATCH) return 'watch';
  return 'normal';
}
export function hyLevel(bp: number | null): Level {
  if (bp === null) return 'na';
  if (bp >= HY_RECESSION_BP) return 'recession';
  if (bp >= HY_WATCH_BP) return 'watch';
  return 'normal';
}

export interface Readings {
  /** 判定日 */
  date: string;
  /** Sahm 值與其資料月份（已扣公布延遲） */
  sahm: number | null;
  sahmDate: string | null;
  sahmLevel: Level;
  /** HY OAS（bp）與資料日、60 日變化（bp） */
  hy: number | null;
  hyDate: string | null;
  hyChg60: number | null;
  hyLevel: Level;
  /** 核心 CPI 年增 − 2%（pp）與資料月份 */
  coreGap: number | null;
  coreDate: string | null;
  inflationHot: boolean;
  /** 最近 90 天累計降息 bp（負值），與最近一次動作 */
  paceBp: number;
  lastMoveBp: number | null;
  lastMoveDate: string | null;
  verdict: Verdict;
  /** 衰退門檻到達數（就業、信用） */
  recessionHits: number;
}

/** 日期 ≤ date − lag 的最後一筆（含日期） */
function pointAsOf(pts: readonly Point[], date: string, lagDays: number): Point | null {
  const cutoff = addDays(date, -lagDays);
  let lo = 0;
  let hi = pts.length - 1;
  let ans: Point | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]![0] <= cutoff) {
      ans = pts[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function verdictOf(sahmL: Level, hyL: Level): { verdict: Verdict; hits: number } {
  const hits = (sahmL === 'recession' ? 1 : 0) + (hyL === 'recession' ? 1 : 0);
  if (hits === 2) return { verdict: 'recession', hits };
  if (hits === 1) return { verdict: 'alert', hits };
  if (sahmL === 'watch' || hyL === 'watch') return { verdict: 'watch', hits };
  return { verdict: 'insurance', hits };
}

export interface Inputs {
  fed: readonly Point[];
  unrate: readonly Point[];
  /** HY OAS，% */
  hy: readonly Point[];
  /** 核心 CPI 年增，% */
  coreCpi: readonly Point[];
}

/** 以「date 當天看得到的資料」算讀數與判定 */
export function readingsAt(inp: Inputs, date: string, sahm: readonly Point[] = sahmSeries(inp.unrate)): Readings {
  const s = pointAsOf(sahm, date, MONTHLY_LAG_DAYS);
  const h = pointAsOf(inp.hy, date, DAILY_LAG_DAYS);
  const hPrev = h ? pointAsOf(inp.hy, addDays(h[0], -60), 0) : null;
  const c = pointAsOf(inp.coreCpi, date, MONTHLY_LAG_DAYS);
  const sahmL = sahmLevel(s ? s[1] : null);
  const hyBp = h ? Math.round(h[1] * 100) : null;
  const hyL = hyLevel(hyBp);
  const coreGap = c ? c[1] - FED_TARGET : null;
  const moves = fedMoves(inp.fed).filter((m) => m.trend && m.date <= date);
  const last = moves.at(-1) ?? null;
  const paceBp = moves.filter((m) => m.bp < 0 && daysBetween(m.date, date) <= PACE_WINDOW_DAYS).reduce((a, m) => a + m.bp, 0);
  const { verdict, hits } = verdictOf(sahmL, hyL);
  return {
    date,
    sahm: s ? s[1] : null,
    sahmDate: s ? s[0] : null,
    sahmLevel: sahmL,
    hy: hyBp,
    hyDate: h ? h[0] : null,
    hyChg60: h && hPrev ? Math.round((h[1] - hPrev[1]) * 100) : null,
    hyLevel: hyL,
    coreGap,
    coreDate: c ? c[0] : null,
    inflationHot: coreGap !== null && Math.round(coreGap * 100) / 100 > INFLATION_HOT_PP,
    paceBp,
    lastMoveBp: last?.bp ?? null,
    lastMoveDate: last?.date ?? null,
    verdict,
    recessionHits: hits,
  };
}

export interface CutAssessment {
  event: CycleEvent;
  /** 降息當天的判定 */
  at: Readings;
  /** 降息後 12 個月內規則最早判「衰退式」的日期（沒有為 null） */
  recessionBy: string | null;
  /** 事後：降息後 12 個月內觸發 Sahm（來自 cycleEvents） */
  recession: boolean | null;
  /** 加權指數之後 12 個月報酬（1997 起才有） */
  taiex12m: number | null;
}

function ret12m(bars: readonly Bar[], date: string): number | null {
  if (!bars.length || date < bars[0]![0]) return null;
  const i0 = bars.findIndex((b) => b[0] >= date);
  if (i0 < 0) return null;
  const target = addMonths(date, 12);
  if (target > bars.at(-1)![0]) return null;
  const pts = bars.map((b) => [b[0], b[4]] as Point);
  const p = valueAtOrBefore(pts, target);
  return p === null ? null : (p / bars[i0]![4] - 1) * 100;
}

/** 歷次循環第一次降息：當時判定 vs 事後結果（由新到舊） */
export function assessCuts(inp: Inputs, spx: readonly Bar[], taiex: readonly Bar[]): CutAssessment[] {
  const sahm = sahmSeries(inp.unrate);
  const events = cycleEvents(inp.fed, spx, inp.unrate).filter((e) => e.kind === 'cut');
  return events.map((event) => {
    const at = readingsAt(inp, event.date, sahm);
    // 之後 12 個月逐月檢查（以月為步，資料本身是月／日）
    let recessionBy: string | null = null;
    const end = addMonths(event.date, 12);
    const lastKnown = Math.min(...[inp.hy.at(-1)?.[0], sahm.at(-1)?.[0]].filter((d): d is string => !!d).map((d) => Date.parse(d)));
    for (let k = 0; k <= 12 && recessionBy === null; k++) {
      const d = addMonths(event.date, k);
      if (d > end || Date.parse(d) > lastKnown + 86_400_000 * 60) break;
      if (readingsAt(inp, d, sahm).verdict === 'recession') recessionBy = d;
    }
    return { event, at, recessionBy, recession: event.recession, taiex12m: ret12m(taiex, event.date) };
  });
}

export interface VerdictStat {
  verdict: Verdict;
  n: number;
  /** 事後真的衰退的次數（已知者） */
  recessions: number;
  known: number;
  avgSpx12m: number | null;
  avgSpxDrawdown: number | null;
  avgTaiex12m: number | null;
  taiexN: number;
}

export function verdictStats(rows: readonly CutAssessment[]): VerdictStat[] {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return (['recession', 'alert', 'watch', 'insurance'] as const).map((verdict) => {
    const rs = rows.filter((r) => r.at.verdict === verdict);
    const known = rs.filter((r) => r.recession !== null);
    const spx = rs.map((r) => r.event.ret12m).filter((v): v is number => v !== null);
    const dd = rs.filter((r) => r.event.ret12m !== null).map((r) => r.event.maxDrawdown).filter((v): v is number => v !== null);
    const tw = rs.map((r) => r.taiex12m).filter((v): v is number => v !== null);
    return {
      verdict,
      n: rs.length,
      recessions: known.filter((r) => r.recession === true).length,
      known: known.length,
      avgSpx12m: mean(spx),
      avgSpxDrawdown: mean(dd),
      avgTaiex12m: mean(tw),
      taiexN: tw.length,
    };
  });
}
