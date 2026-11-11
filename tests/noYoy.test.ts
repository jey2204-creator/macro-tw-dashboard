import { describe, expect, it } from 'vitest';
import { cpiYoyUnavailable } from '../src/shared/releaseHistory';

describe('cpiYoyUnavailable', () => {
  it('2025-10 缺指數 → 2026-10 沒有年增率', () => {
    expect(cpiYoyUnavailable('2026-10')).toBe(true);
  });
  it('其他月份照常', () => {
    expect(cpiYoyUnavailable('2026-09')).toBe(false);
    expect(cpiYoyUnavailable('2026-11')).toBe(false);
    expect(cpiYoyUnavailable('2025-10')).toBe(false);
  });
});
