import { addMonths, monthKey } from './dates';
import { transformPoints, type Point } from './timeseries';
import type { SummaryFile } from './types';

/**
 * 經濟數據公布行事曆：公布日、市場預期、實績。
 *
 * 資料來源：
 *  - 公布時間與市場預期：ForexFactory 公開行事曆（nfs.faireconomy.media，只提供本週／下週）
 *    → 每次執行合併進 public/data/calendar.json，累積歷史
 *  - 手動備援：repo 內 config/consensus-manual.json（自動來源抓不到時，用 GitHub 手機 App 填）
 *  - 實績：一律用網站自己的 FRED 數列計算，不採用第三方的實績欄位
 *
 * 市場預期僅供參考、不計分（沒有免費的歷史預期資料可回測）。
 */

export type EventKey = 'cpi_yoy' | 'cpi_mom' | 'core_yoy' | 'core_mom' | 'ppi_mom' | 'core_ppi_mom' | 'nfp' | 'unrate' | 'gdp';

export interface EventDef {
  key: EventKey;
  /** 顯示在哪個指標列 */
  indicatorId: string;
  /** 列上的短標籤 */
  label: string;
  unit: '%' | 'k';
  decimals: number;
  /** 實績從哪個指標的 summary 取得、如何轉換 */
  actual: { id: string; calc: 'yoy' | 'mom' | 'none' | 'diff' };
  /** 參考期間：月資料為前一個月，GDP 為前一季 */
  period: 'month' | 'quarter';
  /** ForexFactory 標題（僅比對 USD） */
  match: RegExp;
}

export const EVENT_DEFS: EventDef[] = [
  { key: 'cpi_yoy', indicatorId: 'cpi', label: '年增', unit: '%', decimals: 1, actual: { id: 'cpi', calc: 'yoy' }, period: 'month', match: /^CPI y\/y$/i },
  { key: 'cpi_mom', indicatorId: 'cpi', label: '月增', unit: '%', decimals: 1, actual: { id: 'cpi_sa', calc: 'mom' }, period: 'month', match: /^CPI m\/m$/i },
  { key: 'core_yoy', indicatorId: 'core_cpi', label: '年增', unit: '%', decimals: 1, actual: { id: 'core_cpi', calc: 'yoy' }, period: 'month', match: /^Core CPI y\/y$/i },
  { key: 'core_mom', indicatorId: 'core_cpi', label: '月增', unit: '%', decimals: 1, actual: { id: 'core_cpi_sa', calc: 'mom' }, period: 'month', match: /^Core CPI m\/m$/i },
  { key: 'ppi_mom', indicatorId: 'ppi', label: '月增', unit: '%', decimals: 1, actual: { id: 'ppi', calc: 'mom' }, period: 'month', match: /^PPI m\/m$/i },
  { key: 'core_ppi_mom', indicatorId: 'core_ppi', label: '月增', unit: '%', decimals: 1, actual: { id: 'core_ppi', calc: 'mom' }, period: 'month', match: /^Core PPI m\/m$/i },
  { key: 'nfp', indicatorId: 'nfp', label: '新增', unit: 'k', decimals: 0, actual: { id: 'nfp', calc: 'diff' }, period: 'month', match: /^Non-Farm Employment Change$/i },
  { key: 'unrate', indicatorId: 'unrate', label: '失業率', unit: '%', decimals: 1, actual: { id: 'unrate', calc: 'none' }, period: 'month', match: /^Unemployment Rate$/i },
  { key: 'gdp', indicatorId: 'gdp', label: 'GDP', unit: '%', decimals: 1, actual: { id: 'gdp', calc: 'none' }, period: 'quarter', match: /^(Advance |Prelim |Final )?GDP q\/q$/i },
];

export const EVENT_DEF_MAP = Object.fromEntries(EVENT_DEFS.map((d) => [d.key, d])) as Record<EventKey, EventDef>;

export interface CalendarEvent {
  key: EventKey;
  /** 美東公布日 YYYY-MM-DD */
  releaseDate: string;
  /** 公布時間（ISO 8601，含時區）；手動輸入可為 null */
  releaseAt: string | null;
  /** 參考期間：YYYY-MM 或 YYYY-Qn */
  period: string;
  forecast: number | null;
  previous: number | null;
  /** forecast 的來源 */
  source: 'forexfactory' | 'manual';
}

export interface CalendarFile {
  schemaVersion: 1;
  generatedAt: string;
  feed: { status: 'ok' | 'error'; fetchedAt: string; errors: string[] };
  events: CalendarEvent[];
}

/** 手動輸入檔 config/consensus-manual.json 的每一筆 */
export interface ManualEntry {
  key: EventKey;
  releaseDate: string;
  forecast: number;
  previous?: number;
}

/** "3.6%" → 3.6；"51K" → 51；"1.2M" → 1200（千人）；空白 → null */
export function parseFfValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().replace(/,/g, '').match(/^([<>]?)(-?\d+(?:\.\d+)?)\s*([%KMB]?)$/i);
  if (!m) return null;
  const n = Number(m[2]);
  const u = m[3]!.toUpperCase();
  return u === 'M' ? n * 1000 : u === 'B' ? n * 1e6 : n;
}

/** 依公布日推算參考期間 */
export function periodFor(kind: EventDef['period'], releaseDate: string): string {
  const y = Number(releaseDate.slice(0, 4));
  const m = Number(releaseDate.slice(5, 7));
  if (kind === 'month') return monthKey(addMonths(`${releaseDate.slice(0, 7)}-01`, -1));
  // 1–3 月公布的是前一年 Q4；4–6 月是 Q1……
  const q = Math.floor((m - 1) / 3);
  return q === 0 ? `${y - 1}-Q4` : `${y}-Q${q}`;
}

/** 參考期間 → FRED 觀測日期（月初／季初） */
export function periodStart(period: string): string {
  const q = period.match(/^(\d{4})-Q([1-4])$/);
  if (q) return `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  return `${period}-01`;
}

interface FfItem {
  title?: unknown;
  country?: unknown;
  date?: unknown;
  forecast?: unknown;
  previous?: unknown;
}

/** 解析 ForexFactory 行事曆 JSON，只保留我們關心的美國數據 */
export function parseFfCalendar(json: unknown): CalendarEvent[] {
  if (!Array.isArray(json)) throw new Error('行事曆格式異常：不是陣列');
  const out: CalendarEvent[] = [];
  for (const raw of json as FfItem[]) {
    if (raw?.country !== 'USD' || typeof raw.title !== 'string' || typeof raw.date !== 'string') continue;
    const def = EVENT_DEFS.find((d) => d.match.test(raw.title as string));
    if (!def) continue;
    const date = raw.date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(raw.date))) continue;
    out.push({
      key: def.key,
      releaseDate: date,
      releaseAt: raw.date,
      period: periodFor(def.period, date),
      forecast: parseFfValue(raw.forecast),
      previous: parseFfValue(raw.previous),
      source: 'forexfactory',
    });
  }
  return out;
}

const evKey = (e: Pick<CalendarEvent, 'key' | 'releaseDate'>) => `${e.key}|${e.releaseDate}`;

/**
 * 合併：既有歷史 ← 新抓到的（非 null 欄位覆蓋）← 手動輸入（forecast 一律以手動為準）。
 * 只保留最近 keepMonths 個月。
 */
export function mergeEvents(
  existing: readonly CalendarEvent[],
  incoming: readonly CalendarEvent[],
  manual: readonly ManualEntry[],
  today: string,
  keepMonths = 36,
): CalendarEvent[] {
  const map = new Map<string, CalendarEvent>();
  for (const e of existing) map.set(evKey(e), e);
  for (const e of incoming) {
    const old = map.get(evKey(e));
    map.set(
      evKey(e),
      old
        ? {
            ...old,
            releaseAt: e.releaseAt ?? old.releaseAt,
            forecast: e.forecast ?? old.forecast,
            previous: e.previous ?? old.previous,
            // 手動值優先，不被自動來源蓋掉
            source: old.source === 'manual' ? 'manual' : e.source,
          }
        : e,
    );
  }
  for (const m of manual) {
    const def = EVENT_DEF_MAP[m.key];
    if (!def || !/^\d{4}-\d{2}-\d{2}$/.test(m.releaseDate) || !Number.isFinite(m.forecast)) continue;
    const old = map.get(evKey(m));
    map.set(evKey(m), {
      key: m.key,
      releaseDate: m.releaseDate,
      releaseAt: old?.releaseAt ?? null,
      period: old?.period ?? periodFor(def.period, m.releaseDate),
      forecast: m.forecast,
      previous: m.previous ?? old?.previous ?? null,
      source: 'manual',
    });
  }
  const cutoff = addMonths(today, -keepMonths);
  return [...map.values()]
    .filter((e) => e.releaseDate >= cutoff)
    .sort((a, b) => (a.releaseDate === b.releaseDate ? a.key.localeCompare(b.key) : a.releaseDate.localeCompare(b.releaseDate)));
}

/** 月增率 %（連續月份） */
function momPoints(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [d0, v0] = pts[i - 1]!;
    const [d1, v1] = pts[i]!;
    if (v0 !== 0 && monthKey(addMonths(`${monthKey(d0)}-01`, 1)) === monthKey(d1)) out.push([d1, (v1 / v0 - 1) * 100]);
  }
  return out;
}

/** 以網站自己的 FRED 數列計算某次公布的實績；尚未更新則為 null */
export function actualFor(def: EventDef, period: string, summary: SummaryFile): number | null {
  const entry = summary.entries[def.actual.id];
  if (!entry) return null;
  const pts =
    def.actual.calc === 'mom'
      ? momPoints(entry.tail)
      : transformPoints({ transform: def.actual.calc === 'none' ? 'none' : def.actual.calc }, entry.tail);
  const target = periodStart(period);
  return pts.find((p) => p[0] === target)?.[1] ?? null;
}

export type Surprise = 'above' | 'below' | 'inline';

export interface EventView {
  def: EventDef;
  event: CalendarEvent;
  actual: number | null;
  /** 實績－預期（以顯示位數四捨五入後比較） */
  diff: number | null;
  surprise: Surprise | null;
  /** 公布時間已過 */
  released: boolean;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function viewEvent(def: EventDef, event: CalendarEvent, summary: SummaryFile, now: Date): EventView {
  const releasedAt = event.releaseAt ? Date.parse(event.releaseAt) : Date.parse(`${event.releaseDate}T08:30:00-05:00`) // 手動輸入沒有時間：以美東 8:30 計（取冬令時間，不會提早判為已公布）;
  const released = releasedAt <= now.getTime();
  const raw = released ? actualFor(def, event.period, summary) : null;
  const actual = raw === null ? null : round(raw, def.decimals);
  const diff = actual !== null && event.forecast !== null ? round(actual - event.forecast, def.decimals) : null;
  return {
    def,
    event,
    actual,
    diff,
    surprise: diff === null ? null : diff > 0 ? 'above' : diff < 0 ? 'below' : 'inline',
    released,
  };
}

export interface IndicatorReleases {
  /** 最近一次已公布（同一天的各項，例如 CPI 年增與月增） */
  latest: EventView[];
  /** 下一次預定公布 */
  next: EventView[];
}

/** 依指標整理：最近一次已公布、下一次預定公布 */
export function releasesByIndicator(cal: CalendarFile | null, summary: SummaryFile, now: Date): Record<string, IndicatorReleases> {
  const out: Record<string, IndicatorReleases> = {};
  if (!cal) return out;
  const views = cal.events.flatMap((e) => {
    const def = EVENT_DEF_MAP[e.key];
    return def ? [viewEvent(def, e, summary, now)] : [];
  });
  const ids = [...new Set(EVENT_DEFS.map((d) => d.indicatorId))];
  for (const id of ids) {
    const mine = views.filter((v) => v.def.indicatorId === id);
    const past = mine.filter((v) => v.released);
    const future = mine.filter((v) => !v.released);
    const lastDate = past.at(-1)?.event.releaseDate;
    const nextDate = future[0]?.event.releaseDate;
    const order = (a: EventView, b: EventView) => EVENT_DEFS.indexOf(a.def) - EVENT_DEFS.indexOf(b.def);
    out[id] = {
      latest: lastDate ? past.filter((v) => v.event.releaseDate === lastDate).sort(order) : [],
      next: nextDate ? future.filter((v) => v.event.releaseDate === nextDate).sort(order) : [],
    };
  }
  return out;
}
