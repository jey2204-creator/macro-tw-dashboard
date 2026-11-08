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
import { addDays } from './dates';
import type { Bar } from './types';

/**
 * data/margin-history.json 每列（schemaVersion 2）：
 * [日期, 維持率%（缺價格時 null）, 融資餘額（億）, 融資增減（億）,
 *  上漲家數, 漲停家數, 下跌家數, 跌停家數, 持平家數, 漲跌家數來源（1＝證交所官方表、0＝逐檔推算）]
 * 漲跌家數無法取得時後 6 欄為 null。
 */
export type MarginHistoryRow = [
  date: string,
  ratio: number | null,
  balance: number,
  change: number,
  up?: number | null,
  upLimit?: number | null,
  down?: number | null,
  downLimit?: number | null,
  flat?: number | null,
  official?: 0 | 1 | null,
];

export interface MarginHistoryFile {
  schemaVersion: 2;
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
export type StressEventType = 'below150' | 'below140' | 'flush' | 'cleared' | 'delever' | 'caughtUp' | 'shortBan' | 'nsf' | 'sblSpike' | 'sblCover';
/** 政策事件（config/policy-events.json） */
export type PolicyEventType = 'shortBan' | 'nsf';
export interface PolicyEvent {
  /** 市場首個反應交易日（生效日或宣布後首個交易日）；非交易日則取其後第一個交易日 */
  date: string;
  announced?: string;
  type: PolicyEventType;
  note?: string;
}
export const EVENT_TYPES: StressEventType[] = ['below150', 'below140', 'flush', 'cleared', 'delever', 'caughtUp', 'shortBan', 'nsf', 'sblSpike', 'sblCover'];

export const WARN_RATIO = 160;
export const ZONE_RATIO = 140;
export const RESET_RATIO = 160;
export const WARN_DROP_5D = 15;
export const CLEAR_REBOUND = 5;
/** 斷頭潮另需單日減幅至少 0.5%（避免平淡期的小幅減少被當成極端值） */
export const FLUSH_MIN_DROP_PCT = -0.5;
/**
 * 融資大減（主動去槓桿）：不限斷頭區，單日減幅占餘額比落在近 250 日最低 2% 且 ≤ −2%；
 * 20 個交易日內只標一次（不用維持率的「波」，因為 160% 以上也會發生）。
 * 2010 起約 26 次（每年 1～2 次）；用 5%／−1% 會到 73 次，太常出現沒有提醒效果。
 */
export const DELEVER_MIN_DROP_PCT = -2;
export const DELEVER_PCTL = 0.02;
export const DELEVER_COOLDOWN = 20;
/**
 * 去槓桿追上大盤事件：指數自高點跌幅 ≥ 10% 且完成度由 < 1 回到 ≥ 1 的第一天；
 * 同一波只標一次，指數回到高點 5% 以內（完成度不計）才重新武裝。
 * 門檻用 5% 會有 50 次（小回檔融資本來就減得快，無提醒效果）；10%＋需曾 < 1 為 8 次（2010 起）。
 */
export const CAUGHT_UP_MIN_DD = 10;

export const EVENT_LABEL: Record<StressEventType, string> = {
  below150: '跌破 150%',
  below140: '跌破 140%（斷頭區）',
  flush: '斷頭潮',
  cleared: '清洗完成',
  delever: '融資大減（主動去槓桿）',
  caughtUp: '去槓桿追上大盤（完成度 ≥ 1）',
  shortBan: '限空令生效',
  nsf: '國安基金進場',
  sblSpike: '借券追空極端',
  sblCover: '借券回補極端',
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
  /** 政策事件的說明（措施內容） */
  note?: string;
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
  /** 借券賣出（上市，萬張）：[日期, 借券賣出餘額, 餘額增減, 當日賣出, 當日還券]；沒有資料時省略 */
  sbl?: SblRow[];
  latestSbl?: SblLatest | null;
}

/**
 * 借券賣出每日列（萬張）：[日期, 餘額, 餘額增減, 當日賣出, 當日還券, 20 日變化率%, 3 年 p95, 3 年 p05]
 * 後三欄資料不足時為 null。絕對張數逐年膨脹（2010 約 100 萬張 → 2026 約 1,800 萬張）不能跨年比，
 * 所以極端值用「20 日變化率」對「近 3 年（750 個交易日）同一變化率的分位數」判。
 */
export type SblRow = [
  date: string,
  balance: number,
  change: number,
  sell: number,
  ret: number,
  chg20: number | null,
  p95: number | null,
  p05: number | null,
  /** 借券餘額（TWT72U 上市合計，萬張；含已賣出與未賣出），沒資料為 null */
  lendBal: number | null,
  /** 當日借券／還券（借貸系統） */
  lend: number | null,
  lendRet: number | null,
];
/** 已借未賣（萬張）＝借券餘額 − 借券賣出餘額；任一缺值為 null */
export const sblUnsold = (r: SblRow): number | null => (r[8] === null ? null : r2(r[8] - r[1]));
export const SBL_CHG_DAYS = 20;
export const SBL_BAND_DAYS = 750;
/** 分位數視窗至少要有這麼多筆才算 */
export const SBL_BAND_MIN = 500;
export const SBL_COOLDOWN = 20;
export type SblState = 'spike' | 'cover' | 'normal';
export const SBL_STATE_LABEL: Record<SblState, string> = { spike: '追空極端', cover: '回補極端', normal: '正常' };

export function sblStateAt(r: SblRow): SblState | null {
  const [, , , , , chg20, p95, p05] = r;
  if (chg20 === null || p95 === null || p05 === null) return null;
  return chg20 > p95 ? 'spike' : chg20 < p05 ? 'cover' : 'normal';
}

/**
 * data/sbl-history.json 每列：[日期, 借券賣出餘額, 當日賣出, 當日還券]（萬張）
 * data/sbl-lend-history.json 每列：[日期, 借券餘額, 當日借券, 當日還券]（萬張）——同一結構、不同表
 */
export type SblHistoryRow = [date: string, balance: number, sell: number, ret: number];
export interface SblHistoryFile {
  schemaVersion: 1;
  note: string;
  target: string;
  cursor: string;
  updatedAt: string;
  parseErrors: string[];
  rows: SblHistoryRow[];
}

export interface SblLatest {
  date: string;
  /** 借券賣出餘額（萬張） */
  balance: number;
  /** 近 5 個交易日餘額增減（萬張）；資料不足為 null */
  chg5: number | null;
  /** 餘額連續增加（正）或減少（負）的交易日數 */
  streak: number;
  /** 餘額為近 N 個交易日（資料範圍內，最多 60）新高／新低 */
  hi60: boolean;
  lo60: boolean;
  /** 20 日變化率與 3 年分位帶；資料不足為 null */
  chg20: number | null;
  p95: number | null;
  p05: number | null;
  /** 20 日變化率在全部歷史中的百分位（0～100） */
  pctAll: number | null;
  state: SblState | null;
  /** 借券餘額與已借未賣（萬張）；沒資料為 null */
  lendBal: number | null;
  unsold: number | null;
  /** 已借未賣近 5 日增減 */
  unsoldChg5: number | null;
}

/** 合併借券賣出序列（萬張）：長期歷史 + 每日排程（同一天以每日排程為準）；增減＝與前一筆餘額之差（第一筆為 NaN） */
export function combineSblRows(
  live: { balance?: Bar[]; sell?: Bar[]; ret?: Bar[]; lendBal?: Bar[]; lend?: Bar[]; lendRet?: Bar[] },
  history: SblHistoryRow[] = [],
  lendHistory: SblHistoryRow[] = [],
): SblRow[] {
  const m = new Map<string, { balance: number; sell: number; ret: number }>();
  for (const [d, balance, sell, ret] of history) m.set(d, { balance, sell, ret });
  const sell = new Map((live.sell ?? []).map((b) => [b[0], b[4]] as const));
  const ret = new Map((live.ret ?? []).map((b) => [b[0], b[4]] as const));
  for (const b of live.balance ?? []) {
    if (!Number.isFinite(b[4])) continue;
    m.set(b[0], { balance: b[4], sell: sell.get(b[0]) ?? NaN, ret: ret.get(b[0]) ?? NaN });
  }
  // 借券餘額（借貸系統）：另一張表，日期以借券賣出為主、對得上才填
  const lendM = new Map<string, { bal: number; lend: number; ret: number }>();
  for (const [d, bal, lend, lret] of lendHistory) lendM.set(d, { bal, lend, ret: lret });
  const lend = new Map((live.lend ?? []).map((b) => [b[0], b[4]] as const));
  const lret = new Map((live.lendRet ?? []).map((b) => [b[0], b[4]] as const));
  for (const b of live.lendBal ?? []) {
    if (!Number.isFinite(b[4])) continue;
    lendM.set(b[0], { bal: b[4], lend: lend.get(b[0]) ?? NaN, ret: lret.get(b[0]) ?? NaN });
  }
  const out: SblRow[] = [];
  let prev: number | null = null;
  for (const d of [...m.keys()].sort()) {
    const x = m.get(d)!;
    const l = lendM.get(d);
    out.push([
      d,
      x.balance,
      prev === null ? NaN : r2(x.balance - prev),
      x.sell,
      x.ret,
      null,
      null,
      null,
      l ? l.bal : null,
      l && Number.isFinite(l.lend) ? l.lend : null,
      l && Number.isFinite(l.ret) ? l.ret : null,
    ]);
    prev = x.balance;
  }
  // 20 日變化率與近 3 年分位帶（不含當日）
  const chg: (number | null)[] = out.map((r, i) => (i >= SBL_CHG_DAYS && out[i - SBL_CHG_DAYS]![1] > 0 ? r2((r[1] / out[i - SBL_CHG_DAYS]![1] - 1) * 100) : null));
  const win: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const c = chg[i] ?? null;
    out[i]![5] = c;
    if (win.length >= SBL_BAND_MIN) {
      const sorted = [...win].sort((a, b) => a - b);
      out[i]![6] = r2(percentile(sorted, 0.95));
      out[i]![7] = r2(percentile(sorted, 0.05));
    }
    if (c !== null) {
      win.push(c);
      if (win.length > SBL_BAND_DAYS) win.shift();
    }
  }
  return out;
}

/** 借券事件：20 日變化率突破 3 年 p95（追空極端）／跌破 p05（回補極端），各自 20 日冷卻 */
export function sblEvents(rows: SblRow[]): { date: string; type: 'sblSpike' | 'sblCover' }[] {
  const ev: { date: string; type: 'sblSpike' | 'sblCover' }[] = [];
  let lastSpike = -Infinity;
  let lastCover = -Infinity;
  rows.forEach((r, i) => {
    const st = sblStateAt(r);
    if (st === 'spike' && i - lastSpike > SBL_COOLDOWN) {
      lastSpike = i;
      ev.push({ date: r[0], type: 'sblSpike' });
    } else if (st === 'cover' && i - lastCover > SBL_COOLDOWN) {
      lastCover = i;
      ev.push({ date: r[0], type: 'sblCover' });
    }
  });
  return ev;
}

export function summarizeSbl(rows: SblRow[]): SblLatest | null {
  const last = rows.at(-1);
  if (!last) return null;
  const n = rows.length;
  let streak = 0;
  for (let i = n - 1; i >= 1; i--) {
    const d = rows[i]![1] - rows[i - 1]![1];
    if (d === 0) break;
    const sign = d > 0 ? 1 : -1;
    if (streak === 0) streak = sign;
    else if (Math.sign(streak) !== sign) break;
    else streak += sign;
  }
  const win = rows.slice(Math.max(0, n - 60), n - 1).map((r) => r[1]);
  const all = rows.map((r) => r[5]).filter((v): v is number => v !== null);
  const c = last[5];
  return {
    date: last[0],
    balance: last[1],
    chg5: n > 5 ? r2(last[1] - rows[n - 6]![1]) : null,
    streak,
    hi60: win.length >= 5 && last[1] > Math.max(...win),
    lo60: win.length >= 5 && last[1] < Math.min(...win),
    chg20: c,
    p95: last[6],
    p05: last[7],
    pctAll: c !== null && all.length >= SBL_BAND_MIN ? Math.round((all.filter((v) => v < c).length / all.length) * 1000) / 10 : null,
    state: sblStateAt(last),
    lendBal: last[8],
    unsold: sblUnsold(last),
    unsoldChg5: n > 5 && sblUnsold(last) !== null && sblUnsold(rows[n - 6]!) !== null ? r2(sblUnsold(last)! - sblUnsold(rows[n - 6]!)!) : null,
  };
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

export function percentile(sorted: number[], p: number): number {
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

/** 融資大減判定：近 250 日（至少 60 日）減幅第 2 百分位，不限斷頭區 */
function deleverFlags(rows: StressRow[]): boolean[] {
  const pcts = rows.map((_, i) => changePct(rows, i));
  return rows.map((_, i) => {
    const p = pcts[i];
    if (p === null || p === undefined) return false;
    const win = pcts.slice(Math.max(0, i - 250), i).filter((v): v is number => v !== null);
    if (win.length < 60) return false;
    return p <= DELEVER_MIN_DROP_PCT && p <= percentile([...win].sort((a, b) => a - b), DELEVER_PCTL);
  });
}

/** 以第 2 欄（加權收盤）計算的列 */
export type PriceRow = readonly [string, number, ...unknown[]];

export function forward(rows: readonly PriceRow[], i: number, n: number): number | null {
  const j = i + n;
  if (j >= rows.length) return null;
  return r2((rows[j]![1] / rows[i]![1] - 1) * 100);
}

export function mdd(rows: readonly PriceRow[], i: number, n: number): number | null {
  if (i + n >= rows.length) return null;
  let low = Infinity;
  for (let k = i + 1; k <= i + n; k++) low = Math.min(low, rows[k]![1]);
  return r2((low / rows[i]![1] - 1) * 100);
}

export function detectEvents(rows: StressRow[], policy: PolicyEvent[] = [], sbl: SblRow[] = []): StressEvent[] {
  const flush = flushFlags(rows);
  const delever = deleverFlags(rows);
  const completion = completionSeries(rows);
  let caughtArmed = true;
  let caughtWasBehind = false;
  const events: StressEvent[] = [];
  const fired = new Set<StressEventType>();
  let waveLowRatio = Infinity;
  let waveLowTaiexIdx = -1;
  let lastZoneIdx = -Infinity;
  let lastFlushIdx = -Infinity;
  let lastDeleverIdx = -Infinity;
  const emit = (i: number, type: StressEventType, note?: string) => {
    fired.add(type);
    events.push({
      date: rows[i]![0],
      type,
      ratio: rows[i]![2],
      taiex: rows[i]![1],
      ret20: forward(rows, i, 20),
      ret60: forward(rows, i, 60),
      mdd60: mdd(rows, i, 60),
      ...(note ? { note } : {}),
    });
  };
  // 借券事件：以日期對到維持率列（借券與融資都是上市交易日，通常同一天）
  const idxByDate = new Map(rows.map((r, i) => [r[0], i] as const));
  const sblByIdx = new Map<number, ('sblSpike' | 'sblCover')[]>();
  for (const e of sblEvents(sbl)) {
    const i = idxByDate.get(e.date);
    if (i === undefined) continue;
    sblByIdx.set(i, [...(sblByIdx.get(i) ?? []), e.type]);
  }
  // 政策事件：取事件日當天或其後第一個交易日；資料範圍外（更早或尚未發生）略過
  const policyByIdx = new Map<number, PolicyEvent[]>();
  for (const p of policy) {
    const i = rows.findIndex((r) => r[0] >= p.date);
    // 事件日之後 7 天內沒有交易日（事件早於資料起點、或尚未發生）→ 略過
    if (i < 0 || rows[i]![0] > addDays(p.date, 7)) continue;
    policyByIdx.set(i, [...(policyByIdx.get(i) ?? []), p]);
  }
  for (let i = 0; i < rows.length; i++) {
    const [, taiex, ratio] = rows[i]!;
    if (delever[i] && i - lastDeleverIdx > DELEVER_COOLDOWN) {
      lastDeleverIdx = i;
      emit(i, 'delever');
    }
    const [, dd, , cr] = completion[i]!;
    if (cr === null) {
      caughtArmed = true;
      caughtWasBehind = false;
    } else {
      if (cr < COMPLETION_DONE) caughtWasBehind = true;
      if (caughtArmed && caughtWasBehind && dd <= -CAUGHT_UP_MIN_DD && cr >= COMPLETION_DONE) {
        caughtArmed = false;
        emit(i, 'caughtUp');
      }
    }
    for (const p of policyByIdx.get(i) ?? []) emit(i, p.type, p.note);
    for (const t of sblByIdx.get(i) ?? []) emit(i, t);
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

export function stats(list: { ret20: number | null; ret60: number | null; mdd60: number | null }[]): EventStats {
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

export function analyzeMarginStress(
  rows: StressRow[],
  historyFrom: string | null,
  now = new Date(),
  policy: PolicyEvent[] = [],
  sbl: SblRow[] = [],
): MarginStressFile {
  const states = rows.map((_, i) => stateAt(rows, i));
  const events = detectEvents(rows, policy, sbl);
  const perDay = rows.map((_, i) => ({ ret20: forward(rows, i, 20), ret60: forward(rows, i, 60), mdd60: mdd(rows, i, 60) }));
  const types = EVENT_TYPES;
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

/* ───────────── 去槓桿完成度 ───────────── */

/** 回看視窗（交易日）：指數高點與融資餘額高點都在近 N 個交易日內找 */
export const COMPLETION_LOOKBACK = 120;
/** 指數自高點回落未達此幅度（%）時不算完成度（小回檔沒有去槓桿可言） */
export const COMPLETION_MIN_DD = 5;
/** 完成度分級：< 0.6 清洗落後、0.6～1 進行中、≥ 1 追上大盤 */
export const COMPLETION_LAG = 0.6;
export const COMPLETION_DONE = 1;

export type CompletionGrade = 'lag' | 'mid' | 'done';
export const COMPLETION_LABEL: Record<CompletionGrade, string> = { lag: '清洗落後', mid: '進行中', done: '追上大盤' };

export interface Completion {
  /** 指數自近 N 日高點跌幅（%，≤ 0） */
  dd: number;
  peakDate: string;
  peak: number;
  /** 融資餘額自近 N 日高點減幅（%，≤ 0）；餘額缺值時 null */
  cut: number | null;
  balPeakDate: string | null;
  balPeak: number | null;
  /** 完成度＝融資減幅 ÷ 指數跌幅；指數回落 < 5% 或融資缺值時 null */
  ratio: number | null;
  grade: CompletionGrade | null;
}

export function completionGrade(ratio: number): CompletionGrade {
  return ratio < COMPLETION_LAG ? 'lag' : ratio < COMPLETION_DONE ? 'mid' : 'done';
}

/**
 * 去槓桿完成度：融資餘額自高點累計減幅 ÷ 指數自高點跌幅（兩者都在近 120 個交易日內找高點）。
 * 1.0 ＝ 融資清洗幅度追上大盤跌幅；2020-03、2025-04、2026-07 的 V 轉底都 ≥ 1.2，
 * 2024-08-05 當天只有 0.5（兩天急跌，隔天才追上）。≥ 1 不代表一定見底（2022 慢熊 7 月已 1.3 仍再跌）。
 */
export function completionAt(rows: readonly StressRow[], i: number, lookback = COMPLETION_LOOKBACK): Completion | null {
  const row = rows[i];
  if (!row) return null;
  const lo = Math.max(0, i - lookback);
  let pk = lo;
  let bk = -1;
  for (let k = lo; k <= i; k++) {
    const r = rows[k]!;
    if (r[1] > rows[pk]![1]) pk = k;
    if (Number.isFinite(r[3]) && (bk < 0 || r[3] > rows[bk]![3])) bk = k;
  }
  const peak = rows[pk]![1];
  const dd = r2((row[1] / peak - 1) * 100);
  const hasBal = bk >= 0 && Number.isFinite(row[3]);
  const balPeak = hasBal ? rows[bk]![3] : null;
  const cut = hasBal && balPeak ? r2((row[3] / balPeak - 1) * 100) : null;
  const ratio = cut !== null && dd <= -COMPLETION_MIN_DD ? r2(cut / dd) : null;
  return {
    dd,
    peakDate: rows[pk]![0],
    peak,
    cut,
    balPeakDate: hasBal ? rows[bk]![0] : null,
    balPeak,
    ratio,
    grade: ratio === null ? null : completionGrade(ratio),
  };
}

/** 每日完成度序列（畫圖用）：[日期, 指數跌幅%, 融資減幅%, 完成度] */
export function completionSeries(rows: readonly StressRow[], lookback = COMPLETION_LOOKBACK): [string, number, number | null, number | null][] {
  return rows.map((r, i) => {
    const c = completionAt(rows, i, lookback)!;
    return [r[0], c.dd, c.cut, c.ratio];
  });
}
