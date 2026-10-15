/**
 * 漲跌停家數監測：上市普通股漲停／跌停家數 × 加權指數。
 *
 * 跌停占比＝跌停家數 ÷（上漲＋下跌家數）。2015-06-01 漲跌幅由 7% 放寬為 10%，
 * 前後家數不能直接比較，因此「恐慌」用近 250 日百分位判斷，而不是固定家數。
 *
 * 恐慌日：跌停占比 ≥ 近 250 日第 98 百分位，且 ≥ 3%（避免平淡期的小波動）
 * 一波：從第一個恐慌日開始，連續 40 個交易日沒有新的恐慌日才結束；每種事件每波只標一次
 *  - panic     恐慌：本波第一個恐慌日
 *  - capitulate 投降：連續 2 日恐慌，或恐慌日當天融資維持率 < 140%
 *  - divergence 背離：加權收盤跌破本波恐慌以來低點，但跌停家數不到本波高峰的一半（賣壓衰竭）
 *  - stabilized 止跌：漲停 > 跌停連續 2 日，且加權收盤距本波低點已 ≥ 3 個交易日（3 日不破低）
 *
 * 僅供參考：不計入總經分數。
 */
import { forward, mdd, percentile, stats, type EventStats } from './marginStress';
import type { Bar } from './types';

/** [日期, 加權收盤, 漲停, 跌停, 上漲, 下跌, 融資維持率（無資料 null）] */
export type BreadthRow = [date: string, taiex: number, upLimit: number, downLimit: number, up: number, down: number, ratio: number | null];

export type BreadthEventType = 'panic' | 'capitulate' | 'divergence' | 'stabilized';

export const PANIC_PCTL = 0.98;
export const PANIC_MIN_PCT = 3;
export const EPISODE_GAP = 40;

export const BREADTH_EVENT_LABEL: Record<BreadthEventType, string> = {
  panic: '恐慌（跌停暴增）',
  capitulate: '投降（連續恐慌／遇斷頭區）',
  divergence: '背離（破低但跌停減半）',
  stabilized: '止跌（漲停＞跌停 2 日）',
};

export interface BreadthEvent {
  date: string;
  type: BreadthEventType;
  taiex: number;
  upLimit: number;
  downLimit: number;
  downPct: number;
  ret20: number | null;
  ret60: number | null;
  mdd60: number | null;
}

export interface BreadthStressFile {
  schemaVersion: 1;
  generatedAt: string;
  start: string | null;
  end: string | null;
  rows: BreadthRow[];
  /** 每日跌停占比（%） */
  downPct: number[];
  /** 每日是否為恐慌日 */
  panic: boolean[];
  /** 10 日上漲家數合計 ÷ 下跌家數合計 */
  adRatio10: (number | null)[];
  events: BreadthEvent[];
  eventStats: Record<BreadthEventType, EventStats>;
  /** 恐慌日 vs 非恐慌日 */
  dayStats: { panic: EventStats & { pct: number }; normal: EventStats & { pct: number } };
  baseline: EventStats;
  latest: {
    date: string;
    upLimit: number;
    downLimit: number;
    downPct: number;
    /** 今日跌停占比在近 250 日的百分位（0–100） */
    downPctile: number | null;
    adRatio10: number | null;
    panic: boolean;
    /** 目前是否在一波恐慌之中（最後恐慌日後 40 個交易日內） */
    inEpisode: boolean;
  } | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export interface BreadthHistoryRow {
  date: string;
  up: number;
  upLimit: number;
  down: number;
  downLimit: number;
}

/** 合併長期歷史與每日排程資料（同一天以每日排程為準），只保留有加權收盤與四項家數的交易日 */
export function combineBreadthRows(
  history: BreadthHistoryRow[],
  live: { upLimit?: Bar[]; downLimit?: Bar[]; up?: Bar[]; down?: Bar[] },
  taiex: Bar[],
  ratioByDate: Map<string, number>,
): BreadthRow[] {
  const m = new Map<string, { up?: number; upLimit?: number; down?: number; downLimit?: number }>();
  for (const h of history) m.set(h.date, { up: h.up, upLimit: h.upLimit, down: h.down, downLimit: h.downLimit });
  const put = (bars: Bar[] | undefined, key: 'up' | 'upLimit' | 'down' | 'downLimit') => {
    for (const b of bars ?? []) {
      const cur = m.get(b[0]) ?? {};
      cur[key] = b[4];
      m.set(b[0], cur);
    }
  };
  put(live.up, 'up');
  put(live.upLimit, 'upLimit');
  put(live.down, 'down');
  put(live.downLimit, 'downLimit');
  const out: BreadthRow[] = [];
  for (const b of taiex) {
    const x = m.get(b[0]);
    if (!x || [x.up, x.upLimit, x.down, x.downLimit].some((v) => v === undefined || !Number.isFinite(v))) continue;
    out.push([b[0], b[4], x.upLimit!, x.downLimit!, x.up!, x.down!, ratioByDate.get(b[0]) ?? null]);
  }
  return out;
}

export function downPctOf(r: BreadthRow): number {
  const n = r[4] + r[5];
  return n > 0 ? (r[3] / n) * 100 : 0;
}

/** 恐慌日旗標＋當日百分位 */
export function panicFlags(rows: BreadthRow[]): { panic: boolean[]; pctile: (number | null)[] } {
  const pct = rows.map(downPctOf);
  const panic: boolean[] = [];
  const pctile: (number | null)[] = [];
  for (let i = 0; i < rows.length; i++) {
    const win = pct.slice(Math.max(0, i - 250), i);
    if (win.length < 120) {
      panic.push(false);
      pctile.push(null);
      continue;
    }
    const sorted = [...win].sort((a, b) => a - b);
    const v = pct[i]!;
    pctile.push(r2((sorted.filter((x) => x < v).length / sorted.length) * 100));
    panic.push(v >= PANIC_MIN_PCT && v >= percentile(sorted, PANIC_PCTL));
  }
  return { panic, pctile };
}

export function adRatio(rows: BreadthRow[], n = 10): (number | null)[] {
  return rows.map((_, i) => {
    if (i + 1 < n) return null;
    let u = 0;
    let d = 0;
    for (let k = i - n + 1; k <= i; k++) {
      u += rows[k]![4];
      d += rows[k]![5];
    }
    return d > 0 ? r2(u / d) : null;
  });
}

export function detectBreadthEvents(rows: BreadthRow[], panic: boolean[]): BreadthEvent[] {
  const events: BreadthEvent[] = [];
  let fired = new Set<BreadthEventType>();
  let lastPanic = -Infinity;
  let peakDown = 0;
  let lowIdx = -1;
  const emit = (i: number, type: BreadthEventType) => {
    fired.add(type);
    const r = rows[i]!;
    events.push({
      date: r[0],
      type,
      taiex: r[1],
      upLimit: r[2],
      downLimit: r[3],
      downPct: r2(downPctOf(r)),
      ret20: forward(rows, i, 20),
      ret60: forward(rows, i, 60),
      mdd60: mdd(rows, i, 60),
    });
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const inEpisode = i - lastPanic <= EPISODE_GAP;
    if (!inEpisode && !panic[i]) continue;
    if (!inEpisode && panic[i]) {
      // 新的一波
      fired = new Set();
      peakDown = 0;
      lowIdx = i;
      emit(i, 'panic');
    }
    const prevLow = rows[lowIdx]![1];
    const newLow = r[1] < prevLow;
    if (panic[i]) {
      if (!fired.has('capitulate') && ((i > 0 && panic[i - 1]) || (r[6] !== null && r[6] < 140))) emit(i, 'capitulate');
      lastPanic = i;
    }
    if (
      !fired.has('divergence') &&
      newLow &&
      peakDown > 0 &&
      r[3] <= peakDown / 2
    )
      emit(i, 'divergence');
    peakDown = Math.max(peakDown, r[3]);
    if (newLow) lowIdx = i;
    if (
      !fired.has('stabilized') &&
      i > 0 &&
      r[2] > r[3] &&
      rows[i - 1]![2] > rows[i - 1]![3] &&
      i - lowIdx >= 3
    )
      emit(i, 'stabilized');
  }
  return events;
}

export function analyzeBreadth(rows: BreadthRow[], now = new Date()): BreadthStressFile {
  const { panic, pctile } = panicFlags(rows);
  const events = detectBreadthEvents(rows, panic);
  const ad = adRatio(rows);
  const perDay = rows.map((_, i) => ({ ret20: forward(rows, i, 20), ret60: forward(rows, i, 60), mdd60: mdd(rows, i, 60) }));
  const types: BreadthEventType[] = ['panic', 'capitulate', 'divergence', 'stabilized'];
  const pDays = perDay.filter((_, i) => panic[i]);
  const nDays = perDay.filter((_, i) => !panic[i]);
  const pct = (n: number) => (rows.length ? r2((n / rows.length) * 100) : 0);
  const last = rows.length - 1;
  let lastPanic = -1;
  panic.forEach((p, i) => p && (lastPanic = i));
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    start: rows[0]?.[0] ?? null,
    end: rows.at(-1)?.[0] ?? null,
    rows,
    downPct: rows.map((r) => r2(downPctOf(r))),
    panic,
    adRatio10: ad,
    events,
    eventStats: Object.fromEntries(types.map((t) => [t, stats(events.filter((e) => e.type === t))])) as Record<
      BreadthEventType,
      EventStats
    >,
    dayStats: { panic: { ...stats(pDays), pct: pct(pDays.length) }, normal: { ...stats(nDays), pct: pct(nDays.length) } },
    baseline: stats(perDay),
    latest:
      last >= 0
        ? {
            date: rows[last]![0],
            upLimit: rows[last]![2],
            downLimit: rows[last]![3],
            downPct: r2(downPctOf(rows[last]!)),
            downPctile: pctile[last] ?? null,
            adRatio10: ad[last] ?? null,
            panic: panic[last]!,
            inEpisode: lastPanic >= 0 && last - lastPanic <= EPISODE_GAP,
          }
        : null,
  };
}
