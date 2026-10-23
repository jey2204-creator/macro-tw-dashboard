import { addMonths, daysBetween, monthKey } from './dates';
import { valueAtOrBefore } from './policyInflation';
import type { Point } from './timeseries';
import type { Bar } from './types';

/**
 * Fed 利率階段 vs 美股（S&P 500）——政策利率面板第三格，參考、不計分。
 *
 * 階段（依「最後一次動作」與「距離上次動作多久」判定，事先定好、不依結果調整）：
 * - hike    升息期：最後一次動作是升息，且在 PAUSE_DAYS 內
 * - plateau 高原：升息後超過 PAUSE_DAYS 沒再動
 * - cut     降息期：最後一次動作是降息，且在 PAUSE_DAYS 內
 * - trough  谷底：降息後超過 PAUSE_DAYS 沒再動
 *
 * 要回答的問題不是「降息會不會漲」，而是「這次降息是哪一種」：
 * 衰退式（降息後 12 個月內失業率觸發 Sahm 規則）與保險式，S&P 之後一年的表現相反。
 */

export type FedPhase = 'hike' | 'plateau' | 'cut' | 'trough';

/** 超過這個天數沒動作就算「暫停」（6 個月） */
export const PAUSE_DAYS = 183;

export const PHASE_TEXT: Record<FedPhase, string> = {
  hike: '升息期',
  plateau: '高原（升息後暫停）',
  cut: '降息期',
  trough: '谷底（降息後暫停）',
};
export const PHASE_SHORT: Record<FedPhase, string> = { hike: '升息', plateau: '高原', cut: '降息', trough: '谷底' };
/** 顏色沿用景氣燈號五色（紅＝熱、藍＝冷），不隨紅漲綠跌切換 */
export const PHASE_COLOR: Record<FedPhase, string> = {
  hike: '--lamp-red',
  plateau: '--lamp-yellowred',
  cut: '--lamp-blue',
  trough: '--lamp-yellowblue',
};

export interface FedMove {
  date: string;
  /** bp（正＝升息） */
  bp: number;
  /** 方向與目前循環一致（反向的小動作在累計未達 CYCLE_FLIP_BP 前視為雜訊，不算） */
  trend: boolean;
  /** 新循環的第一次動作 */
  first: boolean;
}

/** 反方向動作累計達這個幅度（一碼）才算循環反轉；1980 年代 ±6～13bp 的來回微調不算 */
export const CYCLE_FLIP_BP = 25;

/**
 * 從政策利率日資料找出每次動作（利率變動 ≥ 1bp），並以「反向累計 ≥ 25bp 才反轉」判定循環：
 * 反轉確認時回頭把那段反向動作的第一筆標成新循環起點（確認最多落後 25bp，只影響事後標記）。
 */
export function fedMoves(fed: readonly Point[]): FedMove[] {
  const out: FedMove[] = [];
  for (let i = 1; i < fed.length; i++) {
    const bp = Math.round((fed[i]![1] - fed[i - 1]![1]) * 100);
    if (bp !== 0) out.push({ date: fed[i]![0], bp, trend: false, first: false });
  }
  let dir = 0;
  let pendingStart = -1;
  let pendingSum = 0;
  for (let k = 0; k < out.length; k++) {
    const m = out[k]!;
    const sign = Math.sign(m.bp);
    if (dir === 0) {
      dir = sign;
      m.trend = true;
      m.first = true;
    } else if (sign === dir) {
      m.trend = true;
      pendingStart = -1;
      pendingSum = 0;
    } else {
      if (pendingStart < 0) pendingStart = k;
      pendingSum += m.bp;
      if (Math.abs(pendingSum) >= CYCLE_FLIP_BP) {
        dir = sign;
        for (let j = pendingStart; j <= k; j++) out[j]!.trend = true;
        out[pendingStart]!.first = true;
        pendingStart = -1;
        pendingSum = 0;
      }
    }
  }
  return out;
}

export interface PhaseSegment {
  phase: FedPhase;
  /** 起訖日（含） */
  from: string;
  to: string;
}

/** 每個交易日的階段（以 S&P 的日期為準），再合併成連續區段；第一次動作之前的日子沒有階段 */
export function phaseSegments(fed: readonly Point[], dates: readonly string[]): PhaseSegment[] {
  const moves = fedMoves(fed).filter((m) => m.trend);
  const out: PhaseSegment[] = [];
  let k = -1;
  for (const d of dates) {
    while (k + 1 < moves.length && moves[k + 1]!.date <= d) k++;
    if (k < 0) continue;
    const m = moves[k]!;
    const paused = daysBetween(m.date, d) > PAUSE_DAYS;
    const phase: FedPhase = m.bp > 0 ? (paused ? 'plateau' : 'hike') : paused ? 'trough' : 'cut';
    const cur = out.at(-1);
    if (cur && cur.phase === phase) cur.to = d;
    else out.push({ phase, from: d, to: d });
  }
  return out;
}

/** 日期 → 階段的查表（給線段上色用） */
export function phaseAt(segments: readonly PhaseSegment[], date: string): FedPhase | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    if (date < s.from) hi = mid - 1;
    else if (date > s.to) lo = mid + 1;
    else return s.phase;
  }
  return null;
}

export interface PhaseRow extends PhaseSegment {
  months: number;
  /** S&P 區段內漲跌 %（區段最後收盤 ÷ 區段前一日收盤 − 1） */
  change: number | null;
  /** 年化 %（不足 3 個月不算） */
  annualized: number | null;
}

/** 每段階段的 S&P 漲跌（由新到舊） */
export function phaseRows(segments: readonly PhaseSegment[], spx: readonly Bar[]): PhaseRow[] {
  const idx = new Map(spx.map((b, i) => [b[0], i]));
  return segments
    .map((s): PhaseRow => {
      const i0 = idx.get(s.from);
      const i1 = idx.get(s.to);
      const days = daysBetween(s.from, s.to) + 1;
      const months = Math.max(1, Math.round(days / 30.44));
      let change: number | null = null;
      if (i0 !== undefined && i1 !== undefined && i0 > 0) change = (spx[i1]![4] / spx[i0 - 1]![4] - 1) * 100;
      const annualized = change !== null && days >= 90 ? (Math.pow(1 + change / 100, 365 / days) - 1) * 100 : null;
      return { ...s, months, change, annualized };
    })
    .reverse();
}

export interface PhaseStat {
  phase: FedPhase;
  segments: number;
  /** 時間占比 % */
  share: number;
  /** 各段年化報酬的平均（只算 ≥ 3 個月的段） */
  avgAnnualized: number | null;
  /** 各段為正的比例 % */
  upShare: number | null;
}

export function phaseStats(rows: readonly PhaseRow[]): PhaseStat[] {
  const total = rows.reduce((a, r) => a + daysBetween(r.from, r.to) + 1, 0);
  return (['hike', 'plateau', 'cut', 'trough'] as const).map((phase) => {
    const rs = rows.filter((r) => r.phase === phase);
    const days = rs.reduce((a, r) => a + daysBetween(r.from, r.to) + 1, 0);
    const ann = rs.map((r) => r.annualized).filter((v): v is number => v !== null);
    const ch = rs.map((r) => r.change).filter((v): v is number => v !== null);
    return {
      phase,
      segments: rs.length,
      share: total ? (days / total) * 100 : 0,
      avgAnnualized: ann.length ? ann.reduce((a, b) => a + b, 0) / ann.length : null,
      upShare: ch.length ? (ch.filter((v) => v > 0).length / ch.length) * 100 : null,
    };
  });
}

/** Sahm 規則：失業率 3 個月均值 − 過去 12 個月 3 個月均值最低點（pp）；≥ 0.5 視為衰退開始 */
export function sahmSeries(unrate: readonly Point[]): Point[] {
  const avg3: Point[] = [];
  for (let i = 2; i < unrate.length; i++) avg3.push([unrate[i]![0], (unrate[i]![1] + unrate[i - 1]![1] + unrate[i - 2]![1]) / 3]);
  const out: Point[] = [];
  for (let i = 12; i < avg3.length; i++) {
    let min = Infinity;
    for (let j = i - 12; j < i; j++) min = Math.min(min, avg3[j]![1]);
    out.push([avg3[i]![0], avg3[i]![1] - min]);
  }
  return out;
}
export const SAHM_TRIGGER = 0.5;

export interface CycleEvent {
  /** 'cut'＝新循環第一次降息，'hike'＝第一次升息 */
  kind: 'cut' | 'hike';
  date: string;
  bp: number;
  /** 當時 Fed 利率（動作後） */
  rate: number;
  /** S&P 之後 3／12 個月報酬 %（未滿為 null） */
  ret3m: number | null;
  ret12m: number | null;
  /** 之後 12 個月內最低收盤相對事件日 %（未滿 12 個月仍以已有資料算） */
  maxDrawdown: number | null;
  /** 事件後 12 個月內是否觸發 Sahm（衰退式）；資料不足為 null */
  recession: boolean | null;
  /** 事件後 12 個月內 Sahm 最高值（pp） */
  sahmMax: number | null;
}

/** 新循環的第一次降息／升息，以及 S&P 之後的表現 */
export function cycleEvents(fed: readonly Point[], spx: readonly Bar[], unrate: readonly Point[]): CycleEvent[] {
  const moves = fedMoves(fed).filter((m) => m.first);
  const sahm = sahmSeries(unrate);
  const lastSpx = spx.at(-1)?.[0] ?? '';
  const spxPts = spx.map((b) => [b[0], b[4]] as Point);
  const out: CycleEvent[] = [];
  for (const m of moves) {
    // 指數資料開始之前的事件不算（費半 1994、加權 1997 起）；事件日當天或之後第一個交易日
    if (m.date < (spx[0]?.[0] ?? '9999')) continue;
    const i0 = spx.findIndex((b) => b[0] >= m.date);
    if (i0 < 0) continue;
    const base = spx[i0]![4];
    const ret = (months: number): number | null => {
      const target = addMonths(m.date, months);
      if (target > lastSpx) return null;
      const p = valueAtOrBefore(spxPts, target);
      return p === null ? null : (p / base - 1) * 100;
    };
    const end12 = addMonths(m.date, 12);
    let low = base;
    for (let i = i0; i < spx.length && spx[i]![0] <= end12; i++) low = Math.min(low, spx[i]![4]);
    const sahmWin = sahm.filter((p) => p[0] >= `${monthKey(m.date)}-01` && p[0] <= end12);
    const complete = end12 <= (sahm.at(-1)?.[0] ?? '');
    const sahmMax = sahmWin.length ? Math.max(...sahmWin.map((p) => p[1])) : null;
    out.push({
      kind: m.bp < 0 ? 'cut' : 'hike',
      date: m.date,
      bp: m.bp,
      rate: valueAtOrBefore(fed, m.date) ?? NaN,
      ret3m: ret(3),
      ret12m: ret(12),
      maxDrawdown: (low / base - 1) * 100,
      recession: sahmMax === null ? null : sahmMax >= SAHM_TRIGGER ? true : complete ? false : null,
      sahmMax,
    });
  }
  return out.reverse();
}

export interface EventStat {
  label: string;
  n: number;
  avg3m: number | null;
  avg12m: number | null;
  up12m: number | null;
  avgDrawdown: number | null;
}

function stat(label: string, evs: readonly CycleEvent[]): EventStat {
  const r3 = evs.map((e) => e.ret3m).filter((v): v is number => v !== null);
  const r12 = evs.map((e) => e.ret12m).filter((v): v is number => v !== null);
  const dd = evs.filter((e) => e.ret12m !== null).map((e) => e.maxDrawdown).filter((v): v is number => v !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    label,
    n: evs.length,
    avg3m: mean(r3),
    avg12m: mean(r12),
    up12m: r12.length ? (r12.filter((v) => v > 0).length / r12.length) * 100 : null,
    avgDrawdown: mean(dd),
  };
}

/** 四組：首次降息（衰退式／保險式）、首次升息 */
export function eventStats(events: readonly CycleEvent[]): EventStat[] {
  const cuts = events.filter((e) => e.kind === 'cut');
  return [
    stat('首次降息・衰退式', cuts.filter((e) => e.recession === true)),
    stat('首次降息・保險式', cuts.filter((e) => e.recession === false)),
    stat('首次升息', events.filter((e) => e.kind === 'hike')),
  ];
}
