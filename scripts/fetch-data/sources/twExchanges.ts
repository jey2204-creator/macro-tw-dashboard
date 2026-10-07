import { addMonths, rocToIso } from '../../../src/shared/dates';
import { isValidBar, mergeBars } from '../../../src/shared/timeseries';
import type { Bar } from '../../../src/shared/types';
import { getJson, sleep, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 臺灣官方來源：
 *  - 櫃買中心「櫃買指數(月查詢)」 /www/zh-tw/indexInfo/inx?date=YYYY/MM/01&response=json
 *  - 證交所「發行量加權股價指數歷史資料」 /rwd/zh/TAIEX/MI_5MINS_HIST?date=YYYYMM01&response=json
 * 兩者皆為「一次查一個月」，因此首次需要回補歷史；之後只更新最近兩個月。
 */

/** 櫃買指數資料自 2000 年起較完整 */
export const TPEX_BACKFILL_START = '2000-01-01';
/** 證交所為備援來源，只補最近期資料 */
export const TWSE_FALLBACK_MONTHS = 3;

const num = (s: string) => Number(String(s).replace(/,/g, '').trim());

interface TpexMonth {
  stat?: string;
  tables?: { fields?: string[]; data?: string[][] }[];
}

export function parseTpexMonth(json: TpexMonth): Bar[] {
  if (json.stat && json.stat.toLowerCase() !== 'ok') throw new Error(`TPEx stat=${json.stat}`);
  const t = json.tables?.[0];
  if (!t) throw new Error('TPEx 回應沒有 tables');
  const f = t.fields ?? [];
  // 依欄位名稱定位，避免欄位順序改變
  const idx = (name: string) => f.indexOf(name);
  const [iD, iO, iH, iL, iC] = [idx('日期'), idx('開市'), idx('最高'), idx('最低'), idx('收市')];
  if ([iD, iO, iH, iL, iC].some((i) => i < 0)) throw new Error(`TPEx 欄位異常：${f.join(',')}`);
  const bars: Bar[] = [];
  for (const row of t.data ?? []) {
    const date = String(row[iD] ?? '').replace(/\//g, '-');
    const bar: Bar = [date, num(row[iO]!), num(row[iH]!), num(row[iL]!), num(row[iC]!)];
    if (isValidBar(bar)) bars.push(bar);
  }
  return bars;
}

interface TwseMonth {
  stat?: string;
  fields?: string[];
  data?: string[][];
}

export function parseTwseMonth(json: TwseMonth): Bar[] {
  if (json.stat !== 'OK') throw new Error(`TWSE stat=${json.stat ?? '無'}`);
  const f = json.fields ?? [];
  const idx = (name: string) => f.indexOf(name);
  const [iD, iO, iH, iL, iC] = [idx('日期'), idx('開盤指數'), idx('最高指數'), idx('最低指數'), idx('收盤指數')];
  if ([iD, iO, iH, iL, iC].some((i) => i < 0)) throw new Error(`TWSE 欄位異常：${f.join(',')}`);
  const bars: Bar[] = [];
  for (const row of json.data ?? []) {
    const date = rocToIso(String(row[iD] ?? ''));
    if (!date) continue;
    const bar: Bar = [date, num(row[iO]!), num(row[iH]!), num(row[iL]!), num(row[iC]!)];
    if (isValidBar(bar)) bars.push(bar);
  }
  return bars;
}

/** 由 start 月到 end 月（含）的每月 1 日 */
export function monthStarts(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = `${start.slice(0, 7)}-01`;
  const last = `${end.slice(0, 7)}-01`;
  while (cur <= last) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

async function fetchMonths(
  months: string[],
  fetchOne: (m: string) => Promise<Bar[]>,
  delayMs: number,
  allowEmpty: (m: string) => boolean,
): Promise<Bar[]> {
  let bars: Bar[] = [];
  let failures = 0;
  for (const m of months) {
    try {
      const got = await fetchOne(m);
      if (got.length === 0 && !allowEmpty(m)) failures++;
      bars = mergeBars(bars, got);
    } catch (e) {
      failures++;
      // 回補時容忍少量月份失敗；連續大量失敗則中止
      if (failures > Math.max(3, months.length * 0.1)) throw e;
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return bars;
}

export async function fetchTpex(
  since: string | null,
  today: string,
  http: HttpOptions,
  delayMs = 300,
): Promise<SourceFetchResult> {
  const start = since ? addMonths(since, -1) : TPEX_BACKFILL_START;
  const months = monthStarts(start, today);
  const bars = await fetchMonths(
    months,
    async (m) =>
      parseTpexMonth(
        await getJson<TpexMonth>(
          `https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${encodeURIComponent(m.replace(/-/g, '/'))}&response=json`,
          http,
        ),
      ),
    delayMs,
    (m) => m.slice(0, 7) === today.slice(0, 7), // 月初第一個交易日前可能為空
  );
  if (bars.length === 0) throw new Error('TPEx 沒有取得任何資料');
  return { bars, closeOnly: false, partial: false, incremental: since !== null };
}

export async function fetchTwse(today: string, http: HttpOptions, delayMs = 300): Promise<SourceFetchResult> {
  const months = monthStarts(addMonths(today, -(TWSE_FALLBACK_MONTHS - 1)), today);
  const bars = await fetchMonths(
    months,
    async (m) =>
      parseTwseMonth(
        await getJson<TwseMonth>(
          `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${m.replace(/-/g, '')}&response=json`,
          http,
        ),
      ),
    delayMs,
    (m) => m.slice(0, 7) === today.slice(0, 7),
  );
  if (bars.length === 0) throw new Error('TWSE 沒有取得任何資料');
  return { bars, closeOnly: false, partial: false, incremental: true };
}
