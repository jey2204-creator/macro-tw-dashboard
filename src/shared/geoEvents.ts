import geoFile from '../../config/geo-events.json';
import { addDays, daysBetween, todayInTaipei } from './dates';

/**
 * 重大事件（config/geo-events.json，人工維護）：APEC、G20、美中領袖會談、關稅期限、美國選舉。
 * 沒有公布數字 → 算不出門檻，一律不計分；一年不到 10 筆 → 不做回測、不列反應日統計。
 * 用途：①頁首事件列與行事曆訂閱（事前提醒）②跨市場對照加權 K 棒上方的 ■ 標記（事後看台股怎麼反應）。
 */

export type GeoType = 'summit' | 'bilateral' | 'election' | 'deadline';

export const GEO_TYPE_TEXT: Record<GeoType, string> = { summit: '峰會', bilateral: '雙邊會談', election: '選舉', deadline: '期限' };

export interface GeoEvent {
  id: string;
  type: GeoType;
  name: string;
  /** K 棒標記文字（4 個字以內） */
  short: string;
  /** 當地開始日 YYYY-MM-DD */
  start: string;
  /** 當地結束日；單日事件省略 */
  end?: string;
  /** 台股第一個能反應結果的交易日（人工填；休市自動順延） */
  react: string;
  note?: string;
  source?: string;
}

/** 每個日曆年最多幾筆：超過代表清單開始洗版，要先刪再加 */
export const GEO_MAX_PER_YEAR = 10;

export const GEO_EVENTS: GeoEvent[] = [...(geoFile.events as GeoEvent[])].sort((a, b) => a.start.localeCompare(b.start));

export const geoEnd = (e: GeoEvent): string => e.end ?? e.start;

/** 清單檢查：回傳問題文字（空陣列＝沒問題）；測試用，避免手改 JSON 時寫錯 */
export function geoProblems(events: readonly GeoEvent[] = GEO_EVENTS): string[] {
  const out: string[] = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const ids = new Set<string>();
  const perYear = new Map<string, number>();
  for (const e of events) {
    if (ids.has(e.id)) out.push(`${e.id}：id 重複`);
    ids.add(e.id);
    if (!(e.type in GEO_TYPE_TEXT)) out.push(`${e.id}：type 不明`);
    for (const d of [e.start, e.react, ...(e.end ? [e.end] : [])]) if (!iso.test(d) || Number.isNaN(Date.parse(d))) out.push(`${e.id}：日期格式 ${d}`);
    if (e.end && e.end < e.start) out.push(`${e.id}：end 早於 start`);
    if (e.react < e.start) out.push(`${e.id}：react 早於 start`);
    if (daysBetween(geoEnd(e), e.react) > 5) out.push(`${e.id}：react 離結束日超過 5 天`);
    if ([...e.short].length > 4) out.push(`${e.id}：short 超過 4 個字`);
    const y = e.start.slice(0, 4);
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  for (const [y, n] of perYear) if (n > GEO_MAX_PER_YEAR) out.push(`${y} 年 ${n} 筆，超過上限 ${GEO_MAX_PER_YEAR}`);
  return out;
}

/** 事件列排序用的時間：當地開始日的台北 00:00（重大事件沒有精確時刻） */
export const geoStartAt = (e: GeoEvent): string => new Date(`${e.start}T00:00:00+08:00`).toISOString();

/** 還沒結束、且 days 天內開始的事件（進行中的也算，標「進行中」） */
export function upcomingGeo(now: Date, days: number, events: readonly GeoEvent[] = GEO_EVENTS): GeoEvent[] {
  const today = todayInTaipei(now);
  const until = addDays(today, days);
  return events.filter((e) => geoEnd(e) >= today && e.start <= until);
}

/** 倒數文字：進行中／今天／明天／N 天後（以台北日期對當地日期，差一天以內的時差不計） */
export function geoCountdown(e: GeoEvent, now: Date): string {
  const today = todayInTaipei(now);
  const d = daysBetween(today, e.start);
  if (d < 0) return '進行中';
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  return `${d}天後`;
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const mdDow = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}（${DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;

/** 顯示用：「12/14（一）～12/15（二）」或「11/03（二）」 */
export function geoWhenText(e: GeoEvent): string {
  return e.end && e.end !== e.start ? `${mdDow(e.start)}～${mdDow(e.end)}` : mdDow(e.start);
}

/** 圖例用短日期：「11/18–19」「9/23–25」「12/30–1/2」「11/3」 */
export function geoSpanText(e: GeoEvent): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  if (!e.end || e.end === e.start) return md(e.start);
  return e.end.slice(0, 7) === e.start.slice(0, 7) ? `${md(e.start)}–${Number(e.end.slice(8, 10))}` : `${md(e.start)}–${md(e.end)}`;
}

/**
 * 反應日 → 當天的事件。react 當天或之後第一個台股交易日；
 * 還沒到（react 晚於最新一根）或早於台股資料起點的不標。
 */
export function geoByReactionDay(twDates: readonly string[], events: readonly GeoEvent[] = GEO_EVENTS): Map<string, GeoEvent[]> {
  const out = new Map<string, GeoEvent[]>();
  const first = twDates[0];
  if (first === undefined) return out;
  for (const e of events) {
    if (e.react < first) continue;
    let lo = 0;
    let hi = twDates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (twDates[mid]! >= e.react) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    if (ans === -1) continue;
    const d = twDates[ans]!;
    out.set(d, [...(out.get(d) ?? []), e]);
  }
  return out;
}
