import type { Time } from 'lightweight-charts';
import type { Completion } from '../shared/marginStress';
import type { BaseLabelItem } from './baseLabel';
import { baseDateLabel } from './breadthPct';

/** 去槓桿完成度窗格的基準點標籤：指數高點、融資餘額高點（圓點畫在 0% 線上；餘額缺值時只有指數） */
export function completionBaseLabels(c: Completion | null, ref: string, indexColor: string, marginColor: string): BaseLabelItem[] {
  if (!c) return [];
  const out: BaseLabelItem[] = [{ time: c.peakDate as Time, value: 0, text: `指數高 ${baseDateLabel(c.peakDate, ref)}`, color: indexColor }];
  if (c.balPeakDate) out.push({ time: c.balPeakDate as Time, value: 0, text: `融資高 ${baseDateLabel(c.balPeakDate, ref)}`, color: marginColor });
  return out;
}
