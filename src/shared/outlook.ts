import type { CalendarFile, EventKey } from './calendar';
import { addDays, daysBetween } from './dates';
import type { IndicatorDef } from './indicators';
import { scoreToSignal, SIGNAL_SCORE, type IndicatorEval, type Regime } from './regime';
import { lastReleaseFor, nextReleaseFor, RELEASE_KINDS, type ScheduledRelease } from './schedule';
import { evaluateSignal } from './signals';
import type { Point } from './timeseries';
import type { Signal } from './types';

/**
 * 下次公布的「翻轉門檻」與對綜合分數的影響。
 *
 * 做法：把「下次公布值」當成未知數 x，接在現有數列後面（同一期修正則取代最後一筆），
 * 直接用網站的判斷規則 evaluateSignal 重算——門檻與網站判斷永遠一致，不另寫一套公式。
 *
 * 限制（UI 會註明）：
 *  - 只模擬「新的一期」，不含前幾期修正（非農常大幅修正前 2 個月）
 *  - CPI 年增率以未四捨五入的指數計算，BLS 公布值四捨五入到 0.1，貼近門檻時以網站計算為準
 *  - 美債、美元、股價等每日變動的指標不在此列，它們會在公布當天跟著反應
 */

export interface Band {
  signal: Signal;
  /** 區間下限（含），null 表示無下限 */
  lo: number | null;
  /** 區間上限（含），null 表示無上限 */
  hi: number | null;
}

export interface ScoreImpact {
  score: number;
  regime: Signal;
}

export interface IndicatorOutlook {
  id: string;
  release: ScheduledRelease;
  current: Signal;
  /** 數值型：各訊號對應的公布值區間（由小到大） */
  bands: Band[] | null;
  /** Fed：降息／不變／升息 25bp 的結果 */
  policy: { cut: Signal; hold: Signal; hike: Signal; holdNeutralFrom: string | null } | null;
  /** 市場預期（若有）及其對應的判斷 */
  forecast: { value: number; signal: Signal } | null;
  /** 這個指標分別變成偏多／中性／偏空時的綜合分數 */
  impact: Record<Signal, ScoreImpact>;
  /** 上次公布的資料還沒進網站（例如剛公布、FRED 尚未更新） */
  pendingData: boolean;
}

const FORECAST_KEY: Record<string, EventKey> = {
  cpi: 'cpi_yoy',
  core_cpi: 'core_yoy',
  nfp: 'nfp',
  unrate: 'unrate',
  gdp: 'gdp',
};

/** 搜尋步距：CPI 年增率由指數計算（0.01）；其餘以官方公布精度 */
export function stepFor(def: IndicatorDef): number {
  if (def.id === 'cpi' || def.id === 'core_cpi') return 0.01;
  return 10 ** -def.decimals;
}

const round = (v: number, step: number) => Math.round(v / step) * step;

/** 把假設的公布值放進數列：同一期取代，新的一期接在後面 */
export function withValue(pts: readonly Point[], period: string, x: number): Point[] {
  const last = pts.at(-1);
  if (last && period <= last[0]) return [...pts.slice(0, -1), [last[0], x]];
  return [...pts, [period, x]];
}

/** 掃描 x 的範圍，整理成「哪個區間 → 哪個判斷」 */
export function signalBands(def: IndicatorDef, pts: readonly Point[], period: string): Band[] {
  const step = stepFor(def);
  const center = pts.at(-1)?.[1] ?? 0;
  const span = def.unit === 'k' ? 600 : def.frequency === 'quarterly' ? 10 : 3;
  const n = Math.round(span / step);
  const bands: Band[] = [];
  for (let i = -n; i <= n; i++) {
    const x = round(round(center, step) + i * step, step);
    const s = evaluateSignal(def, withValue(pts, period, x)).signal;
    const cur = bands.at(-1);
    if (cur && cur.signal === s) cur.hi = x;
    else bands.push({ signal: s, lo: x, hi: x });
  }
  if (bands.length) {
    bands[0]!.lo = null;
    bands.at(-1)!.hi = null;
  }
  return bands;
}

/** Fed：下次會議降／不變／升 25bp；以及「不變的話哪天起轉中性」 */
export function policyScenarios(def: IndicatorDef, pts: readonly Point[], meetingDate: string) {
  const last = pts.at(-1);
  if (!last || def.rule.kind !== 'policyRate') return null;
  // FRED 目標利率在決議隔天生效
  const eff = addDays(meetingDate, 1);
  const at = (x: number): Signal => evaluateSignal(def, [...pts, [eff, last[1] + x]]).signal;
  let changeDate: string | null = null;
  for (let i = pts.length - 1; i > 0; i--) {
    if (Math.abs(pts[i]![1] - pts[i - 1]![1]) > 1e-9) {
      changeDate = pts[i]![0];
      break;
    }
  }
  const lookback = def.rule.lookbackDays;
  const holdNeutralFrom = changeDate && daysBetween(changeDate, last[0]) < lookback ? addDays(changeDate, lookback) : null;
  return { cut: at(-0.25), hold: at(0), hike: at(0.25), holdNeutralFrom };
}

/** 若某些指標的判斷改成指定值，綜合分數會變成多少 */
export function scoreWith(regime: Regime, overrides: Record<string, Signal>): ScoreImpact {
  let sum = 0;
  let used = 0;
  for (const e of regime.evals) {
    const o = overrides[e.def.id];
    if (o !== undefined) {
      if (e.def.weight === 0) continue;
      sum += SIGNAL_SCORE[o] * e.def.weight;
      used += e.def.weight;
    } else if (e.counted) {
      sum += e.contribution;
      used += e.def.weight;
    }
  }
  const score = used > 0 ? sum / used : 0;
  return { score, regime: used > 0 ? scoreToSignal(score) : 'neutral' };
}

function forecastFor(cal: CalendarFile | null, id: string, release: ScheduledRelease): number | null {
  const key = FORECAST_KEY[id];
  if (!cal || !key) return null;
  const ev = cal.events.find((e) => e.key === key && e.releaseDate === release.date);
  return ev?.forecast ?? null;
}

export function indicatorOutlook(
  ev: IndicatorEval,
  regime: Regime,
  now: Date,
  cal: CalendarFile | null = null,
): IndicatorOutlook | null {
  const def = ev.def;
  if (def.rule.kind === 'info' || def.weight === 0) return null;
  const release = nextReleaseFor(def.id, now);
  if (!release) return null;
  const pts = ev.points;
  const lastDate = pts.at(-1)?.[0] ?? '';
  const prev = lastReleaseFor(def.id, now);
  const pendingData = !!prev?.period && prev.period > lastDate;

  const impact = {
    bull: scoreWith(regime, { [def.id]: 'bull' }),
    neutral: scoreWith(regime, { [def.id]: 'neutral' }),
    bear: scoreWith(regime, { [def.id]: 'bear' }),
  };
  const base = { id: def.id, release, current: ev.signal.signal, impact, pendingData };

  if (release.kind === 'fomc') {
    return { ...base, bands: null, policy: policyScenarios(def, pts, release.date), forecast: null };
  }
  if (!release.period || pts.length === 0 || pendingData) {
    return { ...base, bands: null, policy: null, forecast: null };
  }
  const fc = forecastFor(cal, def.id, release);
  return {
    ...base,
    bands: signalBands(def, pts, release.period),
    policy: null,
    forecast: fc === null ? null : { value: fc, signal: evaluateSignal(def, withValue(pts, release.period, fc)).signal },
  };
}

export function outlooksFor(regime: Regime, now: Date, cal: CalendarFile | null = null): Record<string, IndicatorOutlook> {
  const out: Record<string, IndicatorOutlook> = {};
  for (const ev of regime.evals) {
    const o = indicatorOutlook(ev, regime, now, cal);
    if (o) out[ev.def.id] = o;
  }
  return out;
}

/** 一次公布可能到達的判斷（數值型看 bands；Fed 看三種情境） */
export function reachableSignals(o: IndicatorOutlook): Signal[] {
  if (o.policy) return [...new Set([o.policy.cut, o.policy.hold, o.policy.hike])];
  if (o.bands) return [...new Set(o.bands.map((b) => b.signal))];
  return [o.current];
}

/** 一次公布（可能同時影響多個指標）的最好／最壞綜合分數 */
export function eventRange(
  regime: Regime,
  release: ScheduledRelease,
  outlooks: Record<string, IndicatorOutlook>,
): { best: ScoreImpact; worst: ScoreImpact; now: ScoreImpact } | null {
  const ids = RELEASE_KINDS[release.kind].indicators.filter(
    (id) => outlooks[id] && outlooks[id]!.release.date === release.date && outlooks[id]!.release.kind === release.kind,
  );
  if (ids.length === 0) return null;
  let combos: Record<string, Signal>[] = [{}];
  for (const id of ids) {
    const opts = reachableSignals(outlooks[id]!);
    combos = combos.flatMap((c) => opts.map((s) => ({ ...c, [id]: s })));
  }
  const results = combos.map((c) => scoreWith(regime, c));
  const best = results.reduce((a, b) => (b.score > a.score ? b : a));
  const worst = results.reduce((a, b) => (b.score < a.score ? b : a));
  return { best, worst, now: scoreWith(regime, {}) };
}
