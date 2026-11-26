import { addDays } from './dates';
import { MONTHLY_LAG_DAYS } from './fedStance';
import { valueAtOrBefore } from './policyInflation';
import type { Point } from './timeseries';
import type { Bar } from './types';

/**
 * 通膨預期與薪資卡（政策利率面板，參考、不計分）：通膨會不會「黏住」，Fed 看的三個前瞻讀數。
 * 1. 密大 1 年通膨預期（家庭問卷，FRED MICH）：≥ 4% 偏高、≤ 3% 穩定（1990～2019 多在 2.5～3.5%）
 * 2. 5Y5Y（債市隱含「5 年後的 5 年」平均通膨，FRED T5YIFR）：≥ 2.5% 偏高、≤ 2.0% 偏低（2% PCE 目標約對應 CPI 2.3～2.5%）
 * 3. 平均時薪年增（FRED CES0500000003）：≥ 4% 偏熱、≤ 3% 偏冷（2% 通膨＋生產力約 1～1.5% ≈ 3～3.5%）
 * 門檻事先定、不依回測結果調整。
 */
export const MICH_HIGH = 4;
export const MICH_LOW = 3;
export const BE_HIGH = 2.5;
export const BE_LOW = 2;
export const WAGE_HOT = 4;
export const WAGE_COLD = 3;

export type Level = 'low' | 'mid' | 'high';
export type ExpKey = 'mich' | 'be' | 'wage';

export const LEVEL_COLOR: Record<Level, string> = { low: '--lamp-blue', mid: '--lamp-yellowblue', high: '--lamp-yellowred' };
export const LEVEL_TEXT: Record<ExpKey, Record<Level, string>> = {
  mich: { low: '穩定', mid: '略高', high: '偏高' },
  be: { low: '偏低', mid: '穩定', high: '偏高' },
  wage: { low: '偏冷', mid: '相容', high: '偏熱' },
};

const band = (v: number, low: number, high: number): Level => (v >= high ? 'high' : v <= low ? 'low' : 'mid');
export const michLevel = (v: number) => band(v, MICH_LOW, MICH_HIGH);
export const beLevel = (v: number) => band(v, BE_LOW, BE_HIGH);
export const wageLevel = (v: number) => band(v, WAGE_COLD, WAGE_HOT);

export interface ExpInputs {
  /** 密大 1 年通膨預期（月，月初日期） */
  mich: readonly Point[];
  /** 5Y5Y（日） */
  be: readonly Point[];
  /** 平均時薪年增（月） */
  wage: readonly Point[];
  /** Fed 政策利率（日，拼接後） */
  fed: readonly Point[];
  /** 核心 CPI 年增（月） */
  coreCpi: readonly Point[];
}

export interface ExpReading {
  date: string;
  mich: number | null;
  michDate: string | null;
  michLevel: Level | null;
  /** 較 3 個月前（pp） */
  michChg3: number | null;
  be: number | null;
  beDate: string | null;
  beLevel: Level | null;
  /** 較 60 天前（pp） */
  beChg60: number | null;
  wage: number | null;
  wageDate: string | null;
  wageLevel: Level | null;
  wageChg3: number | null;
}

function indexAtOrBefore(pts: readonly Point[], date: string): number {
  let lo = 0;
  let hi = pts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]![0] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 判定日 date 的讀數。lagDays > 0 時月資料只用「月初日期 + lagDays ≤ date」的月份（回測用，避免偷看）。 */
export function expAt(inp: ExpInputs, date: string, lagDays = 0): ExpReading {
  const cut = lagDays > 0 ? addDays(date, -lagDays) : date;
  const mi = indexAtOrBefore(inp.mich, cut);
  const wi = indexAtOrBefore(inp.wage, cut);
  const bi = indexAtOrBefore(inp.be, date);
  const m = mi >= 0 ? inp.mich[mi]! : null;
  const w = wi >= 0 ? inp.wage[wi]! : null;
  const b = bi >= 0 ? inp.be[bi]! : null;
  const bPrev = b ? valueAtOrBefore(inp.be, addDays(b[0], -60)) : null;
  return {
    date,
    mich: m?.[1] ?? null,
    michDate: m?.[0] ?? null,
    michLevel: m ? michLevel(m[1]) : null,
    michChg3: m && mi >= 3 ? m[1] - inp.mich[mi - 3]![1] : null,
    be: b?.[1] ?? null,
    beDate: b?.[0] ?? null,
    beLevel: b ? beLevel(b[1]) : null,
    beChg60: b && bPrev !== null ? b[1] - bPrev : null,
    wage: w?.[1] ?? null,
    wageDate: w?.[0] ?? null,
    wageLevel: w ? wageLevel(w[1]) : null,
    wageChg3: w && wi >= 3 ? w[1] - inp.wage[wi - 3]![1] : null,
  };
}

/** 三格唸成一句（不是訊號） */
export function expHeadline(r: ExpReading): string {
  const parts: string[] = [];
  if (r.michLevel) parts.push(`家庭預期${LEVEL_TEXT.mich[r.michLevel]}`);
  if (r.beLevel) parts.push(`債市預期${LEVEL_TEXT.be[r.beLevel]}`);
  if (r.wageLevel) parts.push(`薪資${LEVEL_TEXT.wage[r.wageLevel]}`);
  return parts.join('、');
}

// ── 回測 ─────────────────────────────────────────────

export const EXP_HORIZON_DAYS = 365;

export interface ExpSample {
  date: string;
  reading: ExpReading;
  /** 之後 12 個月 Fed 利率變動（pp） */
  fedChg: number | null;
  /** 之後 12 個月核心 CPI 年增的變動（pp；兩端都用當時已公布的數字） */
  cpiChg: number | null;
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

/** 每月底取樣，月資料加公布落後；之後 12 個月 Fed 變動、核心 CPI 年增變動與各指數報酬 */
export function expSamples(inp: ExpInputs, indices: Record<string, readonly Bar[]>, from = '1987-01-01'): ExpSample[] {
  const last = inp.fed.at(-1)?.[0];
  if (!last) return [];
  const out: ExpSample[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  for (;;) {
    const nextFirst = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const date = addDays(nextFirst, -1);
    if (date > last) break;
    const fed = valueAtOrBefore(inp.fed, date);
    if (fed !== null) {
      const reading = expAt(inp, date, MONTHLY_LAG_DAYS);
      const end = addDays(date, EXP_HORIZON_DAYS);
      const done = end <= last;
      const fedEnd = done ? valueAtOrBefore(inp.fed, end) : null;
      const cpi0 = valueAtOrBefore(inp.coreCpi, addDays(date, -MONTHLY_LAG_DAYS));
      const cpi1 = done ? valueAtOrBefore(inp.coreCpi, addDays(end, -MONTHLY_LAG_DAYS)) : null;
      const ret: Record<string, number | null> = {};
      for (const [id, bars] of Object.entries(indices)) {
        const a = bars.length > 0 && bars[0]![0] <= date ? closeAtOrBefore(bars, date) : null;
        const b = bars.length > 0 && bars.at(-1)![0] >= end ? closeAtOrBefore(bars, end) : null;
        ret[id] = a !== null && b !== null && a > 0 ? (b / a - 1) * 100 : null;
      }
      out.push({ date, reading, fedChg: fedEnd === null ? null : fedEnd - fed, cpiChg: cpi0 !== null && cpi1 !== null ? cpi1 - cpi0 : null, ret });
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export interface ExpStat {
  key: ExpKey;
  group: Level;
  label: string;
  n: number;
  hikePct: number | null;
  cutPct: number | null;
  /** 之後 12 個月核心 CPI 年增平均變動（pp） */
  cpiChg: number | null;
  ret: Record<string, { mean: number | null; n: number }>;
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const GROUPS: { key: ExpKey; group: Level; label: string; pick: (r: ExpReading) => boolean }[] = [
  { key: 'mich', group: 'high', label: `密大 ≥ ${MICH_HIGH}%`, pick: (r) => r.michLevel === 'high' },
  { key: 'mich', group: 'mid', label: `密大 ${MICH_LOW}～${MICH_HIGH}%`, pick: (r) => r.michLevel === 'mid' },
  { key: 'mich', group: 'low', label: `密大 ≤ ${MICH_LOW}%`, pick: (r) => r.michLevel === 'low' },
  { key: 'be', group: 'high', label: `5Y5Y ≥ ${BE_HIGH}%`, pick: (r) => r.beLevel === 'high' },
  { key: 'be', group: 'mid', label: `5Y5Y ${BE_LOW}～${BE_HIGH}%`, pick: (r) => r.beLevel === 'mid' },
  { key: 'be', group: 'low', label: `5Y5Y ≤ ${BE_LOW}%`, pick: (r) => r.beLevel === 'low' },
  { key: 'wage', group: 'high', label: `時薪 ≥ ${WAGE_HOT}%`, pick: (r) => r.wageLevel === 'high' },
  { key: 'wage', group: 'mid', label: `時薪 ${WAGE_COLD}～${WAGE_HOT}%`, pick: (r) => r.wageLevel === 'mid' },
  { key: 'wage', group: 'low', label: `時薪 ≤ ${WAGE_COLD}%`, pick: (r) => r.wageLevel === 'low' },
];

function summarize(rows: readonly ExpSample[], indexIds: readonly string[]): Omit<ExpStat, 'key' | 'group' | 'label'> {
  const chg = rows.flatMap((r) => (r.fedChg === null ? [] : [r.fedChg]));
  const ret: ExpStat['ret'] = {};
  for (const id of indexIds) {
    const xs = rows.flatMap((r) => (r.ret[id] === null || r.ret[id] === undefined ? [] : [r.ret[id] as number]));
    ret[id] = { mean: mean(xs), n: xs.length };
  }
  return {
    n: chg.length,
    hikePct: chg.length ? (chg.filter((c) => c >= 0.25).length / chg.length) * 100 : null,
    cutPct: chg.length ? (chg.filter((c) => c <= -0.25).length / chg.length) * 100 : null,
    cpiChg: mean(rows.flatMap((r) => (r.fedChg === null || r.cpiChg === null ? [] : [r.cpiChg]))),
    ret,
  };
}

export function expStats(samples: readonly ExpSample[], indexIds: readonly string[]): ExpStat[] {
  return GROUPS.map((g) => ({ key: g.key, group: g.group, label: g.label, ...summarize(samples.filter((s) => g.pick(s.reading)), indexIds) }));
}

/** 每把尺各自的基準：只算那把尺有資料的月份（三把尺起點不同：1987／2003／2007） */
export function expBaselines(samples: readonly ExpSample[], indexIds: readonly string[]): Record<ExpKey, Omit<ExpStat, 'key' | 'group' | 'label'>> {
  return {
    mich: summarize(samples.filter((s) => s.reading.michLevel !== null), indexIds),
    be: summarize(samples.filter((s) => s.reading.beLevel !== null), indexIds),
    wage: summarize(samples.filter((s) => s.reading.wageLevel !== null), indexIds),
  };
}
