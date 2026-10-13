import { addDays, parseDate } from '../../../src/shared/dates';
import type { Bar } from '../../../src/shared/types';
import { getJson, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 臺灣證券交易所（上市）每日籌碼資料，官方、免金鑰，但「一次只能查一天」：
 *  - 三大法人買賣金額統計 BFI82U：外資、投信、自營商買賣超（元）
 *  - 信用交易統計 MI_MARGN（selectType=MS）：融資金額前日／今日餘額（仟元）
 *
 * 為避免單次執行過久，採「漸進回補」：每次執行除了補最新幾天，
 * 另往前回補最多 BACKFILL_PER_RUN 個工作日，直到 BACKFILL_DAYS 天前。
 * 同一天的 BFI82U 回應由外資／投信／自營商三個指標共用（每次執行內快取）。
 */

export type TwseChipSymbol = 'FOREIGN' | 'TRUST' | 'DEALER' | 'MARGIN';

export const TWSE_CHIPS_BACKFILL_DAYS = 365;
export const BACKFILL_PER_RUN = 60;
const DELAY_MS = 700; // 證交所對頻繁請求會暫時封鎖 IP

const num = (s: string | undefined) => Number(String(s ?? '').replace(/,/g, ''));
const yi = (v: number) => Math.round((v / 1e8) * 100) / 100; // 元 → 億元，取 2 位

interface Bfi82u {
  stat?: string;
  fields?: string[];
  data?: string[][];
}
interface MiMargn {
  stat?: string;
  tables?: { fields?: string[]; data?: string[][] }[];
}

/** 回傳（億元）：外資＝外資及陸資＋外資自營商；自營商＝自行買賣＋避險。查無資料回傳 null */
export function parseBfi82u(json: Bfi82u): Record<'FOREIGN' | 'TRUST' | 'DEALER', number> | null {
  if (json.stat !== 'OK') return null;
  const f = json.fields ?? [];
  const iName = f.indexOf('單位名稱');
  const iNet = f.indexOf('買賣差額');
  if (iName < 0 || iNet < 0) throw new Error(`BFI82U 欄位異常：${f.join(',')}`);
  let foreign = 0;
  let trust = 0;
  let dealer = 0;
  let seen = 0;
  for (const row of json.data ?? []) {
    const name = row[iName] ?? '';
    const v = num(row[iNet]);
    if (!Number.isFinite(v)) continue;
    if (name.startsWith('外資')) foreign += v;
    else if (name === '投信') trust = v;
    else if (name.startsWith('自營商')) dealer += v;
    else continue;
    seen++;
  }
  if (seen < 3) throw new Error('BFI82U 資料列不完整');
  return { FOREIGN: yi(foreign), TRUST: yi(trust), DEALER: yi(dealer) };
}

/** 融資金額（今日餘額 − 前日餘額），億元。查無資料回傳 null */
export function parseMiMargn(json: MiMargn): number | null {
  if (json.stat !== 'OK') return null;
  const t = json.tables?.find((x) => x.fields?.includes('今日餘額'));
  if (!t) throw new Error('MI_MARGN 找不到信用交易統計表');
  const f = t.fields!;
  const iPrev = f.indexOf('前日餘額');
  const iNow = f.indexOf('今日餘額');
  const row = t.data?.find((r) => (r[0] ?? '').startsWith('融資金額'));
  if (!row || iPrev < 0 || iNow < 0) throw new Error('MI_MARGN 找不到融資金額列');
  return yi((num(row[iNow]) - num(row[iPrev])) * 1000);
}

/** 工作日（週一至週五）清單，由新到舊 */
export function weekdaysBackward(from: string, to: string, limit: number): string[] {
  const out: string[] = [];
  for (let d = from; d >= to && out.length < limit; d = addDays(d, -1)) {
    const dow = new Date(parseDate(d)).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

// 單次執行內的每日回應快取（三個法人指標共用同一天的 BFI82U）
const bfiCache = new Map<string, Promise<ReturnType<typeof parseBfi82u>>>();
const marginCache = new Map<string, Promise<number | null>>();

export function resetTwseChipsCache(): void {
  bfiCache.clear();
  marginCache.clear();
}

async function dayValue(symbol: TwseChipSymbol, date: string, http: HttpOptions, fast: boolean): Promise<number | null> {
  const ymd = date.replace(/-/g, '');
  if (symbol === 'MARGIN') {
    let p = marginCache.get(date);
    if (!p) {
      p = (async () => {
        const j = await getJson<MiMargn>(
          `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=MS&response=json`,
          http,
        );
        if (!fast) await sleep(DELAY_MS);
        return parseMiMargn(j);
      })();
      marginCache.set(date, p);
    }
    return p;
  }
  let p = bfiCache.get(date);
  if (!p) {
    p = (async () => {
      const j = await getJson<Bfi82u>(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${ymd}&response=json`, http);
      if (!fast) await sleep(DELAY_MS);
      return parseBfi82u(j);
    })();
    bfiCache.set(date, p);
  }
  const r = await p;
  return r ? r[symbol] : null;
}

export async function fetchTwseChips(
  symbol: TwseChipSymbol,
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
): Promise<SourceFetchResult> {
  const target = addDays(today, -TWSE_CHIPS_BACKFILL_DAYS);
  const first = cached?.[0]?.[0] ?? null;
  const last = cached?.at(-1)?.[0] ?? null;
  // 最新：自上次最後一天（含）起；無快取則從今天往回
  const recent = weekdaysBackward(today, last ?? addDays(today, -1), last ? 30 : BACKFILL_PER_RUN);
  // 回補：從快取最早一天往前
  const older = first && first > target ? weekdaysBackward(addDays(first, -1), target, BACKFILL_PER_RUN) : [];
  const dates = [...recent, ...older];

  const bars: Bar[] = [];
  let failures = 0;
  for (const d of dates) {
    try {
      const v = await dayValue(symbol, d, http, fast);
      if (v !== null && Number.isFinite(v)) bars.push([d, v, v, v, v]);
    } catch (e) {
      failures++;
      if (failures > 5) {
        if (bars.length === 0) throw e;
        break; // 已取得部分資料就先保存，下次再補
      }
    }
  }
  if (bars.length === 0) throw new Error('證交所沒有回傳任何資料（可能休市或尚未公布）');
  bars.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { bars, closeOnly: true, partial: false, incremental: true };
}
