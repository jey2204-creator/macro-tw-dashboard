
import { describe, expect, it } from 'vitest';
import { dataDateLabel } from '../src/lib/format';
describe('dataDateLabel', () => {
  it('日資料顯示「月/日」＝資料截止日（hover 說明）', () => {
    expect(dataDateLabel('daily', '2026-10-16', '2026-10-17').text).toBe('10/16');
    expect(dataDateLabel('daily', '2025-12-31', '2026-10-17').text).toBe('25/12/31');
    expect(dataDateLabel('daily', '2026-10-16', '2026-10-17').title).toContain('資料截止日');
  });
  it('月資料顯示數據所屬月份，跨年加年份', () => {
    expect(dataDateLabel('monthly', '2026-09-01', '2026-10-17').text).toBe('9月');
    expect(dataDateLabel('monthly', '2025-12-01', '2026-10-17').text).toBe('25年12月');
  });
  it('季資料顯示年季', () => {
    expect(dataDateLabel('quarterly', '2026-07-01', '2026-10-17').text).toBe('2026Q3');
    expect(dataDateLabel('daily', null).text).toBe('—');
  });
});
