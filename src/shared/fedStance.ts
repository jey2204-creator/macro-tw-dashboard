import { addDays } from './dates';
import { REAL_RATE_TIGHT, valueAtOrBefore } from './policyInflation';
import type { Point } from './timeseries';
import type { Bar } from './types';

/**
 * Fed 立場卡（政策利率面板，參考、不計分）：把「現在利率算緊還是鬆、市場押哪邊」收成三個數字。
 * 1. 實質政策利率＝Fed 上緣 − 核心 CPI 年增（面板原有，門檻沿用 0／+1pp）
 * 2. 泰勒法則缺口＝法則利率 − Fed 上緣（pp）。正＝Fed 比法則低（偏鬆、落後），負＝Fed 比法則高（偏緊）
 *    法則利率（Taylor 1993）＝ r* + π + 0.5 ×（π − 2）+ 0.5 × 產出缺口
 *    π＝核心 PCE 年增（Fed 2% 目標的尺）；r*＝2（原始論文的常數，主觀）；
 *    產出缺口以 Okun 法則換算＝2 ×（自然失業率 − 失業率），自然失業率用 CBO 估計（FRED NROU）
 * 3. 美債 2Y − Fed（面板原有，門檻 ±0.25pp＝一碼）
 * 門檻事先定、不依回測結果調整。
 */

export const TAYLOR_R_STAR = 2;
export const TAYLOR_TARGET = 2;
export const OKUN = 2;
/** 泰勒缺口門檻（pp）：四碼以上才算偏離 */
export const TAYLOR_BAND = 1;
/** 2Y − Fed 門檻（pp）：一碼 */
export const SPREAD_BAND = 0.25;
/** 月資料公布落後（天），與 backtest.ts PUBLICATION_LAG 一致 */
export const MONTHLY_LAG_DAYS = 45;

export type Lean = 'loose' | 'mid' | 'tight';
export type Bet = 'cut' | 'hold' | 'hike';

export const LEAN_TEXT: Record<Lean, string> = { loose: '偏鬆', mid: '中間', tight: '偏緊' };
export const LEAN_COLOR: Record<Lean, string> = { loose: '--lamp-yellowred', mid: '--lamp-yellowblue', tight: '--lamp-blue' };
export const BET_TEXT: Record<Bet, string> = { cut: '押降息', hold: '押不變', hike: '押升息' };
export const BET_COLOR: Record<Bet, string> = { cut: '--lamp-blue', hold: '--lamp-yellowblue', hike: '--lamp-yellowred' };

export function taylorRate(corePce: number, unrate: number, nrou: number): number {
  return TAYLOR_R_STAR + corePce + 0.5 * (corePce - TAYLOR_TARGET) + 0.5 * OKUN * (nrou - unrate);
}

export function realLean(real: number): Lean {
  return real < 0 ? 'loose' : real >= REAL_RATE_TIGHT ? 'tight' : 'mid';
}
/** gap＝法則利率 − Fed：≥ +1 Fed 偏鬆、≤ −1 Fed 偏緊 */
export function taylorLean(gap: number): Lean {
  return gap >= TAYLOR_BAND ? 'loose' : gap <= -TAYLOR_BAND ? 'tight' : 'mid';
}
export function marketBet(spread: number): Bet {
  return spread <= -SPREAD_BAND ? 'cut' : spread >= SPREAD_BAND ? 'hike' : 'hold';
}

export interface StanceInputs {
  /** Fed 政策利率（日，拼接後） */
  fed: readonly Point[];
  /** 核心 CPI 年增（月，月初日期） */
  coreCpi: readonly Point[];
  /** 核心 PCE 年增（月） */
  corePce: readonly Point[];
  /** 失業率（月） */
  unrate: readonly Point[];
  /** 自然失業率（季，季初日期） */
  nrou: readonly Point[];
  /** 美債 2Y（日） */
  us2y: readonly Point[];
}

export interface Stance {
  date: string;
  fed: number;
  real: number | null;
  realLean: Lean | null;
  coreCpi: number | null;
  taylor: number | null;
  taylorGap: number | null;
  taylorLean: Lean | null;
  corePce: number | null;
  corePceDate: string | null;
  unrate: number | null;
  nrou: number | null;
  us2y: number | null;
  spread: number | null;
  bet: Bet | null;
}

function pointAtOrBefore(pts: readonly Point[], date: string): Point | null {
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

/**
 * 判定日 date 的立場讀數。lagDays > 0 時月資料只用「月初日期 + lagDays ≤ date」的月份（回測用，避免偷看）；
 * 目前讀數用 lagDays = 0（資料檔裡有的就是已公布的）。自然失業率是 CBO 事先公布的估計，不加落後。
 */
export function stanceAt(inp: StanceInputs, date: string, lagDays = 0): Stance | null {
  const fed = valueAtOrBefore(inp.fed, date);
  if (fed === null) return null;
  const cut = lagDays > 0 ? addDays(date, -lagDays) : date;
  const cpi = valueAtOrBefore(inp.coreCpi, cut);
  const pce = pointAtOrBefore(inp.corePce, cut);
  const u = valueAtOrBefore(inp.unrate, cut);
  const n = valueAtOrBefore(inp.nrou, date);
  const y2 = valueAtOrBefore(inp.us2y, date);
  const real = cpi === null ? null : fed - cpi;
  const taylor = pce && u !== null && n !== null ? taylorRate(pce[1], u, n) : null;
  const gap = taylor === null ? null : taylor - fed;
  const spread = y2 === null ? null : y2 - fed;
  return {
    date,
    fed,
    real,
    realLean: real === null ? null : realLean(real),
    coreCpi: cpi,
    taylor,
    taylorGap: gap,
    taylorLean: gap === null ? null : taylorLean(gap),
    corePce: pce?.[1] ?? null,
    corePceDate: pce?.[0] ?? null,
    unrate: u,
    nrou: n,
    us2y: y2,
    spread,
    bet: spread === null ? null : marketBet(spread),
  };
}

/** 三個讀數合起來的一句話（不是訊號，只是把三格唸出來） */
export function stanceHeadline(s: Stance): string {
  const parts: string[] = [];
  if (s.realLean) parts.push(`實質利率${LEAN_TEXT[s.realLean]}`);
  if (s.taylorLean) parts.push(s.taylorLean === 'mid' ? '接近泰勒法則' : s.taylorLean === 'loose' ? '比泰勒法則鬆' : '比泰勒法則緊');
  if (s.bet) parts.push(`市場${BET_TEXT[s.bet]}`);
  return parts.join('、');
}

// ── 回測 ─────────────────────────────────────────────

export type StanceKey = 'real' | 'taylor' | 'spread';
export const HORIZON_DAYS = 365;

export interface StanceSample {
  date: string;
  stance: Stance;
  /** 之後 12 個月 Fed 利率變動（pp） */
  fedChg: number | null;
  /** 之後 12 個月指數報酬（%） */
  ret: Record<string, number | null>;
}

function closeAtOrBefore(bars: readonly Bar[], date: string): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]![0] <= date) {
      ans = bars[mid]![4];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 每月底取樣（判定日＝月底），月資料加公布落後；之後 12 個月的 Fed 變動與各指數報酬 */
export function stanceSamples(inp: StanceInputs, indices: Record<string, readonly Bar[]>, from = '1987-01-01'): StanceSample[] {
  const last = inp.fed.at(-1)?.[0];
  if (!last) return [];
  const out: StanceSample[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (;;) {
    const nextFirst = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const date = addDays(nextFirst, -1);
    if (date > last) break;
    const stance = stanceAt(inp, date, MONTHLY_LAG_DAYS);
    if (stance) {
      const end = addDays(date, HORIZON_DAYS);
      const fedEnd = end <= last ? valueAtOrBefore(inp.fed, end) : null;
      const ret: Record<string, number | null> = {};
      for (const [id, bars] of Object.entries(indices)) {
        const a = bars.length > 0 && bars[0]![0] <= date ? closeAtOrBefore(bars, date) : null;
        const b = bars.length > 0 && bars.at(-1)![0] >= end ? closeAtOrBefore(bars, end) : null;
        ret[id] = a !== null && b !== null && a > 0 ? (b / a - 1) * 100 : null;
      }
      out.push({ date, stance, fedChg: fedEnd === null ? null : fedEnd - stance.fed, ret });
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export interface StanceStat {
  key: StanceKey;
  group: Lean | Bet;
  label: string;
  /** 有「之後 12 個月 Fed 變動」的月數 */
  n: number;
  /** 平均 Fed 變動（pp） */
  fedChg: number | null;
  /** 之後 12 個月 Fed 升（≥ +0.25pp）／降（≤ −0.25pp）的月份比例（%） */
  hikePct: number | null;
  cutPct: number | null;
  /** 各指數之後 12 個月平均報酬（%）與樣本月數 */
  ret: Record<string, { mean: number | null; n: number }>;
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const GROUPS: { key: StanceKey; group: Lean | Bet; label: string; pick: (s: Stance) => boolean }[] = [
  { key: 'real', group: 'loose', label: '實質 < 0', pick: (s) => s.realLean === 'loose' },
  { key: 'real', group: 'mid', label: '實質 0～+1', pick: (s) => s.realLean === 'mid' },
  { key: 'real', group: 'tight', label: `實質 ≥ +${REAL_RATE_TIGHT}`, pick: (s) => s.realLean === 'tight' },
  { key: 'taylor', group: 'loose', label: `泰勒 ≥ +${TAYLOR_BAND} 偏鬆`, pick: (s) => s.taylorLean === 'loose' },
  { key: 'taylor', group: 'mid', label: `泰勒 ±${TAYLOR_BAND} 內`, pick: (s) => s.taylorLean === 'mid' },
  { key: 'taylor', group: 'tight', label: `泰勒 ≤ −${TAYLOR_BAND} 偏緊`, pick: (s) => s.taylorLean === 'tight' },
  { key: 'spread', group: 'hike', label: `2Y−Fed ≥ +${SPREAD_BAND} 押升`, pick: (s) => s.bet === 'hike' },
  { key: 'spread', group: 'hold', label: `2Y−Fed ±${SPREAD_BAND} 內`, pick: (s) => s.bet === 'hold' },
  { key: 'spread', group: 'cut', label: `2Y−Fed ≤ −${SPREAD_BAND} 押降`, pick: (s) => s.bet === 'cut' },
];

export function stanceStats(samples: readonly StanceSample[], indexIds: readonly string[]): StanceStat[] {
  return GROUPS.map((g) => {
    const rows = samples.filter((s) => g.pick(s.stance));
    const chg = rows.flatMap((r) => (r.fedChg === null ? [] : [r.fedChg]));
    const ret: StanceStat['ret'] = {};
    for (const id of indexIds) {
      const xs = rows.flatMap((r) => (r.ret[id] === null || r.ret[id] === undefined ? [] : [r.ret[id] as number]));
      ret[id] = { mean: mean(xs), n: xs.length };
    }
    return {
      key: g.key,
      group: g.group,
      label: g.label,
      n: chg.length,
      fedChg: mean(chg),
      hikePct: chg.length ? (chg.filter((c) => c >= 0.25).length / chg.length) * 100 : null,
      cutPct: chg.length ? (chg.filter((c) => c <= -0.25).length / chg.length) * 100 : null,
      ret,
    };
  });
}

/** 全部樣本的基準（不分組） */
export function stanceBaseline(samples: readonly StanceSample[], indexIds: readonly string[]): Omit<StanceStat, 'key' | 'group' | 'label'> {
  const chg = samples.flatMap((r) => (r.fedChg === null ? [] : [r.fedChg]));
  const ret: StanceStat['ret'] = {};
  for (const id of indexIds) {
    const xs = samples.flatMap((r) => (r.ret[id] === null || r.ret[id] === undefined ? [] : [r.ret[id] as number]));
    ret[id] = { mean: mean(xs), n: xs.length };
  }
  return {
    n: chg.length,
    fedChg: mean(chg),
    hikePct: chg.length ? (chg.filter((c) => c >= 0.25).length / chg.length) * 100 : null,
    cutPct: chg.length ? (chg.filter((c) => c <= -0.25).length / chg.length) * 100 : null,
    ret,
  };
}
