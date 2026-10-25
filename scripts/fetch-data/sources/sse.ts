import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bar } from '../../../src/shared/types';
import { getJson, USER_AGENT, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * 上海航運交易所 SCFI 綜合指數。
 *
 * 官方免費只公布最新兩期（本期＋上期）：en.sse.net.cn/currentIndex?indexName=scfi。
 * 「多期查詢」（/index/mutipleIndex）與「指定日期查詢」都要登入（2026-10 探測：回「对不起你没有登陆!」、表格空白）。
 * 所以歷史 = data/scfi-seed.json（2026-01 起已核對的週資料，見檔內 note）＋快取＋每週抓到的最新兩期。
 * 每次都回傳「種子 ∪ 快取 ∪ 最新兩期」整批（incremental=false），同一天以官方最新抓到的值為準。
 */
export const SSE_CURRENT_URL = 'https://en.sse.net.cn/currentIndex?indexName=scfi';

interface SseCurrent {
  data?: {
    currentDate?: string;
    lastDate?: string;
    lineDataList?: { properties?: { lineName_EN?: string }; currentContent?: number | null; lastContent?: number | null }[];
  };
}

export interface ScfiSeed {
  note?: string;
  points: [string, number][];
}

/** 解析 currentIndex：回傳 [[上期日, 值], [本期日, 值]] */
export function parseSseCurrent(j: SseCurrent): [string, number][] {
  const d = j.data;
  const line = d?.lineDataList?.find((x) => x.properties?.lineName_EN === 'Comprehensive Index') ?? d?.lineDataList?.[0];
  if (!d || !line) throw new Error('SCFI 回應沒有綜合指數');
  const out: [string, number][] = [];
  const ok = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (ok(d.lastDate) && Number.isFinite(line.lastContent)) out.push([d.lastDate!, line.lastContent!]);
  if (ok(d.currentDate) && Number.isFinite(line.currentContent)) out.push([d.currentDate!, line.currentContent!]);
  if (out.length === 0) throw new Error('SCFI 回應沒有有效日期／數值');
  return out;
}

export async function readScfiSeed(file = path.resolve('data/scfi-seed.json')): Promise<[string, number][]> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as ScfiSeed;
    return j.points.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p[0]) && Number.isFinite(p[1]));
  } catch {
    return [];
  }
}

/** 種子 → 快取 → 最新，後者覆蓋前者 */
export function mergeScfi(seed: readonly [string, number][], cached: readonly Bar[] | null, latest: readonly [string, number][]): Bar[] {
  const by = new Map<string, number>();
  for (const [d, v] of seed) by.set(d, v);
  for (const b of cached ?? []) by.set(b[0], b[4]);
  for (const [d, v] of latest) by.set(d, Math.round(v * 100) / 100);
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]): Bar => [d, v, v, v, v]);
}

export async function fetchSseScfi(cached: readonly Bar[] | null, http: HttpOptions, seedFile?: string): Promise<SourceFetchResult> {
  const j = await getJson<SseCurrent>(SSE_CURRENT_URL, http, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  const latest = parseSseCurrent(j);
  const seed = await readScfiSeed(seedFile);
  return { bars: mergeScfi(seed, cached, latest), closeOnly: true, partial: false, incremental: false };
}
