import { describe, expect, it } from 'vitest';
import { adRatio, analyzeBreadth, combineBreadthRows, panicFlags, type BreadthRow } from '../src/shared/breadthStress';
import type { Bar } from '../src/shared/types';

const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

/** 300 天平靜 → 第 300、301 天恐慌（跌停 200）→ 再跌但跌停少 → 漲停多於跌停回升 */
function series(): BreadthRow[] {
  const rows: BreadthRow[] = [];
  for (let i = 0; i < 400; i++) {
    let px = 10000;
    let ul = 10;
    let dl = 2 + (i % 3);
    let up = 500;
    let down = 400;
    if (i === 300 || i === 301) [px, ul, dl, up, down] = [9000 - (i - 300) * 300, 1, 200, 30, 900];
    else if (i >= 302 && i < 306) [px, ul, dl, up, down] = [8600 - (i - 302) * 50, 3, 40, 200, 700];
    else if (i >= 306) [px, ul, dl, up, down] = [8500 + (i - 306) * 20, 30, 2, 700, 200];
    rows.push([day(i), px, ul, dl, up, down, i === 301 ? 135 : 180]);
  }
  return rows;
}

describe('breadthStress', () => {
  it('合併：需四項家數齊全', () => {
    const taiex: Bar[] = [
      ['2020-01-02', 1, 1, 1, 100],
      ['2020-01-03', 1, 1, 1, 101],
    ];
    const rows = combineBreadthRows(
      [{ date: '2020-01-02', up: 5, upLimit: 1, down: 4, downLimit: 0 }],
      { downLimit: [['2020-01-03', 0, 0, 0, 3]] },
      taiex,
      new Map([['2020-01-02', 170]]),
    );
    expect(rows).toEqual([['2020-01-02', 100, 1, 0, 5, 4, 170]]);
  });

  it('恐慌日以百分位判斷，且需跌停占比 ≥ 3%', () => {
    const { panic } = panicFlags(series());
    expect(panic[300]).toBe(true);
    expect(panic[301]).toBe(true);
    expect(panic.slice(0, 300).some(Boolean)).toBe(false);
  });

  it('事件順序：恐慌 → 投降 → 背離 → 止跌，每波各一次', () => {
    const out = analyzeBreadth(series(), new Date('2026-10-15T00:00:00Z'));
    expect(out.events.map((e) => e.type)).toEqual(['panic', 'capitulate', 'divergence', 'stabilized']);
    expect(out.events[1]!.date).toBe(day(301));
    expect(out.latest?.inEpisode).toBe(false);
  });

  it('10 日漲跌比', () => {
    const r = adRatio(series());
    expect(r[8]).toBeNull();
    expect(r[9]).toBe(1.25);
  });
});
