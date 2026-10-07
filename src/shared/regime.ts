import { CATEGORY_ORDER, INDICATORS, type IndicatorDef } from './indicators';
import { evaluateSignal, isStale, type SignalResult } from './signals';
import { transformPoints, type Point } from './timeseries';
import type { Category, Signal, SummaryFile } from './types';

/**
 * 綜合市場環境判斷（規則式加權平均，非 AI 猜測）
 *
 *   每個指標訊號：偏多 = +1、中性 = 0、偏空 = −1
 *   綜合分數 = Σ(訊號 × 權重) / Σ(有效權重)，範圍 −1 ~ +1
 *   分數 ≥ +0.20 → 偏多；≤ −0.20 → 偏空；其餘 → 中性
 *
 *   資料過時、抓取失敗或資料不足的指標「不計分」，並降低涵蓋率。
 *   涵蓋率 < 60% 時，結論標示「資料不足，僅供參考」。
 */

export const REGIME_THRESHOLD = 0.2;
export const MIN_COVERAGE = 0.6;

export const SIGNAL_SCORE: Record<Signal, number> = { bull: 1, neutral: 0, bear: -1 };
export const SIGNAL_LABEL: Record<Signal, string> = { bull: '偏多', neutral: '中性', bear: '偏空' };

export interface IndicatorEval {
  def: IndicatorDef;
  points: Point[];
  signal: SignalResult;
  stale: boolean;
  /** 是否納入綜合計分 */
  counted: boolean;
  /** 不計分原因 */
  excludedReason: string | null;
  contribution: number;
}

export interface CategoryScore {
  category: Category;
  score: number | null;
  signal: Signal | null;
  weight: number;
}

export interface Regime {
  signal: Signal;
  score: number;
  coverage: number;
  lowCoverage: boolean;
  bullCount: number;
  bearCount: number;
  neutralCount: number;
  evals: IndicatorEval[];
  categories: CategoryScore[];
}

export function scoreToSignal(score: number): Signal {
  if (score >= REGIME_THRESHOLD) return 'bull';
  if (score <= -REGIME_THRESHOLD) return 'bear';
  return 'neutral';
}

export function evaluateIndicator(def: IndicatorDef, summary: SummaryFile, today: string): IndicatorEval {
  const entry = summary.entries[def.id];
  const points = entry ? transformPoints(def, entry.tail) : [];
  const signal = evaluateSignal(def, points);
  const lastDate = points.at(-1)?.[0] ?? null;
  const stale = isStale(def, lastDate, today);
  let excludedReason: string | null = null;
  if (!entry || entry.status === 'error' || points.length === 0) excludedReason = '資料抓取失敗';
  else if (stale) excludedReason = '資料過時';
  else if (signal.reason.startsWith('資料不足')) excludedReason = '資料不足';
  else if (def.weight === 0) excludedReason = '僅供參考';
  const counted = excludedReason === null;
  return {
    def,
    points,
    signal,
    stale,
    counted,
    excludedReason,
    contribution: counted ? SIGNAL_SCORE[signal.signal] * def.weight : 0,
  };
}

export function computeRegime(summary: SummaryFile, today: string, defs: IndicatorDef[] = INDICATORS): Regime {
  const evals = defs.filter((d) => !d.hidden).map((d) => evaluateIndicator(d, summary, today));
  const totalWeight = evals.reduce((s, e) => s + e.def.weight, 0);
  const counted = evals.filter((e) => e.counted);
  const usedWeight = counted.reduce((s, e) => s + e.def.weight, 0);
  const score = usedWeight > 0 ? counted.reduce((s, e) => s + e.contribution, 0) / usedWeight : 0;
  const coverage = totalWeight > 0 ? usedWeight / totalWeight : 0;

  const categories: CategoryScore[] = CATEGORY_ORDER.map((category) => {
    const items = counted.filter((e) => e.def.category === category);
    const w = items.reduce((s, e) => s + e.def.weight, 0);
    if (w === 0) return { category, score: null, signal: null, weight: 0 };
    const sc = items.reduce((s, e) => s + e.contribution, 0) / w;
    return { category, score: sc, signal: scoreToSignal(sc), weight: w };
  });

  return {
    signal: usedWeight > 0 ? scoreToSignal(score) : 'neutral',
    score,
    coverage,
    lowCoverage: coverage < MIN_COVERAGE,
    bullCount: counted.filter((e) => e.signal.signal === 'bull').length,
    bearCount: counted.filter((e) => e.signal.signal === 'bear').length,
    neutralCount: counted.filter((e) => e.signal.signal === 'neutral').length,
    evals,
    categories,
  };
}
