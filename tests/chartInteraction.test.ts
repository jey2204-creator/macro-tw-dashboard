import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { CHART_INTERACTION, PANE_STRETCH, resetPaneStretch, resetPriceScales } from '../src/lib/chartInteraction';

describe('圖表手機互動設定', () => {
  it('上下滑交給網頁、Y 軸不可拖曳、窗格分隔線不可拖曳', () => {
    expect(CHART_INTERACTION.handleScroll).toMatchObject({ vertTouchDrag: false });
    expect(CHART_INTERACTION.handleScale).toMatchObject({ axisPressedMouseMove: { time: true, price: false } });
    expect(CHART_INTERACTION.layout?.panes?.enableResize).toBe(false);
  });

  it('重設：每個窗格 Y 軸恢復自動縮放、高度比例設回預設', () => {
    const applyOptions = vi.fn();
    const setStretchFactor = vi.fn();
    const chart = {
      panes: () => [{ setStretchFactor }, { setStretchFactor }, { setStretchFactor }],
      priceScale: () => ({ applyOptions }),
    } as unknown as IChartApi;
    resetPriceScales(chart);
    expect(applyOptions).toHaveBeenCalledTimes(3);
    expect(applyOptions).toHaveBeenCalledWith({ autoScale: true });
    resetPaneStretch(chart);
    expect(setStretchFactor.mock.calls.map((c) => c[0])).toEqual([...PANE_STRETCH]);
  });

  it('單窗格圖只有一個窗格時不會套到多餘的比例', () => {
    const setStretchFactor = vi.fn();
    const chart = { panes: () => [{ setStretchFactor }], priceScale: () => ({ applyOptions: vi.fn() }) } as unknown as IChartApi;
    resetPaneStretch(chart);
    expect(setStretchFactor).toHaveBeenCalledTimes(1);
    expect(setStretchFactor).toHaveBeenCalledWith(PANE_STRETCH[0]);
  });
});

describe('finestTickType', () => {
  it('依可視天數決定最細印到哪一層', async () => {
    const { finestTickType } = await import('../src/lib/chartInteraction');
    expect(finestTickType(90)).toBe(3); // 3個月：到日
    expect(finestTickType(365)).toBe(1); // 1年：到月
    expect(finestTickType(365 * 5)).toBe(0); // 5年：只印年
  });
});
