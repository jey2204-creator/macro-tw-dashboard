import { describe, expect, it } from 'vitest';
import { getIndicator, toneClass } from '../src/shared/indicators';
import { formatSigned } from '../src/lib/format';

describe('多空語意上色', () => {
  it('一般指標：上升＝up、下降＝down', () => {
    expect(toneClass({}, 'up')).toBe('up');
    expect(toneClass({}, 'down')).toBe('down');
    expect(toneClass({}, 'flat')).toBe('');
  });
  it('跌停、下跌家數為空方指標：上升改用 down 色', () => {
    for (const id of ['limit_down', 'decline']) {
      const def = getIndicator(id);
      expect(def.bearish).toBe(true);
      expect(toneClass(def, 'up')).toBe('down');
      expect(toneClass(def, 'down')).toBe('up');
    }
    expect(getIndicator('limit_up').bearish).toBeFalsy();
  });
  it('家數不加正號', () => {
    expect(formatSigned(getIndicator('limit_down'), 21)).toBe('21家');
    expect(formatSigned(getIndicator('margin_chg'), 1.5)).toBe('+1.50億');
  });
});
