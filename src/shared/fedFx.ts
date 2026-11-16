import { addDays, addMonths, monthKey } from './dates';
import { PAUSE_DAYS, fedMoves, phaseAt, phaseSegments } from './fedEquity';
import { valueAtOrBefore } from './policyInflation';
import { rangeStart, type Point, type RangeKey } from './timeseries';
import type { Bar } from './types';

/**
 * Fed 升息 × 美元／台幣 vs 加權——政策利率面板第四格與回測表，參考、不計分。
 *
 * 要回答的問題：「升息 → 美元漲 → 台幣貶」這條鏈出現時，加權之後會不會大跌？
 * 門檻事先定好、不依結果調整：
 * - 匯率變化看過去 3 個月（FX_LOOKBACK_MONTHS）
 * - USD/TWD 升 ≥ 2%＝台幣貶、降 ≥ 2%＝台幣升、其餘持平（FX_MOVE_PCT；台幣 3 個月波動約 2～3%）
 * - 取樣：加權每月最後一個交易日（避免日資料高度重疊）；之後 3、12 個月報酬與 3 個月內最深收盤跌幅
 */
export const FX_LOOKBACK_MONTHS = 3;
export const FX_MOVE_PCT = 2;

export type FxGroup = 'weak' | 'flat' | 'strong';
export const FX_GROUP_TEXT: Record<FxGroup, string> = { weak: '台幣貶 ≥ 2%', flat: '台幣持平', strong: '台幣升 ≥ 2%' };

export function fxGroup(changePct: number): FxGroup {
  if (changePct >= FX_MOVE_PCT) return 'weak';
  if (changePct <= -FX_MOVE_PCT) return 'strong';
  return 'flat';
}

/** 收盤序列；legacy（FRED 舊資料）只取 primary 第一天之前的部分 */
export function spliceCloses(primary: readonly Bar[], legacy: readonly Bar[] = []): Point[] {
  const first = primary[0]?.[0] ?? '9999-12-31';
  const out: Point[] = legacy.filter((b) => b[0] < first).map((b) => [b[0], b[4]]);
  for (const b of primary) out.push([b[0], b[4]]);
  return out;
}

const pctChange = (pts: readonly Point[], from: string, to: string): number | null => {
  const a = valueAtOrBefore(pts, from);
  const b = valueAtOrBefore(pts, to);
  // 起點之前沒有資料（序列還沒開始）不算
  if (a === null || b === null || !pts.length || pts[0]![0] > from) return null;
  return (b / a - 1) * 100;
};

export interface HikeCycle {
  /** 第一次升息日 */
  from: string;
  /** 最後一次升息後 PAUSE_DAYS 天（升息期結束）；不超過下一個循環起點前一天與最新資料 */
  to: string;
  /** 仍在升息期內（to＝最新資料日） */
  ongoing: boolean;
  hikes: number;
  /** 累計升息 bp */
  bp: number;
  /** 期間漲跌 %（序列涵蓋不到起點為 null） */
  dxy: number | null;
  /** USD/TWD 漲跌 %（正＝台幣貶） */
  twd: number | null;
  index: number | null;
  /** 期間內加權自高點的最大收盤跌幅 %（負值） */
  drawdown: number | null;
}

/** 每個升息循環（第一次升息 → 升息期結束）期間，美元、台幣與指數各走了多少（由新到舊） */
export function hikeCycles(fed: readonly Point[], index: readonly Bar[], dxy: readonly Point[], twd: readonly Point[]): HikeCycle[] {
  const moves = fedMoves(fed).filter((m) => m.trend);
  const last = index.at(-1)?.[0];
  const first = index[0]?.[0];
  if (!last || !first) return [];
  const idxPts = index.map((b) => [b[0], b[4]] as Point);
  const out: HikeCycle[] = [];
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k]!;
    if (!m.first || m.bp <= 0) continue;
    let end = k;
    while (end + 1 < moves.length && !moves[end + 1]!.first) end++;
    const next = moves[end + 1];
    let to = addDays(moves[end]!.date, PAUSE_DAYS);
    if (next && next.date <= to) to = addDays(next.date, -1);
    const ongoing = to >= last;
    if (ongoing) to = last;
    if (m.date < first || m.date > last) continue;
    let peak = -Infinity;
    let dd = 0;
    for (const b of index) {
      if (b[0] < m.date) continue;
      if (b[0] > to) break;
      peak = Math.max(peak, b[4]);
      dd = Math.min(dd, (b[4] / peak - 1) * 100);
    }
    out.push({
      from: m.date,
      to,
      ongoing,
      hikes: end - k + 1,
      bp: moves.slice(k, end + 1).reduce((a, x) => a + x.bp, 0),
      dxy: pctChange(dxy, m.date, to),
      twd: pctChange(twd, m.date, to),
      index: pctChange(idxPts, m.date, to),
      drawdown: peak > 0 ? dd : null,
    });
  }
  return out.reverse();
}

export interface FxSample {
  date: string;
  hike: boolean;
  /** USD/TWD 過去 3 個月 %（正＝台幣貶） */
  twd3m: number;
  group: FxGroup;
  ret3m: number | null;
  ret12m: number | null;
  /** 之後 3 個月內最低收盤相對當日 %（未滿 3 個月為 null） */
  worst3m: number | null;
}

/** 加權每月最後一個交易日的樣本：當時台幣 3 個月變化、是否在升息期、之後表現 */
export function fxSamples(fed: readonly Point[], index: readonly Bar[], twd: readonly Point[]): FxSample[] {
  if (!index.length || !twd.length) return [];
  const segments = phaseSegments(fed, index.map((b) => b[0]));
  const idxPts = index.map((b) => [b[0], b[4]] as Point);
  const last = index.at(-1)![0];
  const out: FxSample[] = [];
  for (let i = 0; i < index.length - 1; i++) {
    const d = index[i]![0];
    // 月底＝下一根 K 棒已是下個月（最新一個月還沒走完，不取）
    if (monthKey(index[i + 1]![0]) === monthKey(d)) continue;
    const twd3m = pctChange(twd, addMonths(d, -FX_LOOKBACK_MONTHS), d);
    if (twd3m === null) continue;
    const base = index[i]![4];
    const fwd = (months: number): number | null => {
      const target = addMonths(d, months);
      if (target > last) return null;
      const p = valueAtOrBefore(idxPts, target);
      return p === null ? null : (p / base - 1) * 100;
    };
    const end3 = addMonths(d, 3);
    let worst: number | null = null;
    if (end3 <= last) {
      let low = base;
      for (let j = i + 1; j < index.length && index[j]![0] <= end3; j++) low = Math.min(low, index[j]![4]);
      worst = (low / base - 1) * 100;
    }
    out.push({ date: d, hike: phaseAt(segments, d) === 'hike', twd3m, group: fxGroup(twd3m), ret3m: fwd(3), ret12m: fwd(12), worst3m: worst });
  }
  return out;
}

export interface FxStat {
  group: FxGroup | 'all';
  n: number;
  avg3m: number | null;
  /** 之後 3 個月上漲的比例 % */
  up3m: number | null;
  avg12m: number | null;
  avgWorst3m: number | null;
  /** 之後 3 個月內曾跌超過 10% 的比例 % */
  crash3m: number | null;
}

/** 3 個月內收盤跌超過這個幅度算「大跌」 */
export const CRASH_PCT = -10;

function fxStat(group: FxStat['group'], ss: readonly FxSample[]): FxStat {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const r3 = ss.map((s) => s.ret3m).filter((v): v is number => v !== null);
  const r12 = ss.map((s) => s.ret12m).filter((v): v is number => v !== null);
  const w = ss.map((s) => s.worst3m).filter((v): v is number => v !== null);
  return {
    group,
    n: ss.length,
    avg3m: mean(r3),
    up3m: r3.length ? (r3.filter((v) => v > 0).length / r3.length) * 100 : null,
    avg12m: mean(r12),
    avgWorst3m: mean(w),
    crash3m: w.length ? (w.filter((v) => v <= CRASH_PCT).length / w.length) * 100 : null,
  };
}

const GROUPS: readonly FxGroup[] = ['weak', 'flat', 'strong'];

/** 升息期內、其他時期各四列（貶／持平／升／全部），用來分辨「是台幣貶的關係，還是升息的關係」 */
export function fxStats(samples: readonly FxSample[]): { hike: FxStat[]; other: FxStat[] } {
  const build = (ss: readonly FxSample[]) => [...GROUPS.map((g) => fxStat(g, ss.filter((s) => s.group === g))), fxStat('all', ss)];
  return { hike: build(samples.filter((s) => s.hike)), other: build(samples.filter((s) => !s.hike)) };
}

export interface FxPctLine {
  /** 基準日（區間內第一筆） */
  baseDate: string;
  base: number;
  /** 自基準日起累計 %（全部歷史都換算，往左拖曳時基準不變） */
  points: Point[];
  /** 最新一筆的累計 % */
  last: number;
}

/** 以時間區間起點為 0% 的累計漲跌幅線（兩條線共用同一個百分比刻度） */
export function fxPctLine(pts: readonly Point[], lastDate: string, range: RangeKey): FxPctLine | null {
  if (!pts.length) return null;
  const start = rangeStart(lastDate, range);
  const i = start ? pts.findIndex((p) => p[0] >= start) : 0;
  const b = pts[Math.max(0, i)]!;
  if (!(b[1] > 0)) return null;
  return {
    baseDate: b[0],
    base: b[1],
    points: pts.map(([d, v]) => [d, (v / b[1] - 1) * 100] as Point),
    last: (pts.at(-1)![1] / b[1] - 1) * 100,
  };
}
