import { addDays, addMonths, daysBetween } from './dates';
import { sma } from './timeseries';
import type { Bar } from './types';

/**
 * 航運景氣面板（參考、不計分）：SCFI 運價、貨櫃三雄月營收、還原股價。
 *
 * 1. 轉空訊號（目前狀態）：SCFI 連跌、SCFI 跌離高點、月營收月減、股價跌破季線且季線下彎；出現 2 項＝減碼訊號
 * 2. 回測（2005 起，還原股價＋月營收）：
 *    a. 營收年增率分組 → 營收「公布後」買進持有 3／6／12 個月的報酬（營收 M 月於 M+1 月 10 日前公布，以 11 日後第一個交易日進場，不偷看）
 *    b. 營收循環高點 vs 股價高點：股價領先幾個月見頂、營收見頂「公布時」股價已從高點回落多少
 *
 * SCFI 官方歷史要登入，免費只有最新兩期；種子檔只有稀疏歷史，所以運價只做「目前狀態」，不拿來回測。
 */

export const SHIP_STOCKS = [
  { key: 'emc', code: '2603', name: '長榮' },
  { key: 'ym', code: '2609', name: '陽明' },
  { key: 'wh', code: '2615', name: '萬海' },
] as const;
export type ShipKey = (typeof SHIP_STOCKS)[number]['key'];

/** 轉空門檻 */
export const SCFI_DOWN_WEEKS = 2;
export const SCFI_DD_PCT = -8;
export const SCFI_HIGH_WEEKS = 26;
export const REV_MOM_PCT = -10;
export const MA_SLOPE_DAYS = 20;
/** 回測起點（貨櫃三雄 2005 前月營收與股價皆在，但 2002–2004 年增率需前一年資料） */
export const BT_START = '2005-01-01';
/** 前瞻報酬（交易日） */
export const HORIZONS = [
  { key: 'm3', label: '3個月', days: 63 },
  { key: 'm6', label: '6個月', days: 126 },
  { key: 'm12', label: '12個月', days: 252 },
] as const;
export type HorizonKey = (typeof HORIZONS)[number]['key'];

export const YOY_BUCKETS = [
  { key: 'boom', label: '≥ +50%', lo: 50, hi: Infinity },
  { key: 'up', label: '+15 ~ +50%', lo: 15, hi: 50 },
  { key: 'flat', label: '−15 ~ +15%', lo: -15, hi: 15 },
  { key: 'down', label: '−40 ~ −15%', lo: -40, hi: -15 },
  { key: 'bust', label: '≤ −40%', lo: -Infinity, hi: -40 },
] as const;

const pct = (a: number, b: number) => (b / a - 1) * 100;
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs: readonly number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** 日期 ≤ d 的最後一根索引；沒有則 −1 */
export function idxAtOrBefore(bars: readonly Bar[], d: string): number {
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

/** 日期 ≥ d 的第一根索引；沒有則 −1 */
export function idxAtOrAfter(bars: readonly Bar[], d: string): number {
  const i = idxAtOrBefore(bars, d);
  if (i >= 0 && bars[i]![0] === d) return i;
  return i + 1 < bars.length ? i + 1 : -1;
}

// ───────────────────────── 目前狀態 ─────────────────────────

export interface ScfiState {
  date: string;
  value: number;
  /** 上一期 */
  prevDate: string | null;
  wow: number | null;
  /** 約 4 週前（≤ 35 天內最接近 28 天前的一期） */
  chg4w: number | null;
  /** 連續下跌週數（含本期） */
  downStreak: number;
  /** 連續上漲週數（含本期） */
  upStreak: number;
  /** 近 26 週高點 */
  high: number;
  highDate: string;
  ddFromHigh: number;
  /** 26 週內實際有幾期（種子稀疏時會少） */
  nWeeks: number;
}

export function scfiState(scfi: readonly Bar[]): ScfiState | null {
  const last = scfi.at(-1);
  if (!last) return null;
  const prev = scfi.length >= 2 ? scfi.at(-2)! : null;
  // 只把間隔 ≤ 10 天的相鄰兩期算「連續」（種子稀疏處不算週變化）
  const weekly = (a: Bar, b: Bar) => daysBetween(a[0], b[0]) <= 10;
  let downStreak = 0;
  let upStreak = 0;
  for (let i = scfi.length - 1; i > 0; i--) {
    if (!weekly(scfi[i - 1]!, scfi[i]!)) break;
    const d = scfi[i]![4] - scfi[i - 1]![4];
    if (d < 0 && upStreak === 0) downStreak++;
    else if (d > 0 && downStreak === 0) upStreak++;
    else break;
  }
  const from = addDays(last[0], -7 * SCFI_HIGH_WEEKS);
  const win = scfi.filter((b) => b[0] >= from);
  let hi = win[0]!;
  for (const b of win) if (b[4] >= hi[4]) hi = b;
  const target = addDays(last[0], -28);
  let ref: Bar | null = null;
  for (const b of scfi) {
    if (b[0] > target) break;
    if (daysBetween(b[0], last[0]) <= 35) ref = b;
  }
  return {
    date: last[0],
    value: last[4],
    prevDate: prev && weekly(prev, last) ? prev[0] : null,
    wow: prev && weekly(prev, last) ? pct(prev[4], last[4]) : null,
    chg4w: ref ? pct(ref[4], last[4]) : null,
    downStreak,
    upStreak,
    high: hi[4],
    highDate: hi[0],
    ddFromHigh: pct(hi[4], last[4]),
    nWeeks: win.length,
  };
}

export interface RevState {
  /** 營收所屬月份（YYYY-MM） */
  month: string;
  value: number;
  mom: number | null;
  yoy: number | null;
  /** 近 3 個月合計年增率 */
  yoy3: number | null;
  /** 近 3 個月平均是近 24 個月最高 */
  atHigh24: boolean;
  /** 近 3 個月平均距 24 個月高點 % */
  fromHigh24: number | null;
}

/** 月營收序列（日期＝月份 1 日）→ 每月的年增率、3 個月平均 */
export interface RevRow {
  date: string;
  value: number;
  yoy: number | null;
  avg3: number | null;
  yoy3: number | null;
  /** 3 個月平均相對近 24 個月（含本月）最高的 % */
  fromHigh24: number | null;
}

export function revRows(rev: readonly Bar[]): RevRow[] {
  const byDate = new Map(rev.map((b) => [b[0], b[4]]));
  const rows: RevRow[] = [];
  for (let i = 0; i < rev.length; i++) {
    const [d, , , , v] = rev[i]!;
    const ly = byDate.get(addMonths(d, -12));
    const last3 = [0, 1, 2].map((k) => byDate.get(addMonths(d, -k)));
    const prev3 = [0, 1, 2].map((k) => byDate.get(addMonths(d, -12 - k)));
    const sum = (xs: (number | undefined)[]) => (xs.every((x) => x !== undefined) ? xs.reduce<number>((s, x) => s + x!, 0) : null);
    const s3 = sum(last3);
    const p3 = sum(prev3);
    rows.push({ date: d, value: v, yoy: ly ? pct(ly, v) : null, avg3: s3 === null ? null : s3 / 3, yoy3: s3 !== null && p3 ? pct(p3, s3) : null, fromHigh24: null });
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.avg3 === null) continue;
    let hi = -Infinity;
    for (let k = Math.max(0, i - 23); k <= i; k++) if (rows[k]!.avg3 !== null) hi = Math.max(hi, rows[k]!.avg3!);
    r.fromHigh24 = Number.isFinite(hi) ? pct(hi, r.avg3) : null;
  }
  return rows;
}

export function revState(rows: readonly RevRow[]): RevState | null {
  const r = rows.at(-1);
  if (!r) return null;
  const p = rows.at(-2);
  return {
    month: r.date.slice(0, 7),
    value: r.value,
    mom: p && addMonths(p.date, 1) === r.date ? pct(p.value, r.value) : null,
    yoy: r.yoy,
    yoy3: r.yoy3,
    atHigh24: r.fromHigh24 !== null && r.fromHigh24 >= -0.0001,
    fromHigh24: r.fromHigh24,
  };
}

export interface StockState {
  date: string;
  close: number;
  ma60: number | null;
  ma240: number | null;
  /** MA60 與 20 個交易日前比 % */
  ma60Slope: number | null;
  /** 近 1 年高點與距離 */
  high252: number;
  high252Date: string;
  ddFromHigh: number;
}

export function stockState(px: readonly Bar[]): StockState | null {
  const last = px.at(-1);
  if (!last) return null;
  const closes = px.map((b) => b[4]);
  const m60 = sma(closes, 60);
  const m240 = sma(closes, 240);
  const n = closes.length - 1;
  const a = m60[n] ?? null;
  const b = n - MA_SLOPE_DAYS >= 0 ? (m60[n - MA_SLOPE_DAYS] ?? null) : null;
  let hi = Math.max(0, n - 251);
  for (let i = Math.max(0, n - 251); i <= n; i++) if (closes[i]! >= closes[hi]!) hi = i;
  return {
    date: last[0],
    close: last[4],
    ma60: a,
    ma240: m240[n] ?? null,
    ma60Slope: a !== null && b !== null ? pct(b, a) : null,
    high252: closes[hi]!,
    high252Date: px[hi]![0],
    ddFromHigh: pct(closes[hi]!, last[4]),
  };
}

export type SigKey = 'scfiDown' | 'scfiDd' | 'revMom' | 'belowMa60';
export interface Signal {
  key: SigKey;
  label: string;
  /** null＝資料不足無法判斷 */
  on: boolean | null;
  detail: string;
}

const f1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);

export function signals(s: ScfiState | null, r: RevState | null, k: StockState | null): Signal[] {
  return [
    {
      key: 'scfiDown',
      label: `SCFI 連跌 ≥ ${SCFI_DOWN_WEEKS} 週`,
      on: s ? s.downStreak >= SCFI_DOWN_WEEKS : null,
      detail: !s ? '無資料' : s.downStreak > 0 ? `連跌 ${s.downStreak} 週（本週 ${f1(s.wow)}）` : s.upStreak > 0 ? `連漲 ${s.upStreak} 週（本週 ${f1(s.wow)}）` : `本週 ${f1(s.wow)}`,
    },
    {
      key: 'scfiDd',
      label: `SCFI 距 ${SCFI_HIGH_WEEKS} 週高點 ≤ ${SCFI_DD_PCT}%`,
      on: s ? s.ddFromHigh <= SCFI_DD_PCT : null,
      detail: !s ? '無資料' : `${f1(s.ddFromHigh)}（高點 ${Math.round(s.high).toLocaleString('en-US')}，${s.highDate.slice(5).replace('-', '/')}）`,
    },
    {
      key: 'revMom',
      label: `月營收月減 ≥ ${Math.abs(REV_MOM_PCT)}%`,
      on: r?.mom == null ? null : r.mom <= REV_MOM_PCT,
      detail: !r ? '無資料' : `${Number(r.month.slice(5))} 月 ${r.value.toFixed(1)} 億，月 ${f1(r.mom)}、年 ${f1(r.yoy)}`,
    },
    {
      key: 'belowMa60',
      label: '股價跌破季線且季線下彎',
      on: k?.ma60 == null || k.ma60Slope === null ? null : k.close < k.ma60 && k.ma60Slope < 0,
      detail:
        !k || k.ma60 === null
          ? '無資料'
          : `收盤 ${k.close.toFixed(1)}，季線 ${k.ma60.toFixed(1)}（乖離 ${f1(pct(k.ma60, k.close))}，${MA_SLOPE_DAYS} 日 ${k.ma60Slope === null ? '—' : k.ma60Slope >= 0 ? '上揚' : '下彎'}）`,
    },
  ];
}

export type Verdict = 'calm' | 'watch' | 'reduce';
export function verdictOf(sig: readonly Signal[]): { verdict: Verdict; on: number; known: number } {
  const on = sig.filter((s) => s.on === true).length;
  const known = sig.filter((s) => s.on !== null).length;
  return { verdict: on >= 2 ? 'reduce' : on === 1 ? 'watch' : 'calm', on, known };
}
export const VERDICT_TEXT: Record<Verdict, string> = { calm: '未出現轉空訊號', watch: '1 項亮燈，留意', reduce: '減碼訊號（≥ 2 項）' };
export const VERDICT_COLOR: Record<Verdict, string> = { calm: '--lamp-green', watch: '--lamp-yellowred', reduce: '--lamp-red' };

// ───────────────────────── 回測 ─────────────────────────

/** 營收公布後可交易的第一天：營收月 M → M+1 月 11 日（含）後第一個交易日 */
export function revenueKnownDate(revMonth: string): string {
  return `${addMonths(revMonth, 1).slice(0, 7)}-11`;
}

export interface FwdStat {
  n: number;
  avg: number | null;
  med: number | null;
  /** 上漲機率 % */
  up: number | null;
}
export interface BucketRow {
  key: string;
  label: string;
  /** 各期間統計 */
  h: Record<HorizonKey, FwdStat>;
}

function stat(xs: number[]): FwdStat {
  return { n: xs.length, avg: mean(xs), med: median(xs), up: xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null };
}

export interface MonthObs {
  month: string;
  entry: string;
  yoy: number;
  fromHigh24: number | null;
  fwd: Partial<Record<HorizonKey, number>>;
}

/** 每個營收月一筆：公布後進場，往後 63／126／252 個交易日的還原報酬 */
export function monthObs(rows: readonly RevRow[], px: readonly Bar[], from = BT_START): MonthObs[] {
  const out: MonthObs[] = [];
  for (const r of rows) {
    if (r.date < from || r.yoy3 === null) continue;
    const i = idxAtOrAfter(px, revenueKnownDate(r.date));
    if (i < 0) continue;
    const fwd: MonthObs['fwd'] = {};
    for (const h of HORIZONS) if (i + h.days < px.length) fwd[h.key] = pct(px[i]![4], px[i + h.days]![4]);
    out.push({ month: r.date.slice(0, 7), entry: px[i]![0], yoy: r.yoy3, fromHigh24: r.fromHigh24, fwd });
  }
  return out;
}

/** 依「近 3 個月營收年增率」分組 */
export function yoyBuckets(obs: readonly MonthObs[]): { rows: BucketRow[]; base: BucketRow } {
  const mk = (key: string, label: string, sel: readonly MonthObs[]): BucketRow => ({
    key,
    label,
    h: Object.fromEntries(HORIZONS.map((h) => [h.key, stat(sel.flatMap((o) => (o.fwd[h.key] === undefined ? [] : [o.fwd[h.key]!])))])) as Record<HorizonKey, FwdStat>,
  });
  return {
    rows: YOY_BUCKETS.map((b) => mk(b.key, b.label, obs.filter((o) => o.yoy >= b.lo && o.yoy < b.hi))),
    base: mk('all', '全部月份', obs),
  };
}

/** 營收位置分組：3 個月平均創 24 個月新高 vs 已從高點回落 */
export function positionBuckets(obs: readonly MonthObs[]): BucketRow[] {
  const mk = (key: string, label: string, sel: readonly MonthObs[]): BucketRow => ({
    key,
    label,
    h: Object.fromEntries(HORIZONS.map((h) => [h.key, stat(sel.flatMap((o) => (o.fwd[h.key] === undefined ? [] : [o.fwd[h.key]!])))])) as Record<HorizonKey, FwdStat>,
  });
  const valid = obs.filter((o) => o.fromHigh24 !== null);
  return [
    mk('high', '創 24 個月新高', valid.filter((o) => o.fromHigh24! >= -0.0001)),
    mk('near', '距高點 0 ~ −15%', valid.filter((o) => o.fromHigh24! < -0.0001 && o.fromHigh24! > -15)),
    mk('off', '距高點 ≤ −15%', valid.filter((o) => o.fromHigh24! <= -15)),
  ];
}

export interface CycleRow {
  /** 營收循環高點（3 個月平均）所屬月份 */
  revPeak: string;
  revPeakValue: number;
  /** 循環漲幅：高點 / 前 24 個月低點 */
  revRise: number;
  /** 期間股價（還原）最高日 */
  stockPeak: string;
  stockPeakValue: number;
  /** 股價領先營收高點幾個月（正＝股價先見頂） */
  leadMonths: number;
  /** 營收高點「公布時」股價距股價高點 % */
  ddAtKnown: number;
  /** 公布後 12 個月報酬 %（不足為 null） */
  after12: number | null;
}

/**
 * 營收循環高點：3 個月平均是前後 12 個月內最高，且比前 24 個月低點高 ≥ 40%（濾掉季節波動）。
 * 股價高點：營收高點前 24 個月到後 6 個月內的還原收盤最高點。
 */
export const CYCLE_MIN_RISE = 40;
export function cycles(rows: readonly RevRow[], px: readonly Bar[], from = BT_START): CycleRow[] {
  const out: CycleRow[] = [];
  const valid = rows.filter((r) => r.avg3 !== null);
  for (let i = 0; i < valid.length; i++) {
    const r = valid[i]!;
    if (r.date < from) continue;
    const lo = Math.max(0, i - 12);
    const hi = Math.min(valid.length - 1, i + 12);
    // 右側要有至少 6 個月確認回落，否則還不算高點
    if (i + 6 > valid.length - 1) continue;
    let isMax = true;
    for (let k = lo; k <= hi; k++) if (k !== i && valid[k]!.avg3! > r.avg3!) isMax = false;
    if (!isMax) continue;
    let trough = Infinity;
    for (let k = Math.max(0, i - 24); k < i; k++) trough = Math.min(trough, valid[k]!.avg3!);
    const rise = pct(trough, r.avg3!);
    if (!Number.isFinite(rise) || rise < CYCLE_MIN_RISE) continue;
    const a = idxAtOrAfter(px, addMonths(r.date, -24));
    const b = idxAtOrBefore(px, addMonths(r.date, 7));
    if (a < 0 || b < a) continue;
    let pk = a;
    for (let k = a; k <= b; k++) if (px[k]![4] > px[pk]![4]) pk = k;
    const known = idxAtOrAfter(px, revenueKnownDate(r.date));
    if (known < 0) continue;
    const peakMonthStart = `${px[pk]![0].slice(0, 7)}-01`;
    const lead = monthsBetween(peakMonthStart, r.date);
    out.push({
      revPeak: r.date.slice(0, 7),
      revPeakValue: r.avg3!,
      revRise: rise,
      stockPeak: px[pk]![0],
      stockPeakValue: px[pk]![4],
      leadMonths: lead,
      ddAtKnown: pct(px[pk]![4], px[known]![4]),
      after12: known + 252 < px.length ? pct(px[known]![4], px[known + 252]![4]) : null,
    });
  }
  return out;
}

function monthsBetween(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

export interface ShippingAnalysis {
  scfi: ScfiState | null;
  rev: RevState | null;
  stock: StockState | null;
  signals: Signal[];
  verdict: ReturnType<typeof verdictOf>;
  revRows: RevRow[];
  obs: MonthObs[];
  yoy: ReturnType<typeof yoyBuckets>;
  position: BucketRow[];
  cycles: CycleRow[];
  /** 目前營收所在分組 */
  nowYoyBucket: string | null;
  nowPosBucket: string | null;
}

export function analyzeShipping(scfi: readonly Bar[], px: readonly Bar[], rev: readonly Bar[]): ShippingAnalysis {
  const rr = revRows(rev);
  const s = scfiState(scfi);
  const r = revState(rr);
  const k = stockState(px);
  const sig = signals(s, r, k);
  const obs = monthObs(rr, px);
  const last = rr.at(-1);
  const nowYoy = last?.yoy3 ?? null;
  const nowPos = last?.fromHigh24 ?? null;
  return {
    scfi: s,
    rev: r,
    stock: k,
    signals: sig,
    verdict: verdictOf(sig),
    revRows: rr,
    obs,
    yoy: yoyBuckets(obs),
    position: positionBuckets(obs),
    cycles: cycles(rr, px),
    nowYoyBucket: nowYoy === null ? null : (YOY_BUCKETS.find((b) => nowYoy >= b.lo && nowYoy < b.hi)?.key ?? null),
    nowPosBucket: nowPos === null ? null : nowPos >= -0.0001 ? 'high' : nowPos > -15 ? 'near' : 'off',
  };
}
