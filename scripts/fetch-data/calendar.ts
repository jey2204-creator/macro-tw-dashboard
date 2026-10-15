import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeEvents, parseFfCalendar, type CalendarEvent, type CalendarFile, type ManualEntry } from '../../src/shared/calendar';
import { todayInTaipei } from '../../src/shared/dates';
import { getJson, type FetchLike } from './http';

/**
 * 更新 public/data/calendar.json：ForexFactory 本週＋下週行事曆 → 合併歷史 → 套用手動輸入。
 * 任何失敗都不影響其他資料；失敗時保留既有歷史並記錄錯誤。
 * ForexFactory 要求不要頻繁抓取；本專案每天只執行 3 次，每次 2 個請求。
 */

export const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

export const MANUAL_FILE = 'config/consensus-manual.json';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function parseManual(json: unknown): ManualEntry[] {
  const list = Array.isArray(json) ? json : (json as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ManualEntry =>
      !!e && typeof e.key === 'string' && typeof e.releaseDate === 'string' && typeof e.forecast === 'number',
  );
}

export async function updateCalendar(opts: {
  outDir: string;
  fetchImpl: FetchLike;
  now?: Date;
  manualFile?: string;
  fast?: boolean;
  log?: (m: string) => void;
}): Promise<CalendarFile> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const file = path.join(opts.outDir, 'calendar.json');
  const existing = (await readJson<CalendarFile>(file))?.events ?? [];
  const manual = parseManual(await readJson(opts.manualFile ?? path.resolve(MANUAL_FILE)));
  const http = { fetchImpl: opts.fetchImpl, retries: opts.fast ? 0 : 1, retryDelayMs: opts.fast ? 0 : 3000 };

  const incoming: CalendarEvent[] = [];
  const errors: string[] = [];
  for (const [i, url] of FF_URLS.entries()) {
    try {
      incoming.push(...parseFfCalendar(await getJson(url, http)));
    } catch (e) {
      // 下週行事曆在週末前可能尚未產生，失敗不算錯誤
      if (i === 0) errors.push(`forexfactory → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const cal: CalendarFile = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    feed: { status: errors.length ? 'error' : 'ok', fetchedAt: now.toISOString(), errors },
    events: mergeEvents(existing, incoming, manual, todayInTaipei(now)),
  };
  await writeFile(`${file}.tmp`, JSON.stringify(cal));
  await rename(`${file}.tmp`, file);
  log(
    `${cal.feed.status.padEnd(8)} calendar   forexfactory 本次 ${incoming.length} 筆、手動 ${manual.length} 筆、累計 ${cal.events.length} 筆${errors.length ? ` errors=${errors.join(' | ')}` : ''}`,
  );
  return cal;
}
