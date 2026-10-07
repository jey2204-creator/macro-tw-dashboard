import { describe, expect, it } from 'vitest';
import { INDICATORS, getIndicator } from '../src/shared/indicators';
import { computeRegime, scoreToSignal } from '../src/shared/regime';
import type { SummaryEntry, SummaryFile } from '../src/shared/types';
import { dailySeries, linear } from './helpers';

const entry = (id: string, tail: [string, number][], status: SummaryEntry['status'] = 'ok'): SummaryEntry => ({
  id,
  source: { provider: 'test', symbol: id, url: '' },
  status,
  fetchedAt: '2026-10-06T00:00:00Z',
  lastSuccessAt: '2026-10-06T00:00:00Z',
  lastDate: tail.at(-1)?.[0] ?? null,
  closeOnly: true,
  partial: false,
  errors: [],
  tail,
});

const summary = (entries: SummaryEntry[]): SummaryFile => ({
  schemaVersion: 1,
  generatedAt: '2026-10-06T00:00:00Z',
  entries: Object.fromEntries(entries.map((e) => [e.id, e])),
});

// 300 天資料，最後一天 = 2026-10-06
const up = dailySeries('2025-12-11', linear(300, 100, 1));
const down = dailySeries('2025-12-11', linear(300, 400, -1));

describe('computeRegime', () => {
  it('分數門檻', () => {
    expect(scoreToSignal(0.2)).toBe('bull');
    expect(scoreToSignal(0.19)).toBe('neutral');
    expect(scoreToSignal(-0.2)).toBe('bear');
  });

  it('僅股市指標皆上漲 → 偏多，但涵蓋率低時標示', () => {
    const s = summary(['sox', 'spx', 'nasdaq', 'taiex', 'tpex'].map((id) => entry(id, up)));
    const r = computeRegime(s, '2026-10-06');
    expect(r.signal).toBe('bull');
    expect(r.score).toBeCloseTo(1, 6);
    expect(r.lowCoverage).toBe(true);
    expect(r.bullCount).toBe(5);
  });

  it('加權平均：權重決定方向', () => {
    const s = summary([entry('sox', up), entry('spx', down), entry('us10y', dailySeries('2026-09-01', linear(36, 4, 0.02)))]);
    const r = computeRegime(s, '2026-10-06');
    const w = (id: string) => getIndicator(id).weight;
    // sox 偏多、spx 偏空、10Y 急升偏空
    expect(r.score).toBeCloseTo((w('sox') - w('spx') - w('us10y')) / (w('sox') + w('spx') + w('us10y')), 6);
  });

  it('權重 0 的指標標示「僅供參考」且不影響分數', () => {
    const s = summary([entry('sox', up), entry('wti', dailySeries('2026-09-01', linear(36, 60, 1)))]);
    const r = computeRegime(s, '2026-10-06');
    const wti = r.evals.find((e) => e.def.id === 'wti')!;
    expect(wti.signal.signal).toBe('bear');
    expect(wti.excludedReason).toBe('僅供參考');
    expect(r.score).toBeCloseTo(1, 6);
  });

  it('過時與失敗的指標不計分，並標示原因', () => {
    const old = dailySeries('2025-01-01', linear(300, 100, 1)); // 最後日 2025-10-27
    const s = summary([entry('sox', up), entry('spx', old), entry('nasdaq', [], 'error')]);
    const r = computeRegime(s, '2026-10-06');
    const byId = Object.fromEntries(r.evals.map((e) => [e.def.id, e]));
    expect(byId.spx!.counted).toBe(false);
    expect(byId.spx!.excludedReason).toBe('資料過時');
    expect(byId.nasdaq!.excludedReason).toBe('資料抓取失敗');
    expect(byId.cpi!.excludedReason).toBe('資料抓取失敗'); // 不存在於 summary
    expect(r.score).toBeCloseTo(1, 6);
  });

  it('隱藏指標不出現在評估清單', () => {
    const r = computeRegime(summary([]), '2026-10-06');
    expect(r.evals.find((e) => e.def.id === 'fed_lower')).toBeUndefined();
    expect(r.evals).toHaveLength(INDICATORS.filter((d) => !d.hidden).length);
    expect(r.signal).toBe('neutral');
    expect(r.coverage).toBe(0);
  });

  it('類別分數', () => {
    const s = summary([entry('taiex', up), entry('tpex', down)]);
    const r = computeRegime(s, '2026-10-06');
    const tw = r.categories.find((c) => c.category === 'tw_equity')!;
    const w = getIndicator('taiex').weight + getIndicator('tpex').weight;
    expect(tw.score).toBeCloseTo((getIndicator('taiex').weight - getIndicator('tpex').weight) / w, 6);
    expect(r.categories.find((c) => c.category === 'macro')!.score).toBeNull();
  });
});
