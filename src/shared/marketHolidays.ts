import file from '../../config/market-holidays.json';
import { addDays, daysBetween, parseDate, toLocalDate, todayInTaipei } from './dates';
import type { IndicatorDef } from './indicators';
import { nyOffsetHours } from './schedule';

/**
 * 美股、台股休市日（config/market-holidays.json，人工維護，來源＝NYSE 與證交所公告）。
 * 參考、不計分。用途：
 *  ①頁首事件列與行事曆訂閱：事前知道哪天沒有行情（連假前後部位、隔夜沒有美股可參考）
 *  ②指標表「休市」標籤：今天沒有新 K 棒是因為休市，不是資料壞了
 *  ③台股每日指標（含有計分的加權、櫃買）在連假期間不判「過時」；美股維持原規則（休市最多連 1 個平日，不會誤判）
 * 只列平日；颱風等臨時休市不在清單內。
 */

export type Market = 'us' | 'tw';

export interface HolidayDay {
  date: string;
  name: string;
  /** 台股：市場無交易、僅辦理結算交割（春節封關後兩天） */
  settle?: boolean;
}

export interface HolidayList {
  source: string;
  checked: string;
  /** 清單涵蓋到哪一天（之後的日期未知，不是「沒有休市」） */
  through: string;
  closed: HolidayDay[];
  /** 美股提早收盤（美東 13:00） */
  early?: HolidayDay[];
}

export type HolidayFile = Record<Market, HolidayList>;

export const HOLIDAYS = file as unknown as HolidayFile;

export const MARKET_TEXT: Record<Market, { flag: string; name: string }> = {
  us: { flag: '🇺🇸', name: '美股' },
  tw: { flag: '🇹🇼', name: '台股' },
};

const isWeekend = (d: string) => {
  const dow = new Date(parseDate(d)).getUTCDay();
  return dow === 0 || dow === 6;
};

const closedMaps = new WeakMap<HolidayFile, Record<Market, Map<string, HolidayDay>>>();
function closedMap(market: Market, data: HolidayFile): Map<string, HolidayDay> {
  let m = closedMaps.get(data);
  if (!m) {
    m = { us: new Map(data.us.closed.map((h) => [h.date, h])), tw: new Map(data.tw.closed.map((h) => [h.date, h])) };
    closedMaps.set(data, m);
  }
  return m[market];
}

/** 當地日期 d 是否為公告的休市日（週末不算，回傳 undefined） */
export function holidayOn(market: Market, d: string, data: HolidayFile = HOLIDAYS): HolidayDay | undefined {
  return closedMap(market, data).get(d);
}

/** 當地日期 d 有沒有交易（平日且非公告休市日）；超出清單涵蓋範圍時只看平日 */
export function isTradingDay(market: Market, d: string, data: HolidayFile = HOLIDAYS): boolean {
  return !isWeekend(d) && !holidayOn(market, d, data);
}

function stepTradingDay(market: Market, d: string, step: 1 | -1, data: HolidayFile): string {
  let x = addDays(d, step);
  for (let i = 0; i < 30 && !isTradingDay(market, x, data); i++) x = addDays(x, step);
  return x;
}
/** d 之前／之後最近的交易日 */
export const prevTradingDay = (market: Market, d: string, data: HolidayFile = HOLIDAYS) => stepTradingDay(market, d, -1, data);
export const nextTradingDay = (market: Market, d: string, data: HolidayFile = HOLIDAYS) => stepTradingDay(market, d, 1, data);

export interface HolidaySpan {
  market: Market;
  kind: 'closed' | 'early';
  /** 第一個／最後一個休市平日（當地日期） */
  start: string;
  end: string;
  name: string;
  /** 休市的平日天數 */
  days: number;
  /** 其中「僅辦理結算交割」的日期 */
  settle: string[];
}

/** 連續休市合併成一段（中間只隔週末也算連續：春節 2/2～2/10 是一段） */
export function holidaySpans(market: Market, data: HolidayFile = HOLIDAYS): HolidaySpan[] {
  const out: HolidaySpan[] = [];
  const days = [...data[market].closed].sort((a, b) => a.date.localeCompare(b.date));
  const names = new Map<HolidaySpan, Set<string>>();
  for (const h of days) {
    const last = out.at(-1);
    if (last && nextTradingDay(market, last.end, data) > h.date) {
      last.end = h.date;
      last.days += 1;
      if (h.settle) last.settle.push(h.date);
      else names.get(last)!.add(h.name);
    } else {
      const span: HolidaySpan = { market, kind: 'closed', start: h.date, end: h.date, name: h.name, days: 1, settle: h.settle ? [h.date] : [] };
      names.set(span, new Set(h.settle ? [] : [h.name]));
      out.push(span);
    }
  }
  // 段名＝段內不重複的節日名（「結算交割」不算；春節那段叫「農曆春節」）
  for (const s of out) {
    const n = [...names.get(s)!];
    if (n.length > 0) s.name = n.join('＋');
  }
  for (const h of data[market].early ?? []) out.push({ market, kind: 'early', start: h.date, end: h.date, name: h.name, days: 1, settle: [] });
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

const SPANS: HolidaySpan[] = [...holidaySpans('us'), ...holidaySpans('tw')].sort((a, b) => a.start.localeCompare(b.start) || a.market.localeCompare(b.market));

export const holidayId = (s: HolidaySpan) => `${s.market}-${s.kind}-${s.start}`;

/** 還沒結束、且 days 天內開始的休市／提早收盤（以台北日期對當地日期，比照重大事件） */
export function upcomingHolidays(now: Date, days: number, spans: readonly HolidaySpan[] = SPANS): HolidaySpan[] {
  const today = todayInTaipei(now);
  const until = addDays(today, days);
  return spans.filter((s) => s.end >= today && s.start <= until);
}

/** 事件列排序用：當地開始日的台北 00:00（排在當天最前面） */
export const holidayStartAt = (s: HolidaySpan): string => new Date(`${s.start}T00:00:00+08:00`).toISOString();

export function holidayCountdown(s: HolidaySpan, now: Date): string {
  const d = daysBetween(todayInTaipei(now), s.start);
  if (d < 0) return '進行中';
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  return `${d}天後`;
}

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const mdDow = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}（${DOW[new Date(parseDate(d)).getUTCDay()]}）`;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export const holidayWhenText = (s: HolidaySpan): string => (s.end !== s.start ? `${mdDow(s.start)}～${mdDow(s.end)}` : mdDow(s.start));

/** 「🇺🇸 美股休市｜感恩節」「🇺🇸 美股提早收盤｜聖誕夜」 */
export function holidayTitle(s: HolidaySpan): { head: string; name: string } {
  const m = MARKET_TEXT[s.market];
  return { head: `${m.flag} ${m.name}${s.kind === 'early' ? '提早收盤' : '休市'}`, name: s.name };
}

/** 美東 13:00 換成台北時間（冬令隔天 02:00、夏令隔天 01:00） */
export function earlyCloseTaipei(date: string): string {
  const h = (13 - nyOffsetHours(date) + 8) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

/** 事件列第二行／行事曆描述的一句說明 */
export function holidayHint(s: HolidaySpan, data: HolidayFile = HOLIDAYS): string {
  if (s.kind === 'early') return `美東 13:00 收盤（台北隔天 ${earlyCloseTaipei(s.start)}），量縮`;
  if (s.market === 'us') return s.days > 1 ? `美東日期，連休 ${s.days} 個交易日` : '美東日期；當晚沒有美股，隔天台股少一個參考';
  if (s.days >= 3 || s.settle.length > 0) {
    const parts = [`封關 ${md(prevTradingDay('tw', s.start, data))}、開紅盤 ${md(nextTradingDay('tw', s.end, data))}`];
    if (s.settle.length > 0) parts.push(`${s.settle.map(md).join('、')} 僅結算交割`);
    return parts.join('；');
  }
  return `${md(nextTradingDay('tw', s.end, data))} 恢復交易；籌碼資料當天不更新`;
}

/** 清單快到期（距 through 少於 warnDays 天）→ 事件列提醒補下一年 */
export function holidaysEndSoon(now: Date, warnDays = 45, data: HolidayFile = HOLIDAYS): { market: Market; through: string }[] {
  const today = todayInTaipei(now);
  return (['us', 'tw'] as const).filter((m) => daysBetween(today, data[m].through) < warnDays).map((market) => ({ market, through: data[market].through }));
}

/** 清單檢查（測試用）：格式、平日、不重複、排序、不超過 through */
export function holidayProblems(data: HolidayFile = HOLIDAYS): string[] {
  const out: string[] = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const m of ['us', 'tw'] as const) {
    const list = data[m];
    for (const [label, days] of [['closed', list.closed], ['early', list.early ?? []]] as const) {
      const seen = new Set<string>();
      let prev = '';
      for (const h of days) {
        const tag = `${m}.${label} ${h.date}`;
        if (!iso.test(h.date) || Number.isNaN(Date.parse(h.date))) {
          out.push(`${tag}：日期格式`);
          continue;
        }
        if (isWeekend(h.date)) out.push(`${tag}：週末不用列`);
        if (seen.has(h.date)) out.push(`${tag}：重複`);
        if (h.date < prev) out.push(`${tag}：未依日期排序`);
        if (h.date > list.through) out.push(`${tag}：晚於 through`);
        if (!h.name) out.push(`${tag}：缺名稱`);
        seen.add(h.date);
        prev = h.date;
      }
    }
    for (const h of list.early ?? []) if (holidayOn(m, h.date, data)) out.push(`${m}.early ${h.date}：同一天又列在 closed`);
  }
  return out;
}

// ── 指標表「休市」標籤 ─────────────────────────────────────────────

const TZ: Record<Market, string> = { us: 'America/New_York', tw: 'Asia/Taipei' };
/** 收盤時刻（當地，分鐘）：美股 16:00（提早收盤日 13:00）、台股 13:30 */
const CLOSE_MIN: Record<Market, number> = { us: 16 * 60, tw: 13 * 60 + 30 };

function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

export interface ClosureNote {
  market: Market;
  /** 休市的當地日期 */
  date: string;
  name: string;
  /** today＝當地今天休市；prev＝上一個平日休市，而且之後還沒有新的收盤 */
  when: 'today' | 'prev';
}

/**
 * 現在「沒有新收盤」是不是因為公告休市：
 *  - 當地今天是休市日 → today
 *  - 今天還沒收盤（或週末），而上一個平日是休市日 → prev（例：感恩節隔天台北白天，最新美股仍是週三）
 * 其他情況（包含平日收盤後）回傳 null。
 */
export function closureNote(market: Market, now: Date, data: HolidayFile = HOLIDAYS): ClosureNote | null {
  const today = toLocalDate(Math.floor(now.getTime() / 1000), TZ[market]);
  const h = holidayOn(market, today, data);
  if (h) return { market, date: today, name: h.name, when: 'today' };
  const early = market === 'us' && (data.us.early ?? []).some((e) => e.date === today);
  const closedYet = !isWeekend(today) && localMinutes(now, TZ[market]) >= (early ? 13 * 60 : CLOSE_MIN[market]);
  if (closedYet) return null;
  let p = addDays(today, -1);
  while (isWeekend(p)) p = addDays(p, -1);
  const ph = holidayOn(market, p, data);
  return ph ? { market, date: p, name: ph.name, when: 'prev' } : null;
}

/** 指標屬於哪個交易所的日行情（只看每日更新的台股、美股類別；其他回傳 null） */
export function marketOf(def: Pick<IndicatorDef, 'category' | 'frequency'>): Market | null {
  if (def.frequency !== 'daily') return null;
  if (def.category === 'us_equity') return 'us';
  if (def.category === 'tw_equity' || def.category === 'tw_chips') return 'tw';
  return null;
}

/** lastDate（不含）到 today（含）之間，公告休市的平日天數 */
export function closedWeekdaysBetween(market: Market, lastDate: string, today: string, data: HolidayFile = HOLIDAYS): number {
  let n = 0;
  for (const h of data[market].closed) if (h.date > lastDate && h.date <= today) n += 1;
  return n;
}
