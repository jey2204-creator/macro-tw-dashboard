import { describe, expect, it } from 'vitest';
import { analyzeMarginStress, combineStressRows, completionAt, completionGrade, completionSeries, detectEvents, stateAt, type StressRow } from '../src/shared/marginStress';
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
    const all = detectEvents(wave());
    // 同一天的大減也會標「去槓桿」（不限斷頭區），和斷頭潮同日
    expect(all.filter((e) => e.type === 'delever').map((e) => e.date)).toEqual([all.find((e) => e.type === 'flush')!.date]);
    const ev = all.filter((e) => e.type !== 'delever');
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

describe('融資大減與政策事件', () => {
  it('主動去槓桿：不限斷頭區、20 日內只標一次', () => {
    const rows: StressRow[] = [];
    let bal = 3000;
    for (let i = 0; i < 400; i++) {
      // 平常 ±0.2%；第 300、305、350 天各減 2.5%
      const chg = i === 300 || i === 305 || i === 350 ? -bal * 0.025 : i % 2 ? bal * 0.002 : -bal * 0.002;
      bal += chg;
      rows.push([day(i), 10000, 175, bal, chg]);
    }
    const ev = detectEvents(rows).filter((e) => e.type === 'delever');
    expect(ev.map((e) => e.date)).toEqual([day(300), day(350)]); // 305 在 20 日冷卻內
    expect(ev[0]!.ratio).toBe(175); // 維持率 175，不在斷頭區也會標
  });

  it('政策事件：取當天或之後第一個交易日；資料範圍外略過；說明帶進事件', () => {
    const rows: StressRow[] = [];
    for (let i = 0; i < 100; i++) {
      if (i % 7 === 5 || i % 7 === 6) continue; // 週末
      rows.push([day(i), 10000 + i * 10, 175, 3000, 0]);
    }
    const policy = [
      { date: day(5), type: 'shortBan' as const, note: '平盤下禁空' }, // 週末 → day(7)
      { date: day(7), type: 'nsf' as const },
      { date: day(500), type: 'nsf' as const }, // 尚未發生
      { date: '2000-01-01', type: 'shortBan' as const }, // 早於資料 7 天以上 → 略過
    ];
    const ev = detectEvents(rows, policy).filter((e) => e.type === 'shortBan' || e.type === 'nsf');
    expect(ev.map((e) => [e.date, e.type])).toEqual([
      [day(7), 'shortBan'],
      [day(7), 'nsf'],
    ]);
    expect(ev.find((e) => e.type === 'shortBan' && e.date === day(7))!.note).toBe('平盤下禁空');
    expect(ev.find((e) => e.date === day(7) && e.type === 'nsf')!.ret20).not.toBeNull();
    const out = analyzeMarginStress(rows, null, new Date(), policy);
    expect(out.eventStats.nsf.n).toBe(1);
    expect(out.eventStats.shortBan.n).toBe(1);
    expect(out.eventStats.delever.n).toBe(0);
  });
});

describe('去槓桿完成度', () => {
  const mk = (px: number[], bal: (number | null)[]): StressRow[] =>
    px.map((p, i) => [day(i), p, 170, bal[i] ?? NaN, 0] as StressRow);

  it('融資減幅 ÷ 指數跌幅；高點各自在視窗內找', () => {
    // 指數 100 → 80（-20%），融資 1000 → 820（-18%）；融資高點比指數高點早一天
    const rows = mk([90, 100, 95, 80], [1000, 990, 900, 820]);
    const c = completionAt(rows, 3)!;
    expect(c.dd).toBe(-20);
    expect(c.peakDate).toBe(day(1));
    expect(c.cut).toBe(-18);
    expect(c.balPeakDate).toBe(day(0));
    expect(c.ratio).toBe(0.9);
    expect(c.grade).toBe('mid');
  });

  it('指數回落不到 5% 不算；融資缺值不算', () => {
    expect(completionAt(mk([100, 97], [1000, 900]), 1)!.ratio).toBeNull();
    const c = completionAt(mk([100, 80], [1000, null]), 1)!;
    expect(c.cut).toBeNull();
    expect(c.ratio).toBeNull();
    expect(c.dd).toBe(-20);
  });

  it('視窗外的高點不算', () => {
    const rows = mk([200, 100, 100, 90], [2000, 1000, 1000, 950]);
    const c = completionAt(rows, 3, 2)!;
    expect(c.peak).toBe(100);
    expect(c.dd).toBe(-10);
    expect(c.cut).toBe(-5);
    expect(c.ratio).toBe(0.5);
    expect(c.grade).toBe('lag');
  });

  it('分級：< 0.6 落後、< 1 進行中、≥ 1 追上', () => {
    expect(completionGrade(0.59)).toBe('lag');
    expect(completionGrade(0.6)).toBe('mid');
    expect(completionGrade(1)).toBe('done');
  });

  it('序列長度與列數相同', () => {
    const rows = mk([100, 90, 80], [1000, 950, 850]);
    const s = completionSeries(rows);
    expect(s).toHaveLength(3);
    expect(s[2]).toEqual([day(2), -20, -15, 0.75]);
  });
});

describe('去槓桿追上大盤事件', () => {
  const mk = (px: number[], bal: number[]): StressRow[] => px.map((p, i) => [day(i), p, 170, bal[i]!, 0] as StressRow);

  it('跌幅 ≥ 10% 且完成度由 < 1 回到 ≥ 1 的第一天標一次', () => {
    // 高點 100；第 2 天 -12%（融資 -6%，0.5）→ 第 3 天 -15%（融資 -15%，1.0）→ 第 4 天仍 ≥ 1 不重標
    const rows = mk([100, 95, 88, 85, 84], [1000, 990, 940, 850, 830]);
    const ev = detectEvents(rows).filter((e) => e.type === 'caughtUp');
    expect(ev.map((e) => e.date)).toEqual([day(3)]);
  });

  it('沒有先 < 1 不標（融資一路跑在前面）；跌幅不到 10% 不標', () => {
    expect(detectEvents(mk([100, 90, 85], [1000, 850, 780])).filter((e) => e.type === 'caughtUp')).toHaveLength(0);
    expect(detectEvents(mk([100, 95, 92], [1000, 990, 920])).filter((e) => e.type === 'caughtUp')).toHaveLength(0);
  });

  it('指數回到高點 5% 以內後重新武裝，下一波可再標', () => {
    const px = [100, 95, 88, 85, 97, 99, 92, 88, 86];
    const bal = [1000, 990, 940, 850, 860, 870, 960, 900, 780];
    const ev = detectEvents(mk(px, bal)).filter((e) => e.type === 'caughtUp');
    expect(ev.map((e) => e.date)).toEqual([day(3), day(8)]);
  });
});
