import type { Bar } from '../../../src/shared/types';
import { getText, type HttpOptions } from '../http';
import type { SourceFetchResult } from './types';

/**
 * FRED（St. Louis Fed）公開 CSV 下載端點，免 API 金鑰。
 * 格式：observation_date,SERIES\n2026-10-01,5.24\n ...；缺值為 "." 或空白。
 */

/** start（cosd）：fredgraph 對 ICE BofA 等序列預設只回 3 年，指定起始日才取得全史 */
export function fredUrl(seriesId: string, start?: string): string {
  const base = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  return start ? `${base}&cosd=${start}` : base;
}

export function parseFredCsv(text: string, seriesId: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0] ?? '';
  if (!/^(observation_date|DATE),/i.test(header) || !header.toUpperCase().includes(seriesId.toUpperCase())) {
    throw new Error(`FRED CSV 標頭異常：${header.slice(0, 80)}`);
  }
  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i]!.split(',');
    if (!date || raw === undefined) continue;
    const v = raw.trim();
    if (v === '' || v === '.') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    bars.push([date, n, n, n, n]);
  }
  return bars;
}

export async function fetchFred(seriesId: string, http: HttpOptions, start?: string): Promise<SourceFetchResult> {
  const text = await getText(fredUrl(seriesId, start), http);
  return { bars: parseFredCsv(text, seriesId), closeOnly: true, partial: false, incremental: false };
}
