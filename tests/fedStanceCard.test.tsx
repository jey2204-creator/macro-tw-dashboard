// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FedStanceCard } from '../src/components/FedStanceCard';
import type { Stance, StanceStat } from '../src/shared/fedStance';

const now: Stance = {
  date: '2026-11-18', fed: 4, real: 1.44, realLean: 'tight', coreCpi: 2.56, taylor: 5.97, taylorGap: 1.97, taylorLean: 'loose',
  corePce: 3.12, corePceDate: '2026-09-01', unrate: 4.1, nrou: 4.39, us2y: 4.8, spread: 0.8, bet: 'hike',
};
const stat = (key: StanceStat['key'], group: StanceStat['group'], label: string): StanceStat => ({
  key, group, label, n: 100, fedChg: 0.39, hikePct: 57, cutPct: 32, ret: { spx: { mean: 7.7, n: 100 }, taiex: { mean: 10.4, n: 90 } },
});
const stats = [stat('real', 'tight', '實質利率 ≥ +1'), stat('taylor', 'loose', '泰勒缺口 ≥ +1（Fed 偏鬆）'), stat('taylor', 'mid', '泰勒缺口 ±1 內')];
const baseline = { n: 466, fedChg: -0.07, hikePct: 39, cutPct: 38, ret: { spx: { mean: 9.9, n: 466 }, taiex: { mean: 8.4, n: 340 } } };

describe('FedStanceCard', () => {
  it('三把尺讀數、公式、方向相反提示；回測預設收起', () => {
    const { container } = render(<FedStanceCard now={now} stats={stats} baseline={baseline} fromYear="1987" hasTaiex />);
    expect(screen.getByText('實質利率偏緊、比泰勒法則鬆、市場押升息')).toBeTruthy();
    expect(container.textContent).toContain('+1.97pp');
    expect(container.textContent).toContain('5.97 − 4.00');
    expect(container.textContent).toContain('+0.80pp');
    expect(container.textContent).toContain('兩把尺方向相反');
    expect(container.querySelectorAll('table')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button'));
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(container.querySelectorAll('tr.hl')).toHaveLength(2);
    expect(container.textContent).toContain('57%／32%');
  });

  it('沒有自然失業率：泰勒那格顯示無資料、不顯示公式與相反提示', () => {
    const { container } = render(
      <FedStanceCard now={{ ...now, taylor: null, taylorGap: null, taylorLean: null, nrou: null }} stats={stats} baseline={baseline} fromYear="1987" hasTaiex={false} />,
    );
    expect(container.textContent).toContain('無資料');
    expect(container.textContent).not.toContain('法則利率＝');
    expect(container.textContent).not.toContain('兩把尺方向相反');
  });
});
