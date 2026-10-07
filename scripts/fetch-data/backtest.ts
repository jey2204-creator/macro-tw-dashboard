import { addDays } from '../../src/shared/dates';
import type { IndicatorDef } from '../../src/shared/indicators';
import { scoreToSignal, SIGNAL_SCORE } from '../../src/shared/regime';
import { evaluateSignal, isStale } from '../../src/shared/signals';
import { closes, transformPoints, type Point } from '../../src/shared/timeseries';
import type { Bar, BacktestBucket, BacktestFile, BacktestStats, Signal } from '../../src/shared/types';

/**
 * 規則回測：以「目前的規則與權重」逐日（加權指數交易日）重算歷史訊號，
 * 統計各訊號狀態之後 20／60 個交易日的加權指數報酬。
 *
 * 防止前視偏誤：資料在「資料日期 + 公布延遲」之後才可使用。
 *   日資料 +1 天、月資料 +45 天（資料日期為月初）、季資料 +120 天（季初；GDPNow 取保守值）
 * 已知限制：
 *   - FRED 提供修正後數值而非當時初值，結果略為樂觀
 *   - 60 日報酬的觀察期彼此重疊，實際獨立樣本遠少於天數
 */

export const PUBLICATION_LAG: Record<IndicatorDef['frequency'], number> = {
  daily: 1,
  weekly: 7,
  monthly: 45,
  quarterly: 120,
};

export interface BacktestOptions {
  start?: string;
  splitDate?: string;
  /** 每個指標回看的最大筆數（需 ≥ 260 以計算 MA240 與斜率） */
  window?: number;
  now?: Date;
}

interface Prepared {
  def: IndicatorDef;
  pts: Point[];
  avail: string[];
}

function uptoIndex(avail: string[], date: string): number {
  let lo = 0;
  let hi = avail.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (avail[m]! <= date) {
      idx = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return idx;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

class Acc {
  days = 0;
  f20: number[] = [];
  f60: number[] = [];
  add(r20: number | null, r60: number | null) {
    this.days++;
    if (r20 !== null) this.f20.push(r20);
    if (r60 !== null) this.f60.push(r60);
  }
  bucket(total: number): BacktestBucket {
    const avg = (a: number[]) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return {
      pct: total ? round((this.days / total) * 100, 1) : 0,
      days: this.days,
      avg20: avg(this.f20),
      avg60: avg(this.f60),
      win60: this.f60.length ? round((this.f60.filter((x) => x > 0).length / this.f60.length) * 100, 1) : null,
    };
  }
}

const newAccs = () => ({ bull: new Acc(), neutral: new Acc(), bear: new Acc() });
const toStats = (a: Record<Signal, Acc>): BacktestStats => {
  const total = a.bull.days + a.neutral.days + a.bear.days;
  return { bull: a.bull.bucket(total), neutral: a.neutral.bucket(total), bear: a.bear.bucket(total) };
};

/**
 * @param series 各指標完整歷史（含 taiex，作為報酬基準）
 */
export function runBacktest(
  series: Record<string, Bar[]>,
  defs: IndicatorDef[],
  opts: BacktestOptions = {},
): BacktestFile {
  const start = opts.start ?? '2010-01-01';
  const splitDate = opts.splitDate ?? '2018-01-01';
  const window = opts.window ?? 400;
  const taiex = series.taiex ?? [];
  if (taiex.length < 100) throw new Error('加權指數資料不足，無法回測');
  const tDates = taiex.map((b) => b[0]);
  const tClose = taiex.map((b) => b[4]);

  const prepared: Prepared[] = defs
    .filter((d) => !d.hidden && series[d.id]?.length)
    .map((def) => {
      const pts = transformPoints(def, closes(series[def.id]!));
      return { def, pts, avail: pts.map((p) => addDays(p[0], PUBLICATION_LAG[def.frequency])) };
    });

  const perInd: Record<string, Record<Signal, Acc>> = {};
  const comp = { full: newAccs(), early: newAccs(), late: newAccs() };
  const compAll = { full: new Acc(), early: new Acc(), late: new Acc() };
  let first: string | null = null;
  let last: string | null = null;

  for (let i = 0; i < tDates.length; i++) {
    const d = tDates[i]!;
    if (d < start) continue;
    const r20 = i + 20 < tClose.length ? (tClose[i + 20]! / tClose[i]! - 1) * 100 : null;
    const r60 = i + 60 < tClose.length ? (tClose[i + 60]! / tClose[i]! - 1) * 100 : null;
    if (r20 === null) break; // 尾段沒有未來報酬，不納入
    first ??= d;
    last = d;

    let sum = 0;
    let w = 0;
    for (const p of prepared) {
      const idx = uptoIndex(p.avail, d);
      if (idx < 0) continue;
      const pts = p.pts.slice(Math.max(0, idx + 1 - window), idx + 1);
      if (isStale(p.def, pts.at(-1)![0], d)) continue; // 與線上相同：過時不計
      const res = evaluateSignal(p.def, pts);
      if (res.reason.startsWith('資料不足')) continue;
      (perInd[p.def.id] ??= newAccs())[res.signal].add(r20, r60);
      if (p.def.weight > 0) {
        sum += SIGNAL_SCORE[res.signal] * p.def.weight;
        w += p.def.weight;
      }
    }
    if (w > 0) {
      const sig = scoreToSignal(sum / w);
      const half = d < splitDate ? 'early' : 'late';
      comp.full[sig].add(r20, r60);
      comp[half][sig].add(r20, r60);
      compAll.full.add(r20, r60);
      compAll[half].add(r20, r60);
    }
  }

  const withAll = (k: 'full' | 'early' | 'late') => ({ ...toStats(comp[k]), all: compAll[k].bucket(compAll[k].days) });
  return {
    schemaVersion: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    start: first ?? start,
    end: last ?? start,
    splitDate,
    indicators: Object.fromEntries(Object.entries(perInd).map(([id, a]) => [id, toStats(a)])),
    composite: { full: withAll('full'), early: withAll('early'), late: withAll('late') },
  };
}
