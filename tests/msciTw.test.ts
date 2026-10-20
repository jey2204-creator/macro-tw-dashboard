import { describe, expect, it } from 'vitest';
import { fwdEpsPath, mergeMsci, msciSummary, type MsciRecord, type MsciTwFile } from '../src/shared/msciTw';
import type { Point } from '../src/shared/timeseries';

const rec = (asOf: string, fwdPe: number, ytd: number | null, extra: Partial<MsciRecord> = {}): MsciRecord => ({
  asOf,
  fwdPe,
  pe: null,
  pbv: null,
  dy: 0,
  ret1m: null,
  ytd,
  acwiFwdPe: null,
  ...extra,
});
const file = (records: MsciRecord[], annual: Record<string, number> = {}): MsciTwFile => ({
  schemaVersion: 1,
  generatedAt: '2026-10-20T00:00:00Z',
  records,
  annual,
});

describe('MSCI 台灣：合併紀錄', () => {
  it('同資料日以新的為準、依日期排序；年度報酬合併', () => {
    const old = file([rec('2026-05-29', 22.71, 60.54)], { '2024': 35.07 });
    const merged = mergeMsci(
      old,
      [
        { ...rec('2026-09-30', 18.65, 70.7), annual: { '2025': 39.84 } },
        { ...rec('2026-05-29', 22.7, 60.54), annual: {} },
      ],
      new Date('2026-10-20T00:00:00Z'),
    );
    expect(merged.records.map((r) => [r.asOf, r.fwdPe])).toEqual([
      ['2026-05-29', 22.7],
      ['2026-09-30', 18.65],
    ]);
    expect(merged.annual).toEqual({ '2024': 35.07, '2025': 39.84 });
    expect(merged.generatedAt).toBe('2026-10-20T00:00:00.000Z');
  });
});

describe('MSCI 台灣：未來 12 月 EPS 預估走勢（台幣計）', () => {
  const fx: Point[] = [
    ['2025-12-31', 31],
    ['2026-01-30', 31],
    ['2026-05-29', 31],
    ['2026-09-30', 32],
  ];

  it('同一年：今年以來報酬相除 × 前後預估本益比 × 匯率', () => {
    // 5 月底 → 9 月底：含息報酬 1.707/1.6054、本益比 22.71 → 18.65、匯率 31 → 32（殖利率 0）
    const path = fwdEpsPath(file([rec('2026-05-29', 22.71, 60.54), rec('2026-09-30', 18.65, 70.7)]), fx);
    expect(path[0]).toEqual({ asOf: '2026-05-29', fwdPe: 22.71, eps: 100, chg: null, months: null });
    const want = (1.707 / 1.6054) * (22.71 / 18.65) * (32 / 31);
    expect(path[1]!.chg).toBeCloseTo((want - 1) * 100, 8);
    expect(path[1]!.months).toBe(4);
  });

  it('跨年：乘上中間年份的年度報酬；殖利率扣掉（兩期平均 × 年數）', () => {
    const recs = [rec('2025-12-31', 18.4, 39.84, { dy: 2 }), rec('2026-01-30', 19.26, 11.16, { dy: 2 })];
    const path = fwdEpsPath(file(recs, { '2025': 39.84 }), fx);
    const years = (Date.parse('2026-01-30') - Date.parse('2025-12-31')) / (365.25 * 86_400_000);
    const want = (1.1116 / 1.3984) * 1.3984 * Math.exp(-0.02 * years) * (18.4 / 19.26);
    expect(path[1]!.chg).toBeCloseTo((want - 1) * 100, 8);
    expect(path[1]!.months).toBe(1);
  });

  it('缺中間年份的年度報酬、或缺匯率：斷開重新起算', () => {
    const recs = [rec('2024-06-28', 19.27, 29.62), rec('2026-01-30', 19.26, 11.16)];
    // 沒有 2024、2025 年度報酬
    const path = fwdEpsPath(file(recs, {}), [['2024-06-28', 32.5], ['2026-01-30', 31.3]]);
    expect(path.map((p) => [p.eps, p.chg])).toEqual([
      [100, null],
      [100, null],
    ]);
    // 缺匯率（超過 7 天沒有報價）
    const p2 = fwdEpsPath(file([rec('2026-05-29', 22.71, 60.54), rec('2026-09-30', 18.65, 70.7)]), [['2026-05-29', 31]]);
    expect(p2[1]).toMatchObject({ eps: null, chg: null });
  });
});

describe('MSCI 台灣：讀數', () => {
  const fx: Point[] = [
    ['2026-05-29', 31.424],
    ['2026-09-30', 31.85],
  ];
  const recs = [
    rec('2022-11-30', 12.19, -25.07),
    rec('2026-05-29', 22.71, 60.54, { dy: 1.39 }),
    rec('2026-09-30', 18.65, 70.7, { pe: 29.51, acwiFwdPe: 16.2, dy: 1.36 }),
  ];

  it('隱含成長、對全球溢價、EPS 預估變化、歷史範圍', () => {
    const s = msciSummary(file(recs), fx, '2026-10-20')!;
    expect(s.latest.asOf).toBe('2026-09-30');
    expect(s.impliedGrowth).toBeCloseTo((29.51 / 18.65 - 1) * 100, 8);
    expect(s.premium).toBeCloseTo((18.65 / 16.2 - 1) * 100, 8);
    expect(s.prevAsOf).toBe('2026-05-29');
    expect(s.epsMonths).toBe(4);
    expect(s.epsChg!).toBeGreaterThan(30);
    expect(s.epsChg!).toBeLessThan(31);
    expect(s.cut).toBe(false);
    expect([s.n, s.min.asOf, s.max.asOf, s.median]).toEqual([3, '2022-11-30', '2026-05-29', 18.65]);
    expect(s.stale).toBe(false);
  });

  it('預估 EPS 持平或減少 → 下修；超過 2 個月沒有新資料 → 過時', () => {
    // 價格不變、預估本益比上升 → 預估 EPS 減少
    const cutRecs = [rec('2026-08-31', 18.9, 60), rec('2026-09-30', 19.5, 60)];
    const s = msciSummary(file(cutRecs), [['2026-08-31', 31.6], ['2026-09-30', 31.6]], '2026-10-20')!;
    expect(s.cut).toBe(true);
    expect(s.epsChg).toBeCloseTo((18.9 / 19.5 - 1) * 100, 8);
    expect(msciSummary(file(cutRecs), [], '2026-12-15')!.stale).toBe(true);
    expect(msciSummary(null, fx, '2026-10-20')).toBeNull();
  });
});
