import { addDays } from '../../../src/shared/dates';
import type { Bar } from '../../../src/shared/types';
import { getJson, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';
import { limitPctOn, tickSize, weekdaysBackward, type Breadth } from './twseChips';

/**
 * 櫃買中心（上櫃）每日漲跌家數：由「上櫃股票每日收盤行情（不含定價）」逐檔推算。
 *
 *  - 端點：https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=YYYY/MM/DD&type=EW&response=json
 *    2008-01-04 起有資料（2026-11 探測：2007-01-04 回 0 筆）；舊站 stk_wn1430_result.php 對舊日期會回傳最新一天，不可用。
 *  - 櫃買沒有官方「漲跌家數」統計列，全部由逐檔「收盤」與「漲跌」推算（只算 4 位數普通股代號，排除 ETF／權證／TDR）。
 *  - 漲跌停：前日收盤＝收盤 − 漲跌；漲停價＝前日×(1+限制) 向下取到升降單位、跌停價向上取，收盤碰到即算。
 *    2015-06-01 起漲跌幅由 7% 放寬為 10%（與上市同步）。
 *  - 「漲跌」欄舊資料寫成「- 1.50」帶空格、平盤可能寫成「+0.00」→ 以數值為準（0 一律算平盤）。
 *
 * 每次執行補最新 30 天，另往前回補最多 BACKFILL_PER_RUN 個工作日到 BACKFILL_DAYS 天前；
 * 多年歷史由 otcBackfill.ts 另外回補到 data/otc-breadth-history.json。
 */

export type TpexBreadthSymbol = 'LIMIT_UP' | 'LIMIT_DOWN' | 'ADVANCE' | 'DECLINE';

export const TPEX_BREADTH_BACKFILL_DAYS = 183;
export const BACKFILL_PER_RUN = 40;
/** 櫃買中心回應快（約 1 秒），但仍與其他櫃買請求共用節流：兩次請求至少間隔 2 秒 */
const MIN_INTERVAL_MS = 2000;
let lastRequestAt = 0;
async function throttle(fast: boolean): Promise<void> {
  if (fast) return;
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

const num = (s: string | undefined) => Number(String(s ?? '').replace(/[,\s]/g, ''));

export interface TpexQuotes {
  stat?: string;
  date?: string;
  tables?: { title?: string; fields?: string[]; data?: string[][] }[];
}

export const tpexQuotesUrl = (date: string) =>
  `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(date.replace(/-/g, '/'))}&type=EW&response=json`;

/** 解析上櫃每日收盤行情 → 漲跌家數；休市或查無資料回傳 null */
export function parseTpexBreadth(json: TpexQuotes, date: string): Breadth | null {
  if (json.stat && json.stat.toLowerCase() !== 'ok') return null;
  const t = json.tables?.find((x) => x.fields?.some((f) => f.includes('代號')) && x.fields?.some((f) => f.includes('收盤')));
  if (!t?.data?.length) return null;
  const f = t.fields!.map((s) => s.trim());
  const iCode = f.findIndex((s) => s.includes('代號'));
  const iClose = f.findIndex((s) => s.startsWith('收盤'));
  const iChg = f.findIndex((s) => s === '漲跌' || s.startsWith('漲跌'));
  if (iCode < 0 || iClose < 0 || iChg < 0) throw new Error(`上櫃收盤行情欄位不符：${JSON.stringify(f)}`);
  const lp = limitPctOn(date);
  const b: Breadth = { up: 0, upLimit: 0, down: 0, downLimit: 0, flat: 0, source: 'computed' };
  for (const r of t.data) {
    if (!/^[1-9]\d{3}$/.test((r[iCode] ?? '').trim())) continue;
    const close = num(r[iClose]);
    if (!(close > 0)) continue;
    const chgText = String(r[iChg] ?? '').replace('−', '-');
    // 除權息等以「X」標示者沒有漲跌數值 → 視為平盤
    const diff = num(chgText.replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(diff) || diff === 0) {
      b.flat++;
      continue;
    }
    const sign = diff > 0 ? 1 : -1;
    const prev = close - diff;
    if (!(prev > 0)) {
      if (sign > 0) b.up++;
      else b.down++;
      continue;
    }
    const raw = prev * (1 + sign * lp);
    const tk = tickSize(raw);
    const limit = sign > 0 ? Math.floor(raw / tk + 1e-9) * tk : Math.ceil(raw / tk - 1e-9) * tk;
    if (sign > 0) {
      b.up++;
      if (close >= limit - 1e-9) b.upLimit++;
    } else {
      b.down++;
      if (close <= limit + 1e-9) b.downLimit++;
    }
  }
  return b.up + b.down + b.flat > 0 ? b : null;
}

const dayCache = new Map<string, Promise<Breadth | null>>();

/** 抓一天（同一次執行內四個指標共用同一份回應） */
export function tpexBreadthDay(date: string, http: HttpOptions, fast: boolean): Promise<Breadth | null> {
  let p = dayCache.get(date);
  if (!p) {
    p = (async () => {
      await throttle(fast);
      const j = await getJson<TpexQuotes>(tpexQuotesUrl(date), http);
      return parseTpexBreadth(j, date);
    })();
    dayCache.set(date, p);
  }
  return p;
}

export function pickBreadth(symbol: TpexBreadthSymbol, b: Breadth): number {
  return symbol === 'LIMIT_UP' ? b.upLimit : symbol === 'LIMIT_DOWN' ? b.downLimit : symbol === 'ADVANCE' ? b.up : b.down;
}

export async function fetchTpexBreadth(
  symbol: TpexBreadthSymbol,
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
): Promise<SourceFetchResult> {
  const target = addDays(today, -TPEX_BREADTH_BACKFILL_DAYS);
  if (cached && cached.length < 20) cached = null;
  const first = cached?.[0]?.[0] ?? null;
  const last = cached?.at(-1)?.[0] ?? null;
  // 最新段由舊到新、回補段由新到舊，遇到錯誤就停在該處，下次執行從斷點繼續
  const recent = (last ? weekdaysBackward(today, last, 30) : weekdaysBackward(today, target, BACKFILL_PER_RUN)).reverse();
  const older = first && first > target ? weekdaysBackward(addDays(first, -1), target, BACKFILL_PER_RUN) : [];
  const bars: Bar[] = [];
  let lastError: unknown = null;
  for (const segment of [recent, older]) {
    for (const d of segment) {
      try {
        const b = await tpexBreadthDay(d, http, fast);
        if (!b) continue;
        const v = pickBreadth(symbol, b);
        bars.push([d, v, v, v, v]);
      } catch (e) {
        lastError = e;
        console.warn(`  [tpex_breadth] ${symbol} ${d} 失敗，本段停止：${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
  }
  if (bars.length === 0) {
    if (lastError) throw lastError;
    throw new Error('櫃買中心沒有回傳任何資料（可能休市或尚未公布）');
  }
  bars.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { bars, closeOnly: true, partial: false, incremental: true };
}
