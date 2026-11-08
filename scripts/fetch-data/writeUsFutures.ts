import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeUsFutures,
  mergeHourBars,
  USF_SYMBOLS,
  type HourBar,
  type UsfFile,
  type UsfHourlyFile,
  type UsfId,
} from '../../src/shared/usFutures';
import type { Bar, SeriesFile } from '../../src/shared/types';
import { getJson, HttpError, sleep, type HttpOptions } from './http';
import { yahooIntradayUrl, yahooSessionHeaders } from './sources/yahoo';

/** Yahoo 60 分鐘 K 只能回溯約 730 天 */
const MAX_LOOKBACK_DAYS = 725;
/** 每次重抓最近 N 天覆蓋修正（最新一根盤中 K 會隨時間改變） */
const REFRESH_DAYS = 4;

interface YahooIntraday {
  chart: {
    result: { timestamp?: number[]; indicators: { quote: { close?: (number | null)[] }[] } }[] | null;
    error: { code: string; description: string } | null;
  };
}

export function parseIntraday(json: YahooIntraday): HourBar[] {
  if (json.chart.error) throw new Error(`Yahoo 錯誤：${json.chart.error.code} ${json.chart.error.description}`);
  const r = json.chart.result?.[0];
  if (!r) throw new Error('Yahoo 回應沒有 result');
  const ts = r.timestamp ?? [];
  const close = r.indicators.quote[0]?.close ?? [];
  // Yahoo 盤中 K 最後一根的時間戳是「最後成交時間」而不是整點起點（例如 21:59:59Z），
  // 一律取整到小時起點，否則快取會留下同一小時兩根
  const m = new Map<number, number>();
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c === null || c === undefined || !Number.isFinite(c) || c <= 0) continue;
    m.set(ts[i]! - (ts[i]! % 3600), c);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

async function fetchHourly(symbol: string, since: number, http: HttpOptions, now: Date): Promise<HourBar[]> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const url = yahooIntradayUrl(symbol, since, nowSec + 3600, '60m');
  try {
    return parseIntraday(await getJson<YahooIntraday>(url, { ...http, retries: 0 }));
  } catch (e) {
    if (!(e instanceof HttpError) || (e.status !== 429 && e.status !== 401)) throw e;
    const { url: u2, headers } = await yahooSessionHeaders(url, http);
    return parseIntraday(await getJson<YahooIntraday>(u2, http, { headers }));
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 抓 CME／ICE 期貨 60 分鐘 K（Yahoo），累積到 outDir/usfut-hourly.json（快取沿用、每次只補尾段），
 * 再與加權、費半日 K 算出 outDir/usfut-tone.json（美期隔夜風向面板）。
 * 任一商品失敗沿用快取；NQ 沒有資料才丟錯。
 */
export async function writeUsFutures(outDir: string, http: HttpOptions, now = new Date(), log: (m: string) => void = () => {}): Promise<UsfFile> {
  const hourlyFile = path.join(outDir, 'usfut-hourly.json');
  const prev = await readJson<UsfHourlyFile>(hourlyFile);
  const bars: UsfHourlyFile['bars'] = prev?.schemaVersion === 1 ? { ...prev.bars } : {};
  const nowSec = Math.floor(now.getTime() / 1000);
  const errors: string[] = [];
  for (const s of USF_SYMBOLS) {
    const last = bars[s.id]?.at(-1)?.[0];
    const since = Math.max(nowSec - MAX_LOOKBACK_DAYS * 86_400, last ? last - REFRESH_DAYS * 86_400 : 0);
    try {
      const fresh = await fetchHourly(s.symbol, since, http, now);
      bars[s.id] = mergeHourBars(bars[s.id], fresh);
      log(`${s.symbol} 小時 K ${fresh.length} 根（累計 ${bars[s.id]!.length}）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${s.symbol}: ${msg}`);
      log(`${s.symbol} 失敗，沿用快取：${msg}`);
    }
    await sleep(300);
  }
  if (!bars.nq?.length) throw new Error(`NQ=F 沒有小時資料：${errors.join('；')}`);
  const hourly: UsfHourlyFile = { schemaVersion: 1, generatedAt: now.toISOString(), bars };
  await writeFile(`${hourlyFile}.tmp`, JSON.stringify(hourly));
  await rename(`${hourlyFile}.tmp`, hourlyFile);

  const series = async (id: string): Promise<Bar[]> => (await readJson<SeriesFile>(path.join(outDir, 'series', `${id}.json`)))?.data ?? [];
  const taiex = await series('taiex');
  if (!taiex.length) throw new Error('缺少加權指數資料');
  const out = analyzeUsFutures(bars, taiex, await series('sox'), now);
  const file = path.join(outDir, 'usfut-tone.json');
  await writeFile(`${file}.tmp`, JSON.stringify(out));
  await rename(`${file}.tmp`, file);
  return out;
}

export type { UsfId };

// 直接執行：tsx scripts/fetch-data/writeUsFutures.ts [public/data]
if (process.argv[1]?.endsWith('writeUsFutures.ts')) {
  writeUsFutures(path.resolve(process.argv[2] ?? 'public/data'), { fetchImpl: (u, i) => fetch(u, i) }, new Date(), console.log)
    .then((r) => {
      console.log(`${r.backtest.start}～${r.backtest.end}，${r.rows.length} 天；最新 ${JSON.stringify(r.latest)}`);
      console.table(r.backtest.buckets);
      console.table(r.backtest.corr);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
