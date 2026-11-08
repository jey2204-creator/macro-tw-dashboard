import { pearson } from './crossMarket';
import { parseDate, toLocalDate } from './dates';
import type { Bar } from './types';

/**
 * 美期隔夜風向：台股開盤前（台北 08:00）看到的美股期貨「隔夜變動」，對當天加權有多少資訊。
 *
 * 時間切法（都用 Yahoo 60 分鐘 K，時間戳＝K 棒起點，整點）：
 *   美股現貨收盤 16:00 ET ＝ 起點 15:00 ET 那根的收盤
 *   台北 08:00      ＝ 起點 07:00 台北（23:00 UTC 前一日）那根的收盤；CME 夏令 20:00 ET／冬令 19:00 ET，兩季都有 K 棒
 *   台北 13:00      ＝ 起點 12:00 台北（04:00 UTC）那根的收盤（台股 13:30 收盤前最後一根整點）
 *
 *   隔夜 on  ＝ 08:00 台北 ÷ 上一個美股現貨收盤 − 1 → 美股收盤後、台股開盤前的新資訊（財報盤後、亞洲開盤）
 *   盤中 ss  ＝ 13:00 台北 ÷ 08:00 台北 − 1          → 與台股同時段，是「解釋」不是「預測」
 *
 * 加權：gap＝開盤 ÷ 昨收 − 1、day＝收盤 ÷ 昨收 − 1、oc＝收盤 ÷ 開盤 − 1。
 * 費半前一日報酬（美股現貨那天）用來做偏相關：美期隔夜扣掉「昨晚美股已經漲跌的部分」還剩多少。
 *
 * 參考、不計分。Yahoo 小時 K 只能回溯約 2 年，之後靠每日快照累積。
 */

export const USF_SYMBOLS = [
  { id: 'nq', symbol: 'NQ=F', name: '那斯達克 100 期貨', short: 'NQ', kind: 'equity' },
  { id: 'es', symbol: 'ES=F', name: 'S&P 500 期貨', short: 'ES', kind: 'equity' },
  { id: 'ym', symbol: 'YM=F', name: '道瓊期貨', short: 'YM', kind: 'equity' },
  { id: 'zn', symbol: 'ZN=F', name: '美債 10 年期貨', short: 'ZN', kind: 'bond' },
  { id: 'dx', symbol: 'DX=F', name: '美元指數期貨', short: 'DX', kind: 'fx' },
  { id: 'gc', symbol: 'GC=F', name: '黃金期貨', short: 'GC', kind: 'commodity' },
  { id: 'cl', symbol: 'CL=F', name: 'WTI 原油期貨', short: 'CL', kind: 'commodity' },
] as const;
export type UsfId = (typeof USF_SYMBOLS)[number]['id'];
export const USF_IDS = USF_SYMBOLS.map((s) => s.id) as UsfId[];

/** 主訊號：NQ 隔夜變動的判定門檻（%） */
export const USF_BULL_PCT = 0.4;
export const USF_BEAR_PCT = -0.4;
/** 配角警訊：美債期貨跌（殖利率升）、美元升 */
export const ZN_WARN_PCT = -0.3;
export const DX_WARN_PCT = 0.4;
/** 判定可用：|NQ 隔夜| ≥ 0.4% 的日子，加權開盤方向一致比例門檻與最少樣本 */
export const HIT_USABLE = 60;
export const HIT_MIN_N = 60;

export const BUCKETS: { key: string; label: string; lo: number; hi: number }[] = [
  { key: 'b1', label: '≤ −1%', lo: -Infinity, hi: -1 },
  { key: 'b2', label: '−1 ~ −0.4%', lo: -1, hi: USF_BEAR_PCT },
  { key: 'b3', label: '−0.4 ~ +0.4%', lo: USF_BEAR_PCT, hi: USF_BULL_PCT },
  { key: 'b4', label: '+0.4 ~ +1%', lo: USF_BULL_PCT, hi: 1 },
  { key: 'b5', label: '≥ +1%', lo: 1, hi: Infinity },
];

/** [UNIX 秒（K 棒起點）, 收盤] */
export type HourBar = [ts: number, close: number];

export interface UsfHourlyFile {
  schemaVersion: 1;
  generatedAt: string;
  bars: Partial<Record<UsfId, HourBar[]>>;
}

export type UsfVerdict = 'bull' | 'neutral' | 'bear';
export const VERDICT_TEXT: Record<UsfVerdict, string> = { bull: '偏多開局', neutral: '中性開局', bear: '偏空開局' };
export const VERDICT_COLOR: Record<UsfVerdict, string> = { bull: '--up', neutral: '--neutral', bear: '--down' };

/** 一個台股交易日（或今天尚未收盤）的美期讀數 */
export interface UsfRow {
  /** 台股日期 */
  date: string;
  /** 對應的美股現貨收盤日（ET 日期） */
  usDate: string;
  /** 隔夜變動 %（美股 16:00 ET → 台北 08:00） */
  on: Partial<Record<UsfId, number>>;
  /** 台股盤中變動 %（台北 08:00 → 13:00） */
  ss: Partial<Record<UsfId, number>>;
  /** 加權：開盤跳空、當日、開到收（%）；當天尚未收盤為 null */
  gap: number | null;
  day: number | null;
  oc: number | null;
  /** 費半前一日（usDate）報酬 % */
  sox: number | null;
  /** 休市期間：距上一個台股交易日的日曆天數（週一＝3） */
  calDays: number;
}

export interface Bucket {
  key: string;
  label: string;
  n: number;
  gap: number | null;
  day: number | null;
  oc: number | null;
  /** 加權開盤方向與 NQ 隔夜同向的比例 % */
  hit: number | null;
  /** 加權當日上漲比例 % */
  up: number | null;
}

export interface SymbolCorr {
  id: UsfId;
  n: number;
  /** 隔夜 vs 加權開盤跳空／當日／開到收 */
  gap: number | null;
  day: number | null;
  oc: number | null;
  /** 隔夜 vs 開盤跳空，扣掉費半前一日（偏相關） */
  gapExSox: number | null;
  /** 盤中 vs 加權開到收（同時段、解釋力） */
  session: number | null;
}

export interface YearCorr {
  year: string;
  n: number;
  gap: number | null;
  hit: number | null;
}

export interface UsfBacktest {
  start: string | null;
  end: string | null;
  n: number;
  buckets: Bucket[];
  corr: SymbolCorr[];
  yearly: YearCorr[];
  /** |NQ 隔夜| ≥ 0.4% 的日子：同向比例與樣本 */
  hit: number | null;
  hitN: number;
  usable: boolean;
}

export interface UsfLatest {
  date: string;
  usDate: string;
  /** 最新一根小時 K 的收盤時間（ISO） */
  asOf: string;
  on: Partial<Record<UsfId, number>>;
  /** 盤中：有 13:00 收盤就是 08:00→13:00，否則用最新一根（partial） */
  ss: Partial<Record<UsfId, number>>;
  ssPartial: boolean;
  /** 盤中最後一根 K 的台北整點（例如 11 ＝ 到 11:00） */
  ssToHour: number | null;
  verdict: UsfVerdict;
  warnings: string[];
  gap: number | null;
  day: number | null;
  /** 同分組歷史：加權開盤跳空平均、當日平均、同向比例 */
  bucket: Bucket | null;
}

export interface UsfFile {
  schemaVersion: 1;
  generatedAt: string;
  rows: UsfRow[];
  latest: UsfLatest | null;
  backtest: UsfBacktest;
}

const pct = (from: number, to: number) => (to / from - 1) * 100;
const TAIPEI = 'Asia/Taipei';
const ET = 'America/New_York';

const hourFmt = new Map<string, Intl.DateTimeFormat>();
/** UNIX 秒 → 指定時區的小時（0–23） */
export function localHour(ts: number, tz: string): number {
  let f = hourFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    hourFmt.set(tz, f);
  }
  return Number(f.format(new Date(ts * 1000)));
}

/** 台北日期 d 的 hh:00 起點 K 棒的 UNIX 秒 */
export function taipeiTs(d: string, hour: number): number {
  return parseDate(d) / 1000 - 8 * 3600 + hour * 3600;
}

/** 合併小時 K：同時間戳以新資料為準、遞增排序 */
export function mergeHourBars(prev: readonly HourBar[] | undefined, next: readonly HourBar[]): HourBar[] {
  const m = new Map<number, number>();
  for (const [t, c] of prev ?? []) m.set(t, c);
  for (const [t, c] of next) if (Number.isFinite(c) && c > 0) m.set(t, c);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

class HourIndex {
  private readonly ts: number[];
  private readonly close: number[];
  constructor(bars: readonly HourBar[]) {
    this.ts = bars.map((b) => b[0]);
    this.close = bars.map((b) => b[1]);
  }
  get length() {
    return this.ts.length;
  }
  /** 起點恰為 ts 的 K 棒收盤 */
  at(ts: number): number | null {
    const i = this.indexAtOrBefore(ts);
    return i >= 0 && this.ts[i] === ts ? this.close[i]! : null;
  }
  /** 起點 ≤ ts 的最後一根索引 */
  indexAtOrBefore(ts: number): number {
    let lo = 0;
    let hi = this.ts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= ts) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
  tsAt(i: number) {
    return this.ts[i]!;
  }
  closeAt(i: number) {
    return this.close[i]!;
  }
  /** 往前找起點小於 before、ET 整點為 hour 的 K 棒（美股現貨收盤 16:00 ＝ 起點 15:00）；最多回溯 maxDays 天 */
  lastAtEtHour(before: number, hour: number, maxDays = 5): { ts: number; close: number } | null {
    let i = this.indexAtOrBefore(before - 1);
    const floor = before - maxDays * 86_400;
    while (i >= 0 && this.ts[i]! >= floor) {
      if (localHour(this.ts[i]!, ET) === hour) return { ts: this.ts[i]!, close: this.close[i]! };
      i--;
    }
    return null;
  }
}

function byDate(bars: readonly Bar[]): Map<string, { i: number; bar: Bar }> {
  const m = new Map<string, { i: number; bar: Bar }>();
  bars.forEach((bar, i) => m.set(bar[0], { i, bar }));
  return m;
}

/** 每個台股交易日的隔夜／盤中讀數；taiex 的第一天沒有昨收不算 */
export function buildRows(hourly: UsfHourlyFile['bars'], taiex: readonly Bar[], sox: readonly Bar[]): UsfRow[] {
  const idx = new Map<UsfId, HourIndex>();
  for (const id of USF_IDS) if (hourly[id]?.length) idx.set(id, new HourIndex(hourly[id]!));
  const nq = idx.get('nq');
  if (!nq) return [];
  const soxBy = byDate(sox);
  const rows: UsfRow[] = [];
  for (let i = 1; i < taiex.length; i++) {
    const [d, o, , , c] = taiex[i]!;
    const prev = taiex[i - 1]!;
    const anchor = taipeiTs(d, 7);
    const open08 = nq.at(anchor);
    if (open08 === null) continue; // 小時資料還沒涵蓋這天
    const ref = nq.lastAtEtHour(anchor, 15);
    if (!ref) continue;
    const usDate = toLocalDate(ref.ts, ET);
    const on: Partial<Record<UsfId, number>> = {};
    const ss: Partial<Record<UsfId, number>> = {};
    for (const [id, h] of idx) {
      const a = h.at(anchor);
      const r = h.lastAtEtHour(anchor, 15);
      if (a !== null && r !== null && toLocalDate(r.ts, ET) === usDate) on[id] = pct(r.close, a);
      const s = h.at(taipeiTs(d, 12));
      if (a !== null && s !== null) ss[id] = pct(a, s);
    }
    if (on.nq === undefined) continue;
    const sx = soxBy.get(usDate);
    const soxRet = sx && sx.i > 0 ? pct(sox[sx.i - 1]![4], sx.bar[4]) : null;
    rows.push({
      date: d,
      usDate,
      on,
      ss,
      gap: pct(prev[4], o),
      day: pct(prev[4], c),
      oc: pct(o, c),
      sox: soxRet,
      calDays: Math.round((parseDate(d) - parseDate(prev[0])) / 86_400_000),
    });
  }
  return rows;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
const r2 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

/** 偏相關 r(xy|z) */
export function partialCorr(x: number[], y: number[], z: number[]): number | null {
  const rxy = pearson(x, y);
  const rxz = pearson(x, z);
  const ryz = pearson(y, z);
  if (rxy === null || rxz === null || ryz === null) return null;
  const den = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  return den > 1e-9 ? (rxy - rxz * ryz) / den : null;
}

export function bucketOf(v: number): string {
  return (BUCKETS.find((b) => v > b.lo && v <= b.hi) ?? BUCKETS[2]!).key;
}

export function bucketStats(rows: readonly UsfRow[]): Bucket[] {
  return BUCKETS.map((b) => {
    const rs = rows.filter((r) => r.on.nq !== undefined && r.gap !== null && bucketOf(r.on.nq) === b.key);
    const gaps = rs.map((r) => r.gap!);
    const days = rs.map((r) => r.day!);
    const ocs = rs.map((r) => r.oc!);
    const hits = rs.filter((r) => Math.sign(r.gap!) === Math.sign(r.on.nq!) && r.gap !== 0).length;
    return {
      key: b.key,
      label: b.label,
      n: rs.length,
      gap: r1(mean(gaps)),
      day: r1(mean(days)),
      oc: r1(mean(ocs)),
      hit: rs.length ? Math.round((hits / rs.length) * 100) : null,
      up: rs.length ? Math.round((days.filter((v) => v > 0).length / rs.length) * 100) : null,
    };
  });
}

export function symbolCorr(rows: readonly UsfRow[]): SymbolCorr[] {
  const done = rows.filter((r) => r.gap !== null);
  return USF_IDS.map((id) => {
    const rs = done.filter((r) => r.on[id] !== undefined);
    const x = rs.map((r) => r.on[id]!);
    const withSox = rs.filter((r) => r.sox !== null);
    const sr = rs.filter((r) => r.ss[id] !== undefined);
    return {
      id,
      n: rs.length,
      gap: r2(pearson(x, rs.map((r) => r.gap!))),
      day: r2(pearson(x, rs.map((r) => r.day!))),
      oc: r2(pearson(x, rs.map((r) => r.oc!))),
      gapExSox: r2(
        partialCorr(
          withSox.map((r) => r.on[id]!),
          withSox.map((r) => r.gap!),
          withSox.map((r) => r.sox!),
        ),
      ),
      session: r2(pearson(sr.map((r) => r.ss[id]!), sr.map((r) => r.oc!))),
    };
  }).filter((c) => c.n > 0);
}

export function yearlyCorr(rows: readonly UsfRow[]): YearCorr[] {
  const by = new Map<string, UsfRow[]>();
  for (const r of rows) if (r.gap !== null && r.on.nq !== undefined) (by.get(r.date.slice(0, 4)) ?? by.set(r.date.slice(0, 4), []).get(r.date.slice(0, 4))!).push(r);
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([year, rs]) => {
      const big = rs.filter((r) => Math.abs(r.on.nq!) >= USF_BULL_PCT);
      const hits = big.filter((r) => Math.sign(r.gap!) === Math.sign(r.on.nq!) && r.gap !== 0).length;
      return {
        year,
        n: rs.length,
        gap: r2(pearson(rs.map((r) => r.on.nq!), rs.map((r) => r.gap!))),
        hit: big.length ? Math.round((hits / big.length) * 100) : null,
      };
    });
}

export function backtest(rows: readonly UsfRow[]): UsfBacktest {
  const done = rows.filter((r) => r.gap !== null && r.on.nq !== undefined);
  const big = done.filter((r) => Math.abs(r.on.nq!) >= USF_BULL_PCT);
  const hits = big.filter((r) => Math.sign(r.gap!) === Math.sign(r.on.nq!) && r.gap !== 0).length;
  const hit = big.length ? Math.round((hits / big.length) * 100) : null;
  return {
    start: done[0]?.date ?? null,
    end: done.at(-1)?.date ?? null,
    n: done.length,
    buckets: bucketStats(done),
    corr: symbolCorr(done),
    yearly: yearlyCorr(done),
    hit,
    hitN: big.length,
    usable: hit !== null && hit >= HIT_USABLE && big.length >= HIT_MIN_N,
  };
}

export function verdictOf(nqOn: number): UsfVerdict {
  return nqOn >= USF_BULL_PCT ? 'bull' : nqOn <= USF_BEAR_PCT ? 'bear' : 'neutral';
}

export function warningsOf(on: Partial<Record<UsfId, number>>): string[] {
  const w: string[] = [];
  if (on.zn !== undefined && on.zn <= ZN_WARN_PCT) w.push(`美債期貨 ${on.zn.toFixed(2)}%（殖利率急升，壓抑高本益比科技股）`);
  if (on.dx !== undefined && on.dx >= DX_WARN_PCT) w.push(`美元期貨 +${on.dx.toFixed(2)}%（美元急升，不利新興市場）`);
  if (on.nq !== undefined && on.es !== undefined && Math.sign(on.nq) !== Math.sign(on.es) && Math.abs(on.nq - on.es) >= 0.5)
    w.push('NQ 與 ES 方向不一致（科技股獨立行情）');
  return w;
}

/**
 * 最新讀數：以小時資料裡最後一個「有 07:00 台北 K 棒」的台北日期為準（可以是今天、加權還沒收盤）。
 * 盤中：有 12:00 起點那根就用 08:00→13:00；否則用 08:00 之後最新一根（標 partial）。
 */
export function latestReading(hourly: UsfHourlyFile['bars'], rows: readonly UsfRow[], bt: UsfBacktest, now: Date): UsfLatest | null {
  const nqBars = hourly.nq;
  if (!nqBars?.length) return null;
  const nq = new HourIndex(nqBars);
  const nowSec = Math.floor(now.getTime() / 1000);
  // 從今天往前找最近一個有 07:00 K 棒且該 K 棒已收盤（08:00 已過）的台北日期
  let date: string | null = null;
  let d = toLocalDate(nowSec, TAIPEI);
  for (let k = 0; k < 7 && !date; k++) {
    const a = taipeiTs(d, 7);
    if (a + 3600 <= nowSec && nq.at(a) !== null) date = d;
    else d = toLocalDate(parseDate(d) / 1000 - 86_400, TAIPEI);
  }
  if (!date) return null;
  const anchor = taipeiTs(date, 7);
  const ref = nq.lastAtEtHour(anchor, 15);
  if (!ref) return null;
  const usDate = toLocalDate(ref.ts, ET);
  const on: Partial<Record<UsfId, number>> = {};
  const ss: Partial<Record<UsfId, number>> = {};
  let asOfTs = 0;
  let ssPartial = false;
  let ssToHour: number | null = null;
  for (const id of USF_IDS) {
    const bars = hourly[id];
    if (!bars?.length) continue;
    const h = new HourIndex(bars);
    const a = h.at(anchor);
    const r = h.lastAtEtHour(anchor, 15);
    if (a !== null && r && toLocalDate(r.ts, ET) === usDate) on[id] = pct(r.close, a);
    asOfTs = Math.max(asOfTs, h.tsAt(h.length - 1) + 3600);
    if (a === null) continue;
    const t12 = taipeiTs(date, 12);
    const s12 = t12 + 3600 <= nowSec ? h.at(t12) : null;
    if (s12 !== null) {
      ss[id] = pct(a, s12);
      if (id === 'nq') ssToHour = 13;
    } else {
      // 08:00 之後、今天 13:00 之前最新一根
      // 只用已收盤的 K 棒（起點 + 1 小時 ≤ 現在）
      const j = h.indexAtOrBefore(Math.min(nowSec - 3600, t12 - 1));
      if (j >= 0 && h.tsAt(j) > anchor) {
        ss[id] = pct(a, h.closeAt(j));
        if (id === 'nq') {
          ssPartial = true;
          ssToHour = localHour(h.tsAt(j), TAIPEI) + 1;
        }
      }
    }
  }
  if (on.nq === undefined) return null;
  const row = rows.find((r) => r.date === date) ?? null;
  const key = bucketOf(on.nq);
  return {
    date,
    usDate,
    asOf: new Date(asOfTs * 1000).toISOString(),
    on,
    ss,
    ssPartial,
    ssToHour,
    verdict: verdictOf(on.nq),
    warnings: warningsOf(on),
    gap: row?.gap ?? null,
    day: row?.day ?? null,
    bucket: bt.buckets.find((b) => b.key === key && b.n > 0) ?? null,
  };
}

export function analyzeUsFutures(hourly: UsfHourlyFile['bars'], taiex: readonly Bar[], sox: readonly Bar[], now = new Date()): UsfFile {
  const rows = buildRows(hourly, taiex, sox);
  const bt = backtest(rows);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    rows,
    latest: latestReading(hourly, rows, bt, now),
    backtest: bt,
  };
}
