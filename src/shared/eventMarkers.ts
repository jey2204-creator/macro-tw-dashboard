import { EVENT_DEF_MAP, viewEvent, type CalendarFile, type EventView } from './calendar';
import { addDays } from './dates';
import { RELEASE_HISTORY, type HistKind } from './releaseHistory';
import { SCHEDULE, type ScheduledRelease } from './schedule';
import type { Bar, SummaryFile } from './types';

/**
 * 跨市場對照的「公布日標記」：CPI／就業報告／FOMC 在美東公布後，台股第一個交易日的加權反應。
 * 美東 08:30 或 14:00 公布時台股已收盤 → 反應日＝公布日之後第一個台股交易日（連假則順延）。
 * 回測（2015 起，tests 與部署紀錄）：事件反應日加權 |漲跌| 均值高於平常日約 25–30%，≥1.5% 大波動機率約 1.6 倍。
 */

export type EventKind = HistKind;

export const EVENT_KIND_TEXT: Record<EventKind, string> = { cpi: 'CPI', jobs: '非農', fomc: 'FOMC' };

export interface MarkedEvent {
  kind: EventKind;
  /** 美東公布日 */
  releaseDate: string;
  /** 參考月份 YYYY-MM；FOMC 為 null */
  period: string | null;
  unscheduled?: boolean;
}

/** 反應日：公布日之後第一個台股交易日；超出已知交易日則 null */
export function reactionDay(releaseDate: string, twDates: readonly string[]): string | null {
  const min = addDays(releaseDate, 1);
  let lo = 0;
  let hi = twDates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (twDates[mid]! >= min) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans === -1 ? null : twDates[ans]!;
}

/** 歷史清單 ＋ 日程表中已發生的（同日同類只算一次），依日期排序 */
export function pastEvents(today: string, schedule: readonly ScheduledRelease[] = SCHEDULE): MarkedEvent[] {
  const seen = new Set<string>();
  const out: MarkedEvent[] = [];
  const push = (e: MarkedEvent) => {
    const k = `${e.kind}@${e.releaseDate}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const r of RELEASE_HISTORY) push({ kind: r.kind, releaseDate: r.date, period: r.period, unscheduled: r.unscheduled });
  for (const r of schedule) {
    if (r.date >= today) continue;
    if (r.kind !== 'cpi' && r.kind !== 'jobs' && r.kind !== 'fomc') continue;
    push({ kind: r.kind, releaseDate: r.date, period: r.period ? r.period.slice(0, 7) : null });
  }
  return out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
}

/** 反應日 → 當天的事件（可能多個，例如 CPI 與 FOMC 隔日） */
export function eventsByReactionDay(events: readonly MarkedEvent[], twDates: readonly string[]): Map<string, MarkedEvent[]> {
  const out = new Map<string, MarkedEvent[]>();
  const first = twDates[0];
  for (const e of events) {
    // 早於已知台股資料的事件不標（否則全部擠到第一根）
    if (first === undefined || e.releaseDate < first) continue;
    const d = reactionDay(e.releaseDate, twDates);
    if (!d) continue;
    out.set(d, [...(out.get(d) ?? []), e]);
  }
  return out;
}

export interface EventStat {
  n: number;
  /** 反應日收盤 |漲跌%| 均值 */
  meanAbs: number;
  /** |漲跌| ≥ 1.5% 的比例（%） */
  bigPct: number;
}

/** 事件反應日 vs 平常日的加權波動（since 之後） */
export function eventStats(
  bars: readonly Bar[],
  byDay: ReadonlyMap<string, MarkedEvent[]>,
  since: string,
): { normal: EventStat; kinds: Record<EventKind, EventStat> } {
  const acc = (): number[] => [];
  const buckets: Record<'normal' | EventKind, number[]> = { normal: acc(), cpi: acc(), jobs: acc(), fomc: acc() };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (b[0] < since) continue;
    const r = Math.abs(((b[4] - bars[i - 1]![4]) / bars[i - 1]![4]) * 100);
    const evs = byDay.get(b[0]);
    if (!evs) buckets.normal.push(r);
    else for (const k of new Set(evs.map((e) => e.kind))) buckets[k].push(r);
  }
  const stat = (a: number[]): EventStat => ({
    n: a.length,
    meanAbs: a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN,
    bigPct: a.length ? (100 * a.filter((x) => x >= 1.5).length) / a.length : NaN,
  });
  return { normal: stat(buckets.normal), kinds: { cpi: stat(buckets.cpi), jobs: stat(buckets.jobs), fomc: stat(buckets.fomc) } };
}

/** 某次公布的市場預期 vs 實績（只有行事曆有資料的才有，2026-10 起） */
export function surprisesFor(e: MarkedEvent, cal: CalendarFile | null, summary: SummaryFile | null, now: Date): EventView[] {
  if (!cal || !summary) return [];
  return cal.events
    .filter((ev) => ev.releaseDate === e.releaseDate && EVENT_DEF_MAP[ev.key] && kindOfKey(ev.key) === e.kind)
    .map((ev) => viewEvent(EVENT_DEF_MAP[ev.key], ev, summary, now));
}

function kindOfKey(key: string): EventKind | null {
  if (key.startsWith('cpi') || key.startsWith('core_yoy') || key.startsWith('core_mom')) return 'cpi';
  if (key === 'nfp' || key === 'unrate') return 'jobs';
  return null;
}

/** 事件簡述：「CPI（9 月）」「FOMC」「FOMC（臨時）」 */
export function eventLabel(e: MarkedEvent): string {
  const name = EVENT_KIND_TEXT[e.kind];
  if (e.kind === 'fomc') return e.unscheduled ? `${name}（臨時）` : name;
  return e.period ? `${name}（${Number(e.period.slice(5, 7))} 月）` : name;
}
