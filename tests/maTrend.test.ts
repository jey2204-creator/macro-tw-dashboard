import { describe, expect, it } from 'vitest';
import { maTrend } from '../src/shared/maTrend';

describe('maTrend', () => {
  it('2026-10-22 讀數：短空、中期整理（跌破季線但季線仍在半年線上）、年線上', () => {
    const t = maTrend({ close: 46041, 10: 47571, 20: 48072, 60: 46207, 120: 45122, 240: 38232 });
    expect(t.short).toBe('bear');
    expect(t.mid).toBe('mixed');
    expect(t.long).toBe('above');
    expect(t.dev[60]!).toBeCloseTo(-0.36, 2);
    expect(t.dev[240]!).toBeCloseTo(20.43, 1);
  });
  it('多頭排列＝短多、中多；空頭排列＝短空、中空', () => {
    expect(maTrend({ close: 110, 10: 105, 20: 100, 60: 95, 120: 90, 240: 80 })).toMatchObject({ short: 'bull', mid: 'bull', long: 'above' });
    expect(maTrend({ close: 70, 10: 75, 20: 80, 60: 85, 120: 90, 240: 100 })).toMatchObject({ short: 'bear', mid: 'bear', long: 'below' });
  });
  it('均線資料不足時回 null，不亂判', () => {
    const t = maTrend({ close: 100, 10: 99, 20: 98 });
    expect(t.short).toBe('bull');
    expect(t.mid).toBeNull();
    expect(t.long).toBeNull();
    expect(t.dev[240]).toBeNull();
  });
});
