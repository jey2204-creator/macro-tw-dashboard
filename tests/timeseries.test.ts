import { describe, expect, it } from 'vitest';
import {
  changeOver,
  isValidBar,
  lastChange,
  mergeBars,
  rangeStart,
  resample,
  sma,
  transformPoints,
  valueAtOrBefore,
  type Point,
} from '../src/shared/timeseries';
import type { Bar } from '../src/shared/types';

const bar = (d: string, o: number, h: number, l: number, c: number): Bar => [d, o, h, l, c];

describe('sma', () => {
  it('資料不足處為 null，之後為正確平均', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('n 大於資料長度時全為 null', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });
});

describe('resample', () => {
  const daily: Bar[] = [
    bar('2026-09-28', 10, 12, 9, 11), // 週一
    bar('2026-09-30', 11, 15, 10, 14), // 週三
    bar('2026-10-01', 14, 14, 8, 9), // 週四（跨月）
    bar('2026-10-05', 9, 10, 7, 8), // 下週一
  ];
  it('週 K：開=首日開、高=區間最高、低=區間最低、收=末日收，日期=末交易日', () => {
    expect(resample(daily, 'W')).toEqual([bar('2026-10-01', 10, 15, 8, 9), bar('2026-10-05', 9, 10, 7, 8)]);
  });
  it('月 K', () => {
    expect(resample(daily, 'M')).toEqual([bar('2026-09-30', 10, 15, 9, 14), bar('2026-10-05', 14, 14, 7, 8)]);
  });
  it('日 K 回傳複本', () => {
    const r = resample(daily, 'D');
    expect(r).toEqual(daily);
    expect(r).not.toBe(daily);
  });
});

describe('transformPoints', () => {
  const monthly: Point[] = Array.from({ length: 14 }, (_, i) => {
    const y = 2025 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return [`${y}-${String(m).padStart(2, '0')}-01`, 100 + i];
  });
  it('yoy：與 12 個月前比較的年增率', () => {
    const r = transformPoints({ transform: 'yoy' }, monthly);
    expect(r).toHaveLength(2);
    expect(r[0]![0]).toBe('2026-01-01');
    expect(r[0]![1]).toBeCloseTo(12, 6);
  });
  it('diff：只計算連續月份', () => {
    const pts: Point[] = [
      ['2026-01-01', 100],
      ['2026-02-01', 130],
      ['2026-05-01', 150], // 缺 3、4 月
      ['2026-06-01', 140],
    ];
    expect(transformPoints({ transform: 'diff' }, pts)).toEqual([
      ['2026-02-01', 30],
      ['2026-06-01', -10],
    ]);
  });
});

describe('變化與查詢', () => {
  const pts: Point[] = [
    ['2026-01-01', 100],
    ['2026-01-02', 110],
    ['2026-01-05', 99],
  ];
  it('lastChange', () => {
    const c = lastChange(pts);
    expect(c.abs).toBe(-11);
    expect(c.pct).toBeCloseTo(-10, 6);
  });
  it('lastChange 單筆資料', () => {
    expect(lastChange([['2026-01-01', 1]]).abs).toBeNull();
  });
  it('changeOver', () => {
    expect(changeOver(pts, 2)!.abs).toBe(-1);
    expect(changeOver(pts, 3)).toBeNull();
  });
  it('valueAtOrBefore 二分搜尋', () => {
    expect(valueAtOrBefore(pts, '2026-01-04')).toEqual(['2026-01-02', 110]);
    expect(valueAtOrBefore(pts, '2025-12-31')).toBeNull();
    expect(valueAtOrBefore(pts, '2026-02-01')).toEqual(['2026-01-05', 99]);
  });
  it('rangeStart', () => {
    expect(rangeStart('2026-10-06', '6M')).toBe('2026-04-06');
    expect(rangeStart('2026-10-06', '5Y')).toBe('2021-10-06');
    expect(rangeStart('2026-10-06', 'ALL')).toBeNull();
  });
});

describe('mergeBars / isValidBar', () => {
  it('同日以新資料覆蓋並排序', () => {
    const merged = mergeBars(
      [bar('2026-01-02', 1, 1, 1, 1), bar('2026-01-01', 1, 1, 1, 1)],
      [bar('2026-01-02', 2, 2, 2, 2), bar('2026-01-03', 3, 3, 3, 3)],
    );
    expect(merged.map((b) => b[0])).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(merged[1]![4]).toBe(2);
  });
  it('拒絕 NaN、高<低、日期格式錯誤', () => {
    expect(isValidBar(bar('2026-01-01', 1, 2, 0.5, 1))).toBe(true);
    expect(isValidBar(bar('2026-01-01', 1, 0.5, 2, 1))).toBe(false);
    expect(isValidBar(bar('2026-01-01', NaN, 2, 1, 1))).toBe(false);
    expect(isValidBar(bar('2026/01/01', 1, 2, 1, 1))).toBe(false);
  });
});
