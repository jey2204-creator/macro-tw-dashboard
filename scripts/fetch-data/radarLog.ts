import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { basisText, fmtLevel, fmtScore, gapText, moveText, sigmaText } from '../../src/lib/outlookText';
import { dailyOutlooksFor, radar, regimeGaps } from '../../src/shared/dailyOutlook';
import { todayInTaipei } from '../../src/shared/dates';
import { INDICATOR_MAP } from '../../src/shared/indicators';
import { computeRegime, SIGNAL_LABEL } from '../../src/shared/regime';
import type { SummaryFile } from '../../src/shared/types';

/**
 * 翻轉雷達摘要（純文字），寫進 Actions 日誌並以 ::notice:: 註記輸出，
 * 方便不開網站也能檢查每日門檻（Claude 工作環境讀不到網站時，經 check-runs annotations API 讀取）。
 */
export function radarLines(summary: SummaryFile, now = new Date()): string[] {
  const regime = computeRegime(summary, todayInTaipei(now));
  const partial = Object.fromEntries(Object.values(summary.entries).map((e) => [e.id, e.partial]));
  const outlooks = dailyOutlooksFor(regime, partial);
  const lines = [`總分 ${fmtScore(regime.score)}（${SIGNAL_LABEL[regime.signal]}）`];
  for (const g of regimeGaps(regime)) lines.push(`距${SIGNAL_LABEL[g.to]} ${g.gap.toFixed(2)}：${gapText(g.weight, g.direction)}`);
  const r = radar(outlooks);
  for (const { id, flip } of r.flips.slice(0, 6)) {
    const def = INDICATOR_MAP[id]!;
    const o = outlooks[id]!;
    lines.push(
      `${def.short} ${SIGNAL_LABEL[o.current]}→${SIGNAL_LABEL[flip.signal]}：${basisText(o.basis, o.targetDate)} ${flip.dir === 'down' ? '≤' : '≥'} ${fmtLevel(def, flip.at, o.decimals)}（${moveText(def, flip.dist, flip.pct)}，${sigmaText(flip.sigmas)}）→ 總分 ${fmtScore(flip.impact.score)} ${SIGNAL_LABEL[flip.impact.regime]}${flip.flipsRegime ? ' ⚠️' : ''}`,
    );
  }
  for (const { id, drift } of r.drifts.slice(0, 4)) {
    lines.push(`${INDICATOR_MAP[id]!.short} 若持平，${drift.steps} 個交易日後（${drift.date}）轉${SIGNAL_LABEL[drift.signal]}${drift.flipsRegime ? ' ⚠️' : ''}`);
  }
  return lines;
}

export async function logRadar(outDir: string): Promise<string[]> {
  const summary = JSON.parse(await readFile(path.join(outDir, 'summary.json'), 'utf8')) as SummaryFile;
  return radarLines(summary);
}
