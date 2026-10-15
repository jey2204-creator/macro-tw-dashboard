import { addDays } from './dates';
import type { IndicatorDef } from './indicators';
import { scoreWith, type Band, type ScoreImpact } from './outlook';
import { REGIME_THRESHOLD, type IndicatorEval, type Regime } from './regime';
import { evaluateSignal } from './signals';
import { sma, type Point } from './timeseries';
import type { Signal } from './types';

/**
 * 每日市場指標（美債 2Y／10Y、美元、台幣、股價趨勢）的翻轉門檻。
 *
 * 和公布日門檻（outlook.ts）同一個做法：把「下一個收盤值」當未知數 x，
 * 用網站自己的判斷規則 evaluateSignal 重算，找出讓判斷改變的 x。
 *
 *  - 最後一筆是盤中資料（partial）→ 門檻是「今日收盤」（取代最後一筆）
 *  - 否則 → 門檻是「下一筆收盤」（接在後面；FRED 美債常落後 1–2 天）
 *  - 門檻對齊顯示精度（利率 0.01%、台幣 0.001、指數 1 點），並用規則逐一驗證
 *  - 「若持平」：之後每天收在同一個價位，判斷會在第幾個交易日改變（20 日前的基準逐日往前滾）
 *  - 距離以「日波動 σ」表示（近 60 筆日變化的標準差），用來比較哪個指標最接近翻轉
 */

export type DailyBasis = 'next' | 'today';

export interface TrendLine {
  key: 'ma60' | 'slope' | 'ma240';
  label: string;
  /** 收盤需高於此值，條件才成立 */
  at: number;
}

export interface DailyFlip {
  /** 越過門檻後的判斷 */
  signal: Signal;
  /** 門檻（顯示精度上、屬於新判斷區間的第一個值） */
  at: number;
  /** 需要往上或往下 */
  dir: 'up' | 'down';
  /** 與目前值的差（數值單位） */
  dist: number;
  /** 與目前值的差（%） */
  pct: number | null;
  /** 約幾個日波動 */
  sigmas: number | null;
  impact: ScoreImpact;
  /** 是否會讓綜合結論改變 */
  flipsRegime: boolean;
}

export interface DailyDrift {
  /** 目前資料之後第幾個交易日 */
  steps: number;
  /** 約略日期（只排除週末，未扣休市） */
  date: string;
  signal: Signal;
  impact: ScoreImpact;
  flipsRegime: boolean;
}

export interface DailyOutlook {
  id: string;
  basis: DailyBasis;
  /** 門檻適用的日期：今日（盤中）或下一筆 */
  targetDate: string;
  last: number;
  lastDate: string;
  current: Signal;
  /** 顯示精度 */
  decimals: number;
  bands: Band[];
  trendLines: TrendLine[] | null;
  /** 相鄰的翻轉門檻（往上、往下各最多一個） */
  flips: DailyFlip[];
  /** 若之後都持平，判斷何時改變（40 個交易日內） */
  drift: DailyDrift | null;
  sigma: { value: number; kind: 'abs' | 'pct' } | null;
}

const DAILY_KINDS = new Set(['risingIsBearish', 'trend']);

export function isDailyScored(def: IndicatorDef): boolean {
  return def.frequency === 'daily' && def.weight > 0 && DAILY_KINDS.has(def.rule.kind);
}

/** 門檻顯示精度：指數（≥1000）到整數點，其餘沿用指標小數位 */
export function thresholdDecimals(def: IndicatorDef, level: number): number {
  if (def.unit === 'pt' && Math.abs(level) >= 1000) return 0;
  return def.decimals;
}

/** 加 n 個工作日（只跳過週末） */
export function addWeekdays(date: string, n: number): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

function scenario(pts: readonly Point[], basis: DailyBasis, x: number): Point[] {
  const last = pts.at(-1)!;
  if (basis === 'today') return [...pts.slice(0, -1), [last[0], x]];
  return [...pts, [addWeekdays(last[0], 1), x]];
}

const fix = (k: number, tick: number, d: number) => Number((k * tick).toFixed(d));

/**
 * 在顯示精度的格點上掃描，找出判斷改變的位置（規則對 x 單調，先粗掃再二分）。
 * 回傳的區間 lo／hi 皆為格點上的值（含），且已用規則逐一驗證。
 */
export function dailyBands(def: IndicatorDef, pts: readonly Point[], basis: DailyBasis): { bands: Band[]; decimals: number } {
  const last = pts.at(-1)![1];
  const d = thresholdDecimals(def, last);
  const tick = 10 ** -d;
  const span = def.changeInBp ? 1.5 : Math.abs(last) * 0.25;
  const kLo = Math.round((last - span) / tick);
  const kHi = Math.round((last + span) / tick);
  const sig = (k: number) => evaluateSignal(def, scenario(pts, basis, fix(k, tick, d))).signal;
  const stride = Math.max(1, Math.floor((kHi - kLo) / 600));

  const cuts: number[] = []; // 每個 cut 是「新區間的第一個格點」
  let prevK = kLo;
  let prevS = sig(kLo);
  for (let k = kLo + stride; ; k += stride) {
    const kk = Math.min(k, kHi);
    const s = sig(kk);
    if (s !== prevS) {
      // 在 (prevK, kk] 找第一個訊號 = s 的格點
      let a = prevK;
      let b = kk;
      while (b - a > 1) {
        const m = (a + b) >> 1;
        if (sig(m) === s) b = m;
        else a = m;
      }
      cuts.push(b);
      prevS = s;
    }
    prevK = kk;
    if (kk >= kHi) break;
  }

  const bands: Band[] = [];
  let startK: number | null = null;
  let curS = sig(kLo);
  for (const c of cuts) {
    bands.push({ signal: curS, lo: startK === null ? null : fix(startK, tick, d), hi: fix(c - 1, tick, d) });
    startK = c;
    curS = sig(c);
  }
  bands.push({ signal: curS, lo: startK === null ? null : fix(startK, tick, d), hi: null });
  return { bands, decimals: d };
}

/** 股價趨勢三條件各自的門檻（收盤需高於 at）；與 evaluateSignal 的 trend 規則同一套算式 */
export function trendLines(pts: readonly Point[], basis: DailyBasis): TrendLine[] | null {
  // 新數列 = base + [x]
  const base = basis === 'today' ? pts.slice(0, -1) : pts.slice();
  const v = base.map((p) => p[1]);
  const n = v.length + 1;
  if (n < 81) return null;
  const sum = (from: number) => v.slice(from).reduce((s, x) => s + x, 0);
  const lines: TrendLine[] = [];
  // 收盤 > MA60：x > (S59 + x)/60 ⇔ x > S59/59
  const s59 = sum(v.length - 59);
  lines.push({ key: 'ma60', label: 'MA60', at: s59 / 59 });
  // MA60 較 20 日前上揚：(S59 + x)/60 > MA60(20 日前)
  const ma60 = sma(v, 60);
  const prev = ma60[n - 1 - 20];
  if (prev !== null && prev !== undefined) lines.push({ key: 'slope', label: 'MA60 上揚', at: 60 * prev - s59 });
  if (n >= 240) {
    const s239 = sum(v.length - 239);
    lines.push({ key: 'ma240', label: 'MA240', at: s239 / 239 });
  }
  return lines.sort((a, b) => a.at - b.at);
}

/** 近 n 筆日變化的標準差（利率用絕對值，其餘用百分比） */
export function dailySigma(def: IndicatorDef, pts: readonly Point[], n = 60): { value: number; kind: 'abs' | 'pct' } | null {
  const kind = def.changeInBp ? 'abs' : 'pct';
  const tail = pts.slice(-(n + 1));
  const ch: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1]![1];
    const b = tail[i]![1];
    if (kind === 'abs') ch.push(b - a);
    else if (a !== 0) ch.push((b / a - 1) * 100);
  }
  if (ch.length < 20) return null;
  const mean = ch.reduce((s, x) => s + x, 0) / ch.length;
  const sd = Math.sqrt(ch.reduce((s, x) => s + (x - mean) ** 2, 0) / (ch.length - 1));
  return sd > 0 ? { value: sd, kind } : null;
}

/** 若之後每天都收在目前價位，判斷在第幾個交易日改變 */
export function driftIfFlat(def: IndicatorDef, pts: readonly Point[], maxSteps = 40): { steps: number; signal: Signal } | null {
  const last = pts.at(-1);
  if (!last) return null;
  const current = evaluateSignal(def, pts).signal;
  const cur = pts.slice();
  let date = last[0];
  for (let s = 1; s <= maxSteps; s++) {
    date = addWeekdays(date, 1);
    cur.push([date, last[1]]);
    const sig = evaluateSignal(def, cur).signal;
    if (sig !== current) return { steps: s, signal: sig };
  }
  return null;
}

export function dailyOutlook(ev: IndicatorEval, regime: Regime, partial: boolean): DailyOutlook | null {
  const def = ev.def;
  if (!isDailyScored(def)) return null;
  const pts = ev.points;
  if (pts.length < 81) return null;
  const last = pts.at(-1)!;
  const basis: DailyBasis = partial ? 'today' : 'next';
  const current = ev.signal.signal;
  const { bands, decimals } = dailyBands(def, pts, basis);
  const sigma = dailySigma(def, pts);
  const nowRegime = scoreWith(regime, {}).regime;

  // 「持平」所在的區間：下一筆收在目前價位時的判斷（可能已和目前不同，見 drift）
  const pos = bands.findIndex((b) => (b.lo === null || last[1] >= b.lo) && (b.hi === null || last[1] <= b.hi));
  const flips: DailyFlip[] = [];
  const mk = (b: Band, dir: 'up' | 'down', level: number): DailyFlip => {
    const dist = level - last[1];
    const pct = last[1] !== 0 ? (dist / Math.abs(last[1])) * 100 : null;
    const sigmas = !sigma ? null : sigma.kind === 'abs' ? Math.abs(dist) / sigma.value : pct === null ? null : Math.abs(pct) / sigma.value;
    const impact = scoreWith(regime, { [def.id]: b.signal });
    return { signal: b.signal, at: level, dir, dist, pct, sigmas, impact, flipsRegime: impact.regime !== nowRegime };
  };
  if (pos >= 0) {
    const here = bands[pos]!;
    const below = bands[pos - 1];
    const above = bands[pos + 1];
    if (below && below.hi !== null && below.signal !== here.signal) flips.push(mk(below, 'down', below.hi));
    if (above && above.lo !== null && above.signal !== here.signal) flips.push(mk(above, 'up', above.lo));
  }

  const dr = driftIfFlat(def, pts);
  let drift: DailyDrift | null = null;
  if (dr) {
    const impact = scoreWith(regime, { [def.id]: dr.signal });
    drift = { ...dr, date: addWeekdays(last[0], dr.steps), impact, flipsRegime: impact.regime !== nowRegime };
  }

  return {
    id: def.id,
    basis,
    targetDate: basis === 'today' ? last[0] : addWeekdays(last[0], 1),
    last: last[1],
    lastDate: last[0],
    current,
    decimals,
    bands,
    trendLines: def.rule.kind === 'trend' ? trendLines(pts, basis) : null,
    flips,
    drift,
    sigma,
  };
}

export function dailyOutlooksFor(regime: Regime, partialById: Record<string, boolean>): Record<string, DailyOutlook> {
  const out: Record<string, DailyOutlook> = {};
  for (const ev of regime.evals) {
    // 不計分（過時、失敗、資料不足）的指標不列：總分影響會失真
    if (!ev.counted) continue;
    const o = dailyOutlook(ev, regime, !!partialById[ev.def.id]);
    if (o) out[ev.def.id] = o;
  }
  return out;
}

export interface RegimeGap {
  /** 往偏空／偏多（或回到中性）的分數差距 */
  direction: 'bear' | 'bull';
  /** 跨過去之後的結論 */
  to: Signal;
  gap: number;
  /** 需要多少「權重 × 一級」才跨過（例如 0.37 → 任一權重 0.5 指標轉一級） */
  weight: number;
}

/** 總分距離結論翻轉還差多少 */
export function regimeGaps(regime: Regime): RegimeGap[] {
  const used = regime.evals.filter((e) => e.counted).reduce((s, e) => s + e.def.weight, 0);
  if (used <= 0) return [];
  const s = regime.score;
  const T = REGIME_THRESHOLD;
  const out: RegimeGap[] = [];
  if (s > -T) out.push({ direction: 'bear', to: s >= T ? 'neutral' : 'bear', gap: s - (s >= T ? T - 1e-9 : -T), weight: 0 });
  if (s < T) out.push({ direction: 'bull', to: s <= -T ? 'neutral' : 'bull', gap: (s <= -T ? -T + 1e-9 : T) - s, weight: 0 });
  for (const g of out) {
    g.gap = Math.max(0, g.gap);
    g.weight = g.gap * used;
  }
  return out;
}

export interface Radar {
  /** 最接近翻轉的門檻（依幾個日波動排序） */
  flips: { id: string; flip: DailyFlip }[];
  /** 價位不動、判斷也會在 N 個交易日內改變的（依天數排序） */
  drifts: { id: string; drift: DailyDrift }[];
}

/** 翻轉雷達：每日指標中最接近翻轉的門檻，以及「持平也會變」的 */
export function radar(outlooks: Record<string, DailyOutlook>, driftWithin = 10): Radar {
  const flips: Radar['flips'] = [];
  const drifts: Radar['drifts'] = [];
  for (const o of Object.values(outlooks)) {
    for (const f of o.flips) if (f.signal !== o.current) flips.push({ id: o.id, flip: f });
    if (o.drift && o.drift.steps <= driftWithin) drifts.push({ id: o.id, drift: o.drift });
  }
  flips.sort((a, b) => (a.flip.sigmas ?? 99) - (b.flip.sigmas ?? 99));
  drifts.sort((a, b) => a.drift.steps - b.drift.steps);
  return { flips, drifts };
}
