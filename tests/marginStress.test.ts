import { describe, expect, it } from 'vitest';
import { analyzeMarginStress, combineStressRows, detectEvents, stateAt, type StressRow } from '../src/shared/marginStress';
import type { Bar } from '../src/shared/types';

const day = (i: number) => {
  const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
};

/** 造一段：維持率 170 → 跌到 130 → 回到 175；加權同步下跌後回升；融資在低點大減 */
function wave(): StressRow[] {
  const rows: StressRow[] = [];
  let bal = 3000;
  for (let i = 0; i < 400; i++) {
    let ratio = 170;
    let px = 10000;
    if (i >= 300 && i < 320) {
      ratio = 170 - (i - 299) * 2; // 168 → 130
      px = 10000 - (i - 299) * 150;
    } else if (i >= 320 && i < 340) {
      ratio = 130 + (i - 319) * 2.5;
      px = 7000 + (i - 319) * 100;
    } else if (i >= 340) {
      ratio = 180;
      px = 9000;
    }
    const chg = i === 318 ? -200 : i % 2 ? 5 : -5;
    bal += chg;
    rows.push([day(i), px, ratio, bal, chg]);
  }
  return rows;
}

describe('marginStress', () => {
  it('合併：每日資料覆蓋歷史，只保留有加權收盤的日子', () => {
    const taiex: Bar[] = [
      ['2020-01-02', 1, 1, 1, 100],
      ['2020-01-03', 1, 1, 1, 101],
      ['2020-01-06', 1, 1, 1, 102],
    ];
    const rows = combineStressRows(
      [
        ['2020-01-02', 170, 3000, -5],
        ['2020-01-03', 160, 2990, -10],
      ],
      { ratio: [['2020-01-03', 0, 0, 0, 161]] },
      taiex,
    );
    expect(rows).toEqual([
      ['2020-01-02', 100, 170, 3000, -5],
      ['2020-01-03', 101, 161, 2990, -10],
    ]);
  });

  it('狀態：<140 斷頭區、<160 或 5 日降 >15pp 警戒', () => {
    const r = (ratio: number): StressRow => ['d', 1, ratio, 1, 0];
    expect(stateAt([r(139)], 0)).toBe('zone');
    expect(stateAt([r(159)], 0)).toBe('warn');
    expect(stateAt([r(200), r(199), r(198), r(197), r(196), r(184)], 5)).toBe('warn');
    expect(stateAt([r(170)], 0)).toBe('normal');
  });

  it('事件：每一波各觸發一次，順序為 150 → 140 → 斷頭潮 → 清洗完成', () => {
    const ev = detectEvents(wave());
    expect(ev.map((e) => e.type)).toEqual(['below150', 'below140', 'flush', 'cleared']);
    const cleared = ev.at(-1)!;
    expect(cleared.ratio).toBeGreaterThanOrEqual(135);
    expect(cleared.date > ev[2]!.date).toBe(true);
  });

  it('回到 160% 以上後，下一波會重新觸發', () => {
    const one = wave();
    const two = [...one, ...wave().map((r, i): StressRow => [day(400 + i), r[1], r[2], r[3], r[4]])];
    expect(detectEvents(two).filter((e) => e.type === 'below140')).toHaveLength(2);
  });

  it('分析輸出含基準與最新狀態', () => {
    const out = analyzeMarginStress(wave(), '2020-01-01', new Date('2026-10-15T00:00:00Z'));
    expect(out.latest?.state).toBe('normal');
    expect(out.eventStats.below140.n).toBe(1);
    expect(out.baseline.n).toBe(400);
    expect(out.stateStats.zone.pct).toBeGreaterThan(0);
  });
});
