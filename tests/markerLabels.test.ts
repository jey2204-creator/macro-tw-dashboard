import { describe, expect, it } from 'vitest';
import { layoutStacked } from '../src/lib/markerLabels';

describe('事件標籤排版', () => {
  it('不重疊的留在原位；重疊的往外推一格，不疊的回到原位', () => {
    // 下方（dir=1）：x 10、12、13 互疊，60 不疊；高 10、間距 2 → 每格 12
    const cy = layoutStacked([{ x: 10, w: 20, y: 100 }, { x: 12, w: 20, y: 100 }, { x: 13, w: 20, y: 100 }, { x: 60, w: 20, y: 100 }], 10, 1);
    expect(cy).toEqual([100, 112, 124, 100]);
  });
  it('上方往上推；輸入順序不影響', () => {
    expect(layoutStacked([{ x: 12, w: 20, y: 100 }, { x: 10, w: 20, y: 100 }], 10, -1)).toEqual([88, 100]);
  });
  it('相鄰 K 棒高度不同：基準 y 差一點仍算重疊，會推開', () => {
    expect(layoutStacked([{ x: 10, w: 20, y: 100 }, { x: 15, w: 20, y: 106 }], 10, 1)).toEqual([100, 118]);
    // 差很多就不用推
    expect(layoutStacked([{ x: 10, w: 20, y: 100 }, { x: 15, w: 20, y: 130 }], 10, 1)).toEqual([100, 130]);
  });
  it('碰到折線也會往外推', () => {
    // 折線在 y 105～115 之間經過標籤下方：基準 100 的標籤（高 10）會碰到 → 推到 118 之後不碰
    const band = () => ({ lo: 105, hi: 115 });
    expect(layoutStacked([{ x: 10, w: 20, y: 100 }], 10, 1, 2, band)).toEqual([124]);
    expect(layoutStacked([{ x: 10, w: 20, y: 100 }], 10, -1, 2, band)).toEqual([88]);
    expect(layoutStacked([{ x: 10, w: 20, y: 100 }], 10, 1, 2, () => null)).toEqual([100]);
  });
});
