// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { radarLines } from '../scripts/fetch-data/radarLog';
import { IndicatorTable } from '../src/components/IndicatorTable';
import { RadarPanel } from '../src/components/RadarPanel';
import { buildRow } from '../src/lib/rows';
import { gapText, moveText, sigmaText, tailProb } from '../src/lib/outlookText';
import {
  addWeekdays,
  dailyBands,
  dailyOutlook,
  dailyOutlooksFor,
  driftIfFlat,
  radar,
  regimeGaps,
  trendLines,
  type DailyBasis,
} from '../src/shared/dailyOutlook';
import { getIndicator } from '../src/shared/indicators';
import { computeRegime, REGIME_THRESHOLD } from '../src/shared/regime';
import { evaluateSignal } from '../src/shared/signals';
import type { Point } from '../src/shared/timeseries';
import type { SummaryFile } from '../src/shared/types';
import { dailySeries, linear } from './helpers';

const summary = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/summary-2026-10-06.json'), 'utf8'),
) as SummaryFile;
const TODAY = '2026-10-07';
const regime = computeRegime(summary, TODAY);
const partial = Object.fromEntries(Object.values(summary.entries).map((e) => [e.id, e.partial]));
const outlooks = dailyOutlooksFor(regime, partial);

afterEach(cleanup);

/** 測試用：把 x 放進數列（與模組內同一規則） */
function put(pts: readonly Point[], basis: DailyBasis, x: number): Point[] {
  const last = pts.at(-1)!;
  return basis === 'today' ? [...pts.slice(0, -1), [last[0], x]] : [...pts, [addWeekdays(last[0], 1), x]];
}

describe('工作日', () => {
  it('週五加 1 個工作日是週一', () => {
    expect(addWeekdays('2026-10-16', 1)).toBe('2026-10-19');
    expect(addWeekdays('2026-10-13', 7)).toBe('2026-10-22');
  });
});

describe('門檻區間（真實資料 2026-10-06）', () => {
  it('9 個計分的每日指標都有門檻', () => {
    expect(Object.keys(outlooks).sort()).toEqual(['dxy', 'nasdaq', 'sox', 'spx', 'taiex', 'tpex', 'us10y', 'us2y', 'usdtwd'].sort());
  });

  it('每個區間的邊界、以及邊界外一格，都經網站規則驗證', () => {
    for (const o of Object.values(outlooks)) {
      const ev = regime.evals.find((e) => e.def.id === o.id)!;
      const tick = 10 ** -o.decimals;
      for (const [i, b] of o.bands.entries()) {
        if (b.lo !== null) {
          expect(evaluateSignal(ev.def, put(ev.points, o.basis, b.lo)).signal, `${o.id} lo ${b.lo}`).toBe(b.signal);
          const prev = o.bands[i - 1]!;
          expect(evaluateSignal(ev.def, put(ev.points, o.basis, Number((b.lo - tick).toFixed(o.decimals)))).signal).toBe(prev.signal);
        }
        if (b.hi !== null) expect(evaluateSignal(ev.def, put(ev.points, o.basis, b.hi)).signal, `${o.id} hi ${b.hi}`).toBe(b.signal);
      }
    }
  });

  it('盤中資料算今日收盤（取代最後一筆）；收盤資料算下一筆', () => {
    expect(outlooks.spx!.basis).toBe(summary.entries.spx!.partial ? 'today' : 'next');
    expect(outlooks.us10y!.basis).toBe('next');
    expect(outlooks.us10y!.targetDate).toBe('2026-10-05');
  });

  it('美債：門檻＝20 筆前的值 ± 20bp（下一筆的基準往前滾一天）', () => {
    const ev = regime.evals.find((e) => e.def.id === 'us10y')!;
    const ref = ev.points.at(-20)![1];
    const o = outlooks.us10y!;
    const bear = o.bands.find((b) => b.signal === 'bear')!;
    const bull = o.bands.find((b) => b.signal === 'bull')!;
    expect(bear.lo).toBeCloseTo(ref + 0.2, 6);
    expect(bull.hi).toBeCloseTo(ref - 0.2, 6);
  });

  it('股價趨勢：偏多門檻＝三條件門檻的最高者（收盤需高於）', () => {
    const o = outlooks.taiex!;
    const lines = o.trendLines!;
    const max = Math.max(...lines.map((l) => l.at));
    const bull = o.bands.find((b) => b.signal === 'bull')!;
    expect(bull.lo).toBe(Math.floor(max) + 1);
    expect(o.bands.find((b) => b.signal === 'neutral')!.hi).toBe(Math.floor(max));
    // 指數門檻以整數點顯示
    expect(o.decimals).toBe(0);
  });

  it('趨勢條件算式與規則一致：價位剛好跨過 MA60 時，依據文字跟著改變', () => {
    const ev = regime.evals.find((e) => e.def.id === 'taiex')!;
    const ma60 = trendLines(ev.points, 'next')!.find((l) => l.key === 'ma60')!.at;
    expect(evaluateSignal(ev.def, put(ev.points, 'next', ma60 + 0.01)).reason).toContain('收盤>MA60');
    expect(evaluateSignal(ev.def, put(ev.points, 'next', ma60 - 0.01)).reason).toContain('收盤<MA60');
  });
});

describe('合成資料', () => {
  const us10y = getIndicator('us10y');

  it('10Y 20 日前 5.00、現在 5.21 → 偏空；下一筆 ≤ 5.19 轉中性', () => {
    // 21 筆：第 1 筆 4.99、第 2 筆 5.00，其後慢慢升到 5.21
    const v = [4.99, 5.0, ...linear(18, 5.01, 0.01), 5.21];
    const pts = dailySeries('2026-09-01', v);
    expect(evaluateSignal(us10y, pts).signal).toBe('bear');
    const { bands } = dailyBands(us10y, pts, 'next');
    // 下一筆的基準是 5.00
    expect(bands.find((b) => b.signal === 'bear')!.lo).toBe(5.2);
    expect(bands.find((b) => b.signal === 'neutral')!.hi).toBe(5.19);
  });

  it('持平漂移：急升發生在 20 日前附近，持平幾天後就會滾出視窗', () => {
    // 25 筆 4.80，接著一天跳到 5.10，之後持平 5 筆
    const v = [...Array(25).fill(4.8), 5.1, 5.1, 5.1, 5.1, 5.1, 5.1];
    const pts = dailySeries('2026-08-03', v);
    expect(evaluateSignal(us10y, pts).signal).toBe('bear');
    // 跳升那天是倒數第 6 筆；再過 15 筆它就成了 20 筆前的基準，變化歸零
    expect(driftIfFlat(us10y, pts)).toEqual({ steps: 15, signal: 'neutral' });
  });

  it('沒有資料就不算', () => {
    const ev = regime.evals.find((e) => e.def.id === 'us10y')!;
    expect(dailyOutlook({ ...ev, points: ev.points.slice(0, 50) }, regime, false)).toBeNull();
  });
});

describe('總分距離與雷達', () => {
  it('距偏空／偏多與需要的權重', () => {
    const gaps = regimeGaps(regime);
    const used = regime.evals.filter((e) => e.counted).reduce((s, e) => s + e.def.weight, 0);
    const bear = gaps.find((g) => g.direction === 'bear')!;
    expect(bear.gap).toBeCloseTo(regime.score + REGIME_THRESHOLD, 9);
    expect(bear.weight).toBeCloseTo(bear.gap * used, 9);
    expect(gapText(0.37, 'bear')).toBe('任一權重 0.5 以上的指標轉弱一級就會翻');
    expect(gapText(1.85, 'bull')).toBe('需要權重合計 1.9 的指標轉強一級');
  });

  it('雷達依日波動排序，只列真的會改變判斷的門檻', () => {
    const r = radar(outlooks);
    const s = r.flips.map((f) => f.flip.sigmas ?? 99);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
    for (const { id, flip } of r.flips) expect(flip.signal).not.toBe(outlooks[id]!.current);
    expect(r.drifts.every((d, i, a) => i === 0 || a[i - 1]!.drift.steps <= d.drift.steps)).toBe(true);
  });

  it('文字：移動量、σ 與單日機率', () => {
    expect(tailProb(0)).toBeCloseTo(0.5, 6);
    expect(tailProb(1)).toBeCloseTo(0.1587, 3);
    expect(tailProb(2)).toBeCloseTo(0.0228, 3);
    expect(moveText(getIndicator('us10y'), -0.02, null)).toBe('再降 2bp');
    expect(moveText(getIndicator('taiex'), -4242, -8.51)).toBe('再跌 8.5%');
    expect(sigmaText(0.43)).toBe('0.4σ，單日約 33%');
  });

  it('Actions 摘要包含總分、距離與門檻', () => {
    const lines = radarLines(summary, new Date('2026-10-07T04:00:00Z'));
    expect(lines[0]).toMatch(/^總分 /);
    expect(lines.some((l) => l.startsWith('距'))).toBe(true);
    expect(lines.some((l) => /→.*：(今日|下一筆)收盤/.test(l))).toBe(true);
  });
});

describe('UI', () => {
  it('翻轉雷達顯示距離與最接近的門檻', () => {
    render(<RadarPanel regime={regime} outlooks={outlooks} onSelect={() => {}} />);
    expect(screen.getByText('🎯 翻轉雷達')).toBeTruthy();
    expect(screen.getAllByText(/距(偏空|偏多|中性)/).length).toBeGreaterThan(0);
    expect(screen.getByText('最接近的門檻（依日波動排序）')).toBeTruthy();
  });

  it('每日指標列顯示下一個收盤的門檻與趨勢條件', () => {
    const rows = regime.evals.map((ev) => buildRow(ev, summary));
    render(
      <IndicatorTable
        rows={rows}
        today={TODAY}
        selectedId={null}
        onSelect={() => {}}
        dailyOutlooks={outlooks}
        nowScore={regime.score}
        now={new Date('2026-10-07T04:00:00Z')}
      />,
    );
    expect(screen.getAllByText(/📍 (今日|下一筆)收盤/).length).toBe(9);
    expect(screen.getByText('≥ 45,581 → 偏多')).toBeTruthy();
    expect(screen.getAllByText(/收盤需高於：/).length).toBe(5);
  });
});
