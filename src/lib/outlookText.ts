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
