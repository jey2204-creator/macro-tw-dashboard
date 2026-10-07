import { addDays } from '../src/shared/dates';
import type { Point } from '../src/shared/timeseries';

/** 產生連續日資料（含週末，測試用） */
export function dailySeries(start: string, values: number[]): Point[] {
  return values.map((v, i) => [addDays(start, i), v]);
}

export function monthlySeries(startYear: number, values: number[]): Point[] {
  return values.map((v, i) => {
    const y = startYear + Math.floor(i / 12);
    const m = (i % 12) + 1;
    return [`${y}-${String(m).padStart(2, '0')}-01`, v];
  });
}

export const linear = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => from + i * step);
