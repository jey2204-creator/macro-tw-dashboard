import { describe, expect, it } from 'vitest';
import { ChartSync } from '../src/lib/chartSync';

function fake() {
  const log = { range: [] as unknown[], cross: [] as unknown[], clear: 0 };
  let onRange: ((r: unknown) => void) | null = null;
  let onCross: ((p: unknown) => void) | null = null;
  const chart = {
    timeScale: () => ({
      subscribeVisibleTimeRangeChange: (h: (r: unknown) => void) => (onRange = h),
      unsubscribeVisibleTimeRangeChange: () => (onRange = null),
      setVisibleRange: (r: unknown) => {
        log.range.push(r);
        onRange?.(r); // 真實圖表會再觸發事件：同步器要擋住迴圈
      },
    }),
    subscribeCrosshairMove: (h: (p: unknown) => void) => (onCross = h),
    unsubscribeCrosshairMove: () => (onCross = null),
    setCrosshairPosition: (v: number, t: string) => {
      log.cross.push([v, t]);
      onCross?.({ time: t });
    },
    clearCrosshairPosition: () => {
      log.clear++;
      onCross?.({});
    },
  };
  return { chart, log, fireRange: (r: unknown) => onRange?.(r), fireCross: (p: unknown) => onCross?.(p) };
}

describe('ChartSync', () => {
  it('拖曳／縮放：一張圖的日期範圍套到另一張，且不互相迴圈', () => {
    const a = fake();
    const b = fake();
    const s = new ChartSync();
    s.add('a', { chart: a.chart as never, series: () => ({}) as never, valueAt: () => 1 });
    s.add('b', { chart: b.chart as never, series: () => ({}) as never, valueAt: () => 1 });
    a.fireRange({ from: '2026-08-01', to: '2026-11-06' });
    expect(b.log.range).toEqual([{ from: '2026-08-01', to: '2026-11-06' }]);
    expect(a.log.range).toEqual([]);
  });

  it('十字線：同一天貼到另一張；對方當天沒資料或離開圖表時清除', () => {
    const a = fake();
    const b = fake();
    const s = new ChartSync();
    s.add('a', { chart: a.chart as never, series: () => ({}) as never, valueAt: () => 5 });
    s.add('b', { chart: b.chart as never, series: () => ({}) as never, valueAt: (t) => (t === '2026-11-06' ? -22.3 : null) });
    a.fireCross({ time: '2026-11-06' });
    expect(b.log.cross).toEqual([[-22.3, '2026-11-06']]);
    expect(a.log.cross).toEqual([]);
    a.fireCross({ time: '2026-11-05' });
    a.fireCross({});
    expect(b.log.clear).toBe(2);
  });

  it('解除註冊後不再同步', () => {
    const a = fake();
    const b = fake();
    const s = new ChartSync();
    s.add('a', { chart: a.chart as never, series: () => ({}) as never, valueAt: () => 1 });
    const off = s.add('b', { chart: b.chart as never, series: () => ({}) as never, valueAt: () => 1 });
    off();
    a.fireRange({ from: 'x', to: 'y' });
    expect(b.log.range).toEqual([]);
  });
});
