import { describe, expect, it } from 'vitest';
import { addMonths, daysBetween, rocToIso, toLocalDate, todayInTaipei, weekKey } from '../src/shared/dates';

describe('dates', () => {
  it('toLocalDate 依交易所時區換算（含夏令時間）', () => {
    // 2026-10-05 23:00Z = 倫敦 BST 10/06 00:00
    expect(toLocalDate(1791241200, 'Europe/London')).toBe('2026-10-06');
    // 冬令時間 2026-01-05 00:00Z = 倫敦 01-05
    expect(toLocalDate(Date.UTC(2026, 0, 5) / 1000, 'Europe/London')).toBe('2026-01-05');
    // 台股 09:00 開盤 = 01:00Z
    expect(toLocalDate(Date.UTC(2026, 9, 6, 1) / 1000, 'Asia/Taipei')).toBe('2026-10-06');
    // 美股 9:30 ET（13:30Z 夏令）
    expect(toLocalDate(Date.UTC(2026, 9, 5, 13, 30) / 1000, 'America/New_York')).toBe('2026-10-05');
  });

  it('todayInTaipei 跨日正確', () => {
    // UTC 10/06 16:30 = 台北 10/07 00:30
    expect(todayInTaipei(new Date('2026-10-06T16:30:00Z'))).toBe('2026-10-07');
  });

  it('addMonths 處理月底', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
    expect(addMonths('2026-10-06', -6)).toBe('2026-04-06');
  });

  it('weekKey 取 ISO 週一', () => {
    expect(weekKey('2026-10-07')).toBe('2026-10-05'); // 週三
    expect(weekKey('2026-10-11')).toBe('2026-10-05'); // 週日
    expect(weekKey('2026-10-05')).toBe('2026-10-05');
  });

  it('daysBetween 與民國日期', () => {
    expect(daysBetween('2026-09-30', '2026-10-07')).toBe(7);
    expect(rocToIso('115/09/01')).toBe('2026-09-01');
    expect(rocToIso('99/1/5')).toBe('2010-01-05');
    expect(rocToIso('abc')).toBeNull();
  });
});
