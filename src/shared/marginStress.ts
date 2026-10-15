/**
 * 融資斷頭監測：大盤融資維持率（上市，推算）× 加權指數。
 *
 * 狀態（每日）：
 *  - normal 正常
 *  - warn   警戒：維持率 < 160%，或近 5 日下降 > 15 個百分點
 *  - zone   斷頭區：維持率 < 140%（大量個股跌破 130% 追繳線；追繳後約 2 個營業日才處分，賣壓常延遲出現）
 *
 * 事件（每一「波」只觸發一次；維持率回到 160% 以上才算新的一波）：
 *  - below150：首次跌破 150%
 *  - below140：首次跌破 140%（進入斷頭區）
 *  - flush   ：斷頭潮——斷頭區內融資單日減幅（占餘額比）落在近 250 日最低 5%，且減幅 ≥ 0.5%
 *  - cleared ：清洗完成——近 20 日曾 < 140%，且維持率自波段低點回升 ≥ 5pp、
 *              近 3 日沒有斷頭潮、加權指數近 3 日未破波段低點
 *
 * 僅供參考：事件少（台股 2010 年起約十幾波），不計入總經分數。
 */
import type { Bar } from './types';

/** data/margin-history.json 每列：[日期, 維持率%（缺價格時 null）, 融資餘額（億）, 融資增減（億）] */
export type MarginHistoryRow = [date: string, ratio: number | null, balance: number, change: number];

export interface MarginHistoryFile {
  schemaVersion: 1;
  note: string;
  /** 回補目標（最早日期） */
  target: string;
  /** 已處理到的最早日期（含） */
  cursor: string;
  updatedAt: string;
  parseErrors: string[];
  rows: MarginHistoryRow[];
}

export type StressState = 'normal' | 'warn' | 'zone';
export type StressEventType = 'below150' | 'below140' | 'flush' | 'cleared';

export const WARN_RATIO = 160;
export const ZONE_RATIO = 140;
export const RESET_RATIO = 160;
export const WARN_DROP_5D = 15;
export const CLEAR_REBOUND = 5;
/** 斷頭潮另需單日減幅至少 0.5%（避免平淡期的小幅減少被當成極端值） */
export const FLUSH_MIN_DROP_PCT = -0.5;

export const EVENT_LABEL: Record<StressEventType, string> = {
  below150: '跌破 150%',
  below140: '跌破 140%（斷頭區）',
  flush: '斷頭潮',
  cleared: '清洗完成',
};
export const STATE_LABEL: Record<StressState, string> = { normal: '正常', warn: '警戒', zone: '斷頭區' };

/** 合併後每日資料：[日期, 加權收盤, 維持率, 融資餘額（億）, 融資增減（億）] */
export type StressRow = [date: string, taiex: number, ratio: number, balance: number, change: number];

export interface StressEvent {
  date: string;
  type: StressEventType;
  ratio: number;
  taiex: number;
  /** 之後 20／60 個交易日加權報酬（%）；資料不足為 null */
  ret20: number | null;
  ret60: number | null;
  /** 之後 60 個交易日內最大跌幅（%，負值） */
  mdd60: number | null;
}

export interface EventStats {
  n: number;
  avg20: number | null;
  avg60: number | null;
  win60: number | null;
  avgMdd60: number | null;
}

export interface MarginStressFile {
  schemaVersion: 1;
  generatedAt: string;
  start: string | null;
  end: string | null;
  /** 歷史回補進度（最早日期） */
  historyFrom: string | null;
  rows: StressRow[];
  states: StressState[];
  events: StressEvent[];
  eventStats: Record<StressEventType, EventStats>;
  stateStats: Record<StressState, EventStats & { pct: number }>;
  baseline: EventStats;
  latest: { date: string; state: StressState; ratio: number; drop5: number | null; taiex: number } | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 合併長期歷史與每日排程資料（同一天以每日排程為準），只保留有加權收盤與維持率的交易日 */
export function combineStressRows(
  history: MarginHistoryRow[],
  live: { ratio?: Bar[]; balance?: Bar[]; change?: Bar[] },
  taiex: Bar[],
): StressRow[] {
  const m = new Map<string, { ratio: number | null; balance: number | null; change: number | null }>();
  for (const [d, ratio, balance, change] of history) m.set(d, { ratio, balance, change });
  const put = (bars: Bar[] | undefined, key: 'ratio' | 'balance' | 'change') => {
    for (const b of bars ?? []) {
      const cur = m.get(b[0]) ?? { ratio: null, balance: null, change: null };
      cur[key] = b[4];
      m.set(b[0], cur);
    }
  };
  put(live.ratio, 'ratio');
  put(live.balance, 'balance');
  put(live.change, 'change');
  const out: StressRow[] = [];
  for (const b of taiex) {
    const x = m.get(b[0]);
    if (!x || x.ratio === null || !Number.isFinite(x.ratio)) continue;
    out.push([b[0], b[4], x.ratio, x.balance ?? NaN, x.change ?? NaN]);
  }
  return out;
}

/** 融資單日增減占前日餘額比（%） */
function changePct(rows: StressRow[], i: number): number | null {
  const [, , , bal, chg] = rows[i]!;
  const prev = bal - chg;
  return Number.isFinite(chg) && Number.isFinite(prev) && prev > 0 ? (chg / prev) * 100 : null;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

export function stateAt(rows: StressRow[], i: number): StressState {
  const ratio = rows[i]![2];
  if (ratio < ZONE_RATIO) return 'zone';
  const drop5 = i >= 5 ? rows[i - 5]![2] - ratio : 0;
  if (ratio < WARN_RATIO || drop5 > WARN_DROP_5D) return 'warn';
  return 'normal';
}

/** 斷頭潮判定用：近 250 日（至少 60 日）融資減幅第 5 百分位 */
function flushFlags(rows: StressRow[]): boolean[] {
  const pcts = rows.map((_, i) => changePct(rows, i));
  return rows.map((row, i) => {
    const p = pcts[i];
    if (row[2] >= ZONE_RATIO || p === null || p === undefined) return false;
    const win = pcts.slice(Math.max(0, i - 250), i).filter((v): v is number => v !== null);
    if (win.length < 60) return false;
    return p <= FLUSH_MIN_DROP_PCT && p <= percentile([...win].sort((a, b) => a - b), 0.05);
  });
}

function forward(rows: StressRow[], i: number, n: number): number | null {
  const j = i + n;
  if (j >= rows.length) return null;
  return r2((rows[j]![1] / rows[i]![1] - 1) * 100);
}

function mdd(rows: StressRow[], i: number, n: number): number | null {
  if (i + n >= rows.length) return null;
  let low = Infinity;
  for (let k = i + 1; k <= i + n; k++) low = Math.min(low, rows[k]![1]);
  return r2((low / rows[i]![1] - 1) * 100);
}

export function detectEvents(rows: StressRow[]): StressEvent[] {
  const flush = flushFlags(rows);
  const events: StressEvent[] = [];
  const fired = new Set<StressEventType>();
  let waveLowRatio = Infinity;
  let waveLowTaiexIdx = -1;
  let lastZoneIdx = -Infinity;
  let lastFlushIdx = -Infinity;
  const emit = (i: number, type: StressEventType) => {
    fired.add(type);
    events.push({
      date: rows[i]![0],
      type,
      ratio: rows[i]![2],
      taiex: rows[i]![1],
      ret20: forward(rows, i, 20),
      ret60: forward(rows, i, 60),
      mdd60: mdd(rows, i, 60),
    });
  };
  for (let i = 0; i < rows.length; i++) {
    const [, taiex, ratio] = rows[i]!;
    if (ratio >= RESET_RATIO) {
      fired.clear();
      waveLowRatio = Infinity;
      waveLowTaiexIdx = -1;
    }
    if (ratio < WARN_RATIO) {
      waveLowRatio = Math.min(waveLowRatio, ratio);
      if (waveLowTaiexIdx < 0 || taiex < rows[waveLowTaiexIdx]![1]) waveLowTaiexIdx = i;
    }
    if (ratio < 150 && !fired.has('below150')) emit(i, 'below150');
    if (ratio < ZONE_RATIO) {
      lastZoneIdx = i;
      if (!fired.has('below140')) emit(i, 'below140');
    }
    if (flush[i]) {
      lastFlushIdx = i;
      if (!fired.has('flush')) emit(i, 'flush');
    }
    if (
      fired.has('below140') &&
      !fired.has('cleared') &&
      i - lastZoneIdx <= 20 &&
      ratio - waveLowRatio >= CLEAR_REBOUND &&
      i - lastFlushIdx > 3 &&
      i - waveLowTaiexIdx >= 3
    ) {
      emit(i, 'cleared');
    }
  }
  return events;
}

function stats(list: { ret20: number | null; ret60: number | null; mdd60: number | null }[]): EventStats {
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const r60 = list.map((x) => x.ret60).filter((x): x is number => x !== null);
  return {
    n: list.length,
    avg20: avg(list.map((x) => x.ret20)),
    avg60: avg(list.map((x) => x.ret60)),
    win60: r60.length ? r2((r60.filter((x) => x > 0).length / r60.length) * 100) : null,
    avgMdd60: avg(list.map((x) => x.mdd60)),
  };
}

export function analyzeMarginStress(rows: StressRow[], historyFrom: string | null, now = new Date()): MarginStressFile {
  const states = rows.map((_, i) => stateAt(rows, i));
  const events = detectEvents(rows);
  const perDay = rows.map((_, i) => ({ ret20: forward(rows, i, 20), ret60: forward(rows, i, 60), mdd60: mdd(rows, i, 60) }));
  const types: StressEventType[] = ['below150', 'below140', 'flush', 'cleared'];
  const eventStats = Object.fromEntries(types.map((t) => [t, stats(events.filter((e) => e.type === t))])) as Record<
    StressEventType,
    EventStats
  >;
  const stateStats = Object.fromEntries(
    (['normal', 'warn', 'zone'] as const).map((s) => {
      const days = perDay.filter((_, i) => states[i] === s);
      return [s, { ...stats(days), pct: rows.length ? r2((days.length / rows.length) * 100) : 0 }];
    }),
  ) as MarginStressFile['stateStats'];
  const last = rows.length - 1;
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    start: rows[0]?.[0] ?? null,
    end: rows.at(-1)?.[0] ?? null,
    historyFrom,
    rows,
    states,
    events,
    eventStats,
    stateStats,
    baseline: stats(perDay),
    latest:
      last >= 0
        ? {
            date: rows[last]![0],
            state: states[last]!,
            ratio: rows[last]![2],
            drop5: last >= 5 ? r2(rows[last - 5]![2] - rows[last]![2]) : null,
            taiex: rows[last]![1],
          }
        : null,
  };
}
