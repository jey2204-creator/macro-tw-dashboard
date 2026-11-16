import { describe, expect, it } from 'vitest';
import { placeBaseLabel } from '../src/lib/baseLabel';
import { completionBaseLabels } from '../src/lib/completionBase';
import { completionAt, type StressRow } from '../src/shared/marginStress';

const rows = (px: number[], bal: (number | null)[], start = '2026-09-28'): StressRow[] =>
  px.map((p, i) => {
    const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    return [d, p, 170, bal[i] ?? NaN, 0];
  });

describe('去槓桿完成度基準點標籤', () => {
  it('指數高點與融資餘額高點各一個，日期各自算、都畫在 0%', () => {
    const r = rows([100, 110, 105, 90], [1000, 1010, 1050, 900]);
    const labels = completionBaseLabels(completionAt(r, 3), r[3]![0], 'k', 'b');
    expect(labels).toEqual([
      { time: '2026-09-29', value: 0, text: '指數高 9/29', color: 'k' },
      { time: '2026-09-30', value: 0, text: '融資高 9/30', color: 'b' },
    ]);
  });

  it('融資餘額缺值只標指數；跨年寫出年份；沒有資料不標', () => {
    const r = rows([100, 80], [null, null], '2025-12-31');
    expect(completionBaseLabels(completionAt(r, 1), r[1]![0], 'k', 'b').map((l) => l.text)).toEqual(['指數高 2025/12/31']);
    expect(completionBaseLabels(null, '', 'k', 'b')).toEqual([]);
  });

  it('第二個標籤避開第一個', () => {
    const size = { width: 300, height: 80 };
    const band = () => ({ lo: 6, hi: 6 });
    const a = placeBaseLabel(150, 6, 60, 12, size, band)!;
    const b = placeBaseLabel(156, 6, 60, 12, size, band, 4, [{ ...a, w: 60, h: 12 }], 160)!;
    // 不給 spread 時三個候選都撞到第一個 → 不標
    expect(placeBaseLabel(156, 6, 60, 12, size, band, 4, [{ ...a, w: 60, h: 12 }])).toBeNull();
    expect(Math.abs(b.cx - a.cx) >= 60 || Math.abs(b.cy - a.cy) >= 12).toBe(true);
  });
});
