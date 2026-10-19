import { addMonths, monthKey } from '../shared/dates';
import { zoneAt, type Zone } from '../shared/indicators';
import type { Point } from '../shared/timeseries';
import type { Bar } from '../shared/types';

/**
 * 月資料指標（景氣燈號）上方的對照窗格（加權指數）：
 * 日資料轉成月底收盤，日期改成 YYYY-MM-01，與燈號的資料月份對齊，十字線一次讀到兩個值。
 */

export interface Companion {
  /** 對照序列名稱，例如「加權指數」 */
  label: string;
  /** 月底收盤（日期為 YYYY-MM-01；最新一個月＝至今） */
  bars: Bar[];
  /** 最新一筆的實際交易日，例如 2026-10-19（顯示「至 10/19」） */
  lastDate: string;
}

/** 日 K → 月底收盤（日期記為當月 1 日） */
export function monthlyCloses(daily: readonly Bar[]): { bars: Bar[]; lastDate: string } {
  const byMonth = new Map<string, number>();
  for (const b of daily) byMonth.set(monthKey(b[0]), b[4]);
  const bars = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([m, c]): Bar => [`${m}-01`, c, c, c, c]);
  return { bars, lastDate: daily.at(-1)?.[0] ?? '' };
}

export interface ZoneStreak {
  /** null＝燈號尚未公布的月份（加權已有資料） */
  zone: Zone | null;
  /** 第一個月與最後一個月（YYYY-MM-01） */
  from: string;
  to: string;
  months: number;
  /** 對照序列在這段期間的漲跌 %：最後一個月底 ÷ 第一個月前一個月底 − 1；缺資料為 null */
  change: number | null;
}

/** 依燈號切成連續期間（由新到舊），附上每段期間加權的漲跌 */
export function zoneStreaks(score: readonly Point[], zones: readonly Zone[], comp: readonly Point[]): ZoneStreak[] {
  const compAt = new Map(comp.map((p) => [p[0], p[1]]));
  const out: ZoneStreak[] = [];
  for (const [d, v] of score) {
    const z = zoneAt(zones, v) ?? null;
    const cur = out.at(-1);
    if (cur && cur.zone?.label === z?.label && addMonths(cur.to, 1) === d) {
      cur.to = d;
      cur.months++;
    } else out.push({ zone: z, from: d, to: d, months: 1, change: null });
  }
  const lastScore = score.at(-1)?.[0];
  const pending = lastScore ? comp.filter((p) => p[0] > lastScore) : [];
  if (pending.length) out.push({ zone: null, from: pending[0]![0], to: pending.at(-1)![0], months: pending.length, change: null });
  for (const s of out) {
    const a = compAt.get(addMonths(s.from, -1));
    const b = compAt.get(s.to);
    s.change = a !== undefined && b !== undefined && a !== 0 ? (b / a - 1) * 100 : null;
  }
  return out.reverse();
}

/** 2025-12-01 → 25/12 */
export const shortMonth = (d: string) => `${d.slice(2, 4)}/${d.slice(5, 7)}`;
