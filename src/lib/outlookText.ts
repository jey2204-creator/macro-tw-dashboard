import { INDICATOR_MAP, type IndicatorDef } from '../shared/indicators';
import { stepFor, type Band, type IndicatorOutlook, type ScoreImpact } from '../shared/outlook';
import { SIGNAL_LABEL } from '../shared/regime';
import type { Signal } from '../shared/types';

/** 下次公布值的名稱 */
const VALUE_LABEL: Record<string, string> = {
  cpi: '年增',
  core_cpi: '年增',
  unrate: '失業率',
  nfp: '新增',
  gdp: '年化季增',
  gdpnow: '預估',
};

function decimalsOf(def: IndicatorDef): number {
  const s = stepFor(def);
  return s >= 1 ? 0 : Math.round(-Math.log10(s));
}

export function fmtValue(def: IndicatorDef, v: number): string {
  const d = decimalsOf(def);
  const n = v.toFixed(d).replace(/^-0(\.0+)?$/, '0$1');
  if (def.unit === 'k') return `${v > 0 ? '+' : ''}${n}k`;
  return `${n}%`;
}

export function fmtScore(v: number): string {
  const s = Math.abs(v) < 0.005 ? 0 : v;
  return `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s).toFixed(2)}`;
}

export function bandText(def: IndicatorDef, b: Band): string {
  if (b.lo === null && b.hi === null) return '任何數值';
  if (b.lo === null) return `≤ ${fmtValue(def, b.hi!)}`;
  if (b.hi === null) return `≥ ${fmtValue(def, b.lo)}`;
  if (Math.abs(b.hi - b.lo) < 1e-9) return fmtValue(def, b.lo);
  return `${fmtValue(def, b.lo)}～${fmtValue(def, b.hi)}`;
}

export interface OutlookPiece {
  text: string;
  signal: Signal;
  /** 是目前判斷所在的區間／情境 */
  current: boolean;
}

/** 門檻（或 Fed 情境）：每段「條件 → 判斷」 */
export function thresholdPieces(o: IndicatorOutlook): OutlookPiece[] {
  const def = INDICATOR_MAP[o.id]!;
  if (o.policy) {
    const p = o.policy;
    return [
      { text: '降息 25bp', signal: p.cut, current: false },
      { text: '不變', signal: p.hold, current: true },
      { text: '升息 25bp', signal: p.hike, current: false },
    ];
  }
  if (!o.bands) return [];
  const label = VALUE_LABEL[o.id] ?? '';
  return o.bands.map((b, i) => ({
    text: `${i === 0 ? `${label} ` : ''}${bandText(def, b)}`,
    signal: b.signal,
    current: b.signal === o.current,
  }));
}

/** 「若轉偏空：總分 −0.11 → −0.22（偏空）」——只列與目前不同的判斷 */
export function impactPieces(o: IndicatorOutlook, nowScore: number): { signal: Signal; text: string; flips: boolean }[] {
  const out: { signal: Signal; text: string; flips: boolean }[] = [];
  const nowRegime = o.impact[o.current].regime;
  for (const s of ['bear', 'bull', 'neutral'] as Signal[]) {
    if (s === o.current) continue;
    const reachable = o.policy
      ? [o.policy.cut, o.policy.hold, o.policy.hike].includes(s)
      : (o.bands ?? []).some((b) => b.signal === s);
    if (!reachable) continue;
    const imp = o.impact[s];
    out.push({
      signal: s,
      text: `若轉${SIGNAL_LABEL[s]}：總分 ${fmtScore(nowScore)} → ${fmtScore(imp.score)}（${SIGNAL_LABEL[imp.regime]}）`,
      flips: imp.regime !== nowRegime,
    });
  }
  return out;
}

export function rangeText(r: { best: ScoreImpact; worst: ScoreImpact }): string {
  const same = Math.abs(r.best.score - r.worst.score) < 0.005;
  if (same) return `不影響總分（${fmtScore(r.best.score)}）`;
  return `總分 ${fmtScore(r.worst.score)}（${SIGNAL_LABEL[r.worst.regime]}）～ ${fmtScore(r.best.score)}（${SIGNAL_LABEL[r.best.regime]}）`;
}

/** 純文字摘要（行事曆檔描述用） */
export function outlookPlain(o: IndicatorOutlook, nowScore: number): string {
  const def = INDICATOR_MAP[o.id]!;
  const lines: string[] = [`${def.short}：目前${SIGNAL_LABEL[o.current]}`];
  const th = thresholdPieces(o);
  if (th.length) lines.push(th.map((p) => `${p.text} → ${SIGNAL_LABEL[p.signal]}`).join('｜'));
  if (o.forecast) lines.push(`市場預期 ${fmtValue(def, o.forecast.value)} → ${SIGNAL_LABEL[o.forecast.signal]}`);
  if (o.policy?.holdNeutralFrom) lines.push(`若一直不變，${o.policy.holdNeutralFrom.slice(5).replace('-', '/')} 起轉中性`);
  for (const p of impactPieces(o, nowScore)) lines.push(p.text);
  return lines.join('\n');
}

// ───────────── 每日市場指標（dailyOutlook） ─────────────

const lvlFmt = new Map<number, Intl.NumberFormat>();

/** 價位：利率 5.19%、台幣 32.337、指數 45,580 */
export function fmtLevel(def: IndicatorDef, v: number, decimals: number): string {
  let f = lvlFmt.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    lvlFmt.set(decimals, f);
  }
  const s = f.format(v);
  return def.unit === '%' ? `${s}%` : s;
}

export function dailyBandText(def: IndicatorDef, b: Band, decimals: number): string {
  if (b.lo === null && b.hi === null) return '任何收盤';
  if (b.lo === null) return `≤ ${fmtLevel(def, b.hi!, decimals)}`;
  if (b.hi === null) return `≥ ${fmtLevel(def, b.lo, decimals)}`;
  return `${fmtLevel(def, b.lo, decimals)}～${fmtLevel(def, b.hi, decimals)}`;
}

/** 還要動多少：「再降 2bp」「再跌 8.5%」 */
export function moveText(def: IndicatorDef, dist: number, pct: number | null): string {
  if (def.changeInBp) return `${dist > 0 ? '再升' : '再降'} ${Math.round(Math.abs(dist) * 100)}bp`;
  const p = pct === null ? '—' : `${Math.abs(pct) < 0.1 ? Math.abs(pct).toFixed(2) : Math.abs(pct).toFixed(1)}%`;
  return `${dist > 0 ? '再漲' : '再跌'} ${p}`;
}

/** 標準常態單尾機率 P(Z ≥ k)（Abramowitz–Stegun 7.1.26） */
export function tailProb(k: number): number {
  const x = Math.abs(k) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const p = 0.5 * (1 - erf);
  return k >= 0 ? p : 1 - p;
}

/** 「0.4σ，單日約 34%」 */
export function sigmaText(sigmas: number | null): string {
  if (sigmas === null) return '';
  const p = tailProb(sigmas) * 100;
  const ps = p >= 1 ? `${Math.round(p)}%` : '<1%';
  return `${sigmas.toFixed(1)}σ，單日約 ${ps}`;
}

export function basisText(basis: 'next' | 'today', targetDate: string): string {
  const md = targetDate.slice(5).replace('-', '/');
  return basis === 'today' ? `今日收盤（${md}）` : `下一筆收盤（${md}）`;
}

/** 「任一權重 0.5 以上指標轉弱一級就會翻」 */
export function gapText(weight: number, dir: 'bear' | 'bull'): string {
  const v = dir === 'bear' ? '轉弱' : '轉強';
  if (weight <= 1e-9) return '已在門檻上';
  if (weight <= 0.25) return `任何一個指標${v}一級就會翻`;
  if (weight <= 0.5) return `任一權重 0.5 以上的指標${v}一級就會翻`;
  if (weight <= 1) return `一個權重 1 的指標（2Y、10Y、Fed、核心CPI）或兩個 0.5 的${v}一級就會翻`;
  return `需要權重合計 ${weight.toFixed(1)} 的指標${v}一級`;
}
