import { addDays } from '../../../src/shared/dates';
import type { Bar } from '../../../src/shared/types';
import { getJson, sleep, type HttpOptions } from '../http';
import { weekdaysBackward } from './twseChips';
import type { SourceFetchResult } from './types';

/**
 * 韓國 KOSPI 外國人淨買賣（億韓元）：Naver Pay 證券行動版 API，一次查一天。
 *
 * 2026-10-18 探測（GitHub Actions，workflow「韓國外資資料來源探測」）：
 *  - KRX 資料平台（data.krx.co.kr）2024-12 起需 Kakao／Naver 登入，匿名查詢回 `LOGOUT` → 不採用
 *  - Naver 舊版投資人別頁面（investorDealTrendDay）回 HTTP 410
 *  - 本端點可回溯到 2008 年；與 Daum（2016 起）歷史數值幾乎一致，最近 2–3 天偶有修正
 *  - 非交易日回傳三個數值皆 0
 */
export const KR_HISTORY_START = '2010-01-04';
/** 每次重抓最近 N 個日曆天：涵蓋修正值 */
const REFRESH_DAYS = 14;
/** 每次執行回補舊資料的時間上限（秒）；首次約需 4 次執行補滿 2010 年起 */
const BACKFILL_SECONDS = Number(process.env.KR_BACKFILL_SECONDS ?? 300);
const GAP_MS = 120;

export const naverTrendUrl = (date: string) => `https://m.stock.naver.com/api/index/KOSPI/trend?bizdate=${date.replace(/-/g, '')}`;

interface NaverTrend {
  bizdate?: string;
  personalValue?: string;
  foreignValue?: string;
  institutionalValue?: string;
}

/** 外國人淨買賣（億韓元）；休市日回傳 null */
export function parseNaverTrend(j: NaverTrend | null, date: string): number | null {
  if (!j || j.bizdate !== date.replace(/-/g, '')) throw new Error(`Naver 回傳日期不符：${j?.bizdate} ≠ ${date}`);
  const num = (s: string | undefined) => (s === undefined ? NaN : Number(s.replace(/[,+\s]/g, '')));
  const f = num(j.foreignValue);
  const p = num(j.personalValue);
  const i = num(j.institutionalValue);
  if (![f, p, i].every(Number.isFinite)) throw new Error(`Naver 數值無法解析：${JSON.stringify(j).slice(0, 120)}`);
  if (f === 0 && p === 0 && i === 0) return null;
  return f;
}

export interface NaverKrOptions {
  /** 回補時間上限（秒） */
  budgetSec?: number;
  /** 測試用時鐘 */
  clock?: () => number;
}

/**
 * 最新段：上次最後一天往前 14 天 → 今天（由舊到新，覆蓋修正值）。
 * 回補段：快取最早一天的前一天 → 2010-01-04（由新到舊），時間用完或遇錯即停，下次從斷點續補，不留缺洞。
 * 無快取時從今天往回補。
 */
export async function fetchNaverKrForeign(
  cached: Bar[] | null,
  today: string,
  http: HttpOptions,
  fast = false,
  opts: NaverKrOptions = {},
): Promise<SourceFetchResult> {
  const clock = opts.clock ?? Date.now;
  const budgetMs = (opts.budgetSec ?? BACKFILL_SECONDS) * 1000;
  const t0 = clock();
  const first = cached?.[0]?.[0] ?? null;
  const last = cached?.at(-1)?.[0] ?? null;
  const recent = last ? weekdaysBackward(today, addDays(last, -REFRESH_DAYS), 60).reverse() : [];
  const olderFrom = first ? addDays(first, -1) : today;
  const older = olderFrom >= KR_HISTORY_START ? weekdaysBackward(olderFrom, KR_HISTORY_START, 10_000) : [];

  const bars: Bar[] = [];
  let lastError: unknown = null;
  let backfilled = 0;
  for (const [name, segment] of [['最新', recent], ['回補', older]] as const) {
    for (const d of segment) {
      if (name === '回補' && clock() - t0 > budgetMs) break;
      try {
        const v = parseNaverTrend(await getJson<NaverTrend>(naverTrendUrl(d), http), d);
        if (v !== null) {
          bars.push([d, v, v, v, v]);
          if (name === '回補') backfilled++;
        }
      } catch (e) {
        lastError = e;
        console.warn(`  [naver_kr] ${d} 失敗，${name}段停止：${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (!fast) await sleep(GAP_MS);
    }
  }
  if (bars.length === 0) {
    if (lastError) throw lastError;
    throw new Error('Naver 沒有回傳任何交易日資料（可能休市或尚未公布）');
  }
  bars.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  console.log(`  [naver_kr] 最新 ${recent.length} 天、回補 ${backfilled} 個交易日（至 ${backfilled ? bars[0]![0] : '—'}），用時 ${((clock() - t0) / 1000).toFixed(0)}s`);
  return { bars, closeOnly: true, partial: false, incremental: true };
}
