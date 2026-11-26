// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InflExpectCard } from '../src/components/InflExpectCard';
import { beLevel, expAt, expBaselines, expHeadline, expSamples, expStats, michLevel, wageLevel, type ExpInputs } from '../src/shared/inflExpect';
import type { Point } from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';

afterEach(cleanup);

const monthly = (from: [number, number], vals: number[]): Point[] =>
  vals.map((v, i) => {
    const k = from[0] * 12 + (from[1] - 1) + i;
    return [`${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}-01`, v];
  });

const inp: ExpInputs = {
  // 2024-01 起 24 個月：前 12 個月 3.0，後 12 個月 4.5
  mich: monthly([2024, 1], [...Array(12).fill(3.0), ...Array(12).fill(4.5)]),
  be: [['2024-01-02', 2.2], ['2025-06-02', 2.6], ['2025-09-01', 2.3], ['2025-12-01', 2.1]],
  wage: monthly([2024, 1], Array(24).fill(3.5)),
  fed: [['2024-01-01', 5.5], ['2024-09-19', 5.0], ['2025-12-31', 5.0]],
  coreCpi: monthly([2023, 6], [...Array(18).fill(3.0), ...Array(13).fill(2.5)]),
};

describe('通膨預期與薪資卡', () => {
  it('門檻分級', () => {
    expect([michLevel(4), michLevel(3.5), michLevel(3)]).toEqual(['high', 'mid', 'low']);
    expect([beLevel(2.5), beLevel(2.2), beLevel(2)]).toEqual(['high', 'mid', 'low']);
    expect([wageLevel(4), wageLevel(3.5), wageLevel(3)]).toEqual(['high', 'mid', 'low']);
  });

  it('目前讀數與變化；回測時月資料晚 45 天才看得到', () => {
    const now = expAt(inp, '2025-12-31');
    expect(now.mich).toBe(4.5);
    expect(now.michLevel).toBe('high');
    expect(now.michChg3).toBe(0);
    expect(now.be).toBe(2.1);
    expect(now.beChg60).toBeCloseTo(-0.2);
    expect(now.wageLevel).toBe('mid');
    expect(expHeadline(now)).toBe('家庭預期偏高、債市預期穩定、薪資相容');
    // 2025-01 的 4.5 要到 2/15 之後才算已公布
    expect(expAt(inp, '2025-01-31', 45).mich).toBe(3.0);
    expect(expAt(inp, '2025-02-28', 45).mich).toBe(4.5);
    // 沒資料的尺回傳 null
    expect(expAt({ ...inp, be: [] }, '2025-12-31').beLevel).toBeNull();
  });

  it('分組回測：之後 12 個月 Fed 變動、核心 CPI 變動、指數報酬', () => {
    const spx: Bar[] = [['2024-01-02', 100, 100, 100, 100], ['2024-12-31', 110, 110, 110, 110], ['2025-12-31', 121, 121, 121, 121]];
    const samples = expSamples(inp, { spx }, '2024-01-01');
    const feb = samples.find((s) => s.date === '2024-02-29')!;
    expect(feb.reading.michLevel).toBe('low');
    expect(feb.fedChg).toBeCloseTo(-0.5);
    expect(feb.cpiChg).toBeCloseTo(-0.5);
    expect(feb.ret.spx).toBeCloseTo(10);
    // 12 個月後超出資料的月份不算
    expect(samples.find((s) => s.date === '2025-06-30')!.fedChg).toBeNull();
    const stats = expStats(samples, ['spx']);
    const low = stats.find((s) => s.key === 'mich' && s.group === 'low')!;
    expect(low.n).toBeGreaterThan(0);
    expect(low.cutPct).toBeGreaterThan(0);
    expect(expBaselines(samples, ['spx']).mich.n).toBeGreaterThanOrEqual(low.n);
  });

  it('卡片：三列讀數、分歧提示、回測表預設收起', () => {
    const spx: Bar[] = [['2024-01-02', 100, 100, 100, 100], ['2025-12-31', 121, 121, 121, 121]];
    const samples = expSamples(inp, { spx }, '2024-01-01');
    render(<InflExpectCard now={expAt(inp, '2025-12-31')} stats={expStats(samples, ['spx'])} baselines={expBaselines(samples, ['spx'])} hasTaiex={false} />);
    const card = document.querySelector('.ie')!;
    expect(card.querySelector('.ie-verdict')!.textContent).toMatch(/家庭預期偏高、債市預期穩定、薪資相容$/);
    const rows = [...card.querySelectorAll('.ie-table tbody tr')].map((tr) => tr.textContent);
    expect(rows[0]).toMatch(/密大 1 年通膨預期.*4\.5%.*12月｜3月 0\.0pp.*偏高/);
    expect(rows[1]).toMatch(/5Y5Y.*2\.10%.*12\/01｜60天 -0\.20pp.*穩定/);
    expect(rows[2]).toMatch(/平均時薪年增.*3\.5%.*相容/);
    expect(card.textContent).toContain('家庭預期偏高、債市沒跟');
    expect(card.querySelectorAll('table').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /展開回測/ }));
    expect(card.querySelectorAll('table').length).toBe(2);
    expect(card.querySelector('tr.hl')!.textContent).toMatch(/密大 ≥ 4%/);
  });
});
