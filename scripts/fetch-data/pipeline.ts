import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addDays, todayInTaipei } from '../../src/shared/dates';
import { INDICATORS, sourceUrl, type IndicatorDef, type SourceSpec } from '../../src/shared/indicators';
import { isStale } from '../../src/shared/signals';
import { isValidBar, mergeBars } from '../../src/shared/timeseries';
import type { Bar, SeriesFile, SourceRef, SummaryEntry, SummaryFile } from '../../src/shared/types';
import type { FetchLike, HttpOptions } from './http';
import { fetchFred } from './sources/fred';
import { fetchTpex, fetchTwse } from './sources/twExchanges';
import type { SourceFetchResult } from './sources/types';
import { fetchYahoo } from './sources/yahoo';

/**
 * 資料管線：每個指標依序嘗試來源，任何單一來源/指標失敗都不會中斷整體。
 *
 * 快取策略（public/data/series/<id>.json 即快取）：
 *  1. 主要來源成功 → 與「同來源」快取合併（增量）或整批取代 → status=ok
 *  2. 主要來源失敗、快取仍新鮮 → 保留快取，不混用不同來源數值 → status=cached
 *  3. 主要來源失敗、快取過時或不存在 → 改用備援來源整批取代 → status=fallback
 *     （證交所資料與 Yahoo ^TWII 皆為官方加權指數，可直接合併）
 *  4. 全部失敗 → 有快取則 status=cached，否則 status=error
 */

export interface PipelineOptions {
  outDir: string;
  fetchImpl: FetchLike;
  now?: Date;
  indicators?: IndicatorDef[];
  /** 測試用：關閉重試延遲與節流 */
  fast?: boolean;
  log?: (msg: string) => void;
}

const TAIL_LEN: Record<IndicatorDef['frequency'], number> = {
  daily: 300,
  weekly: 300,
  monthly: 240,
  quarterly: 400,
};

export function toSourceRef(spec: SourceSpec): SourceRef {
  return { provider: spec.provider, symbol: spec.symbol, url: sourceUrl(spec) };
}

/** 去除浮點雜訊（Yahoo 常回傳 7773.9501953125）並縮小檔案 */
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

const sameSource = (a: SourceRef | undefined, spec: SourceSpec) =>
  !!a && a.provider === spec.provider && a.symbol === spec.symbol;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 先寫暫存檔再改名，避免寫到一半造成損毀的 JSON */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

async function fetchFromSource(
  spec: SourceSpec,
  cached: SeriesFile | null,
  http: HttpOptions,
  now: Date,
  today: string,
  fast: boolean,
): Promise<SourceFetchResult> {
  const cacheLast = cached && sameSource(cached.source, spec) && cached.data.length > 0 ? cached.lastDate : null;
  switch (spec.provider) {
    case 'yahoo':
      // 增量：回抓 14 天以覆蓋修正值與假期
      return fetchYahoo(spec.symbol, cacheLast ? addDays(cacheLast, -14) : null, http, now);
    case 'fred':
      return fetchFred(spec.symbol, http);
    case 'tpex':
      return fetchTpex(cacheLast, today, http, fast ? 0 : 300);
    case 'twse':
      return fetchTwse(today, http, fast ? 0 : 300);
  }
}

export async function updateIndicator(
  def: IndicatorDef,
  cached: SeriesFile | null,
  http: HttpOptions,
  now: Date,
  fast = false,
): Promise<SeriesFile> {
  const today = todayInTaipei(now);
  const errors: string[] = [];
  const nowIso = now.toISOString();
  const tomorrow = addDays(today, 1);

  for (let i = 0; i < def.sources.length; i++) {
    const spec = def.sources[i]!;
    const isPrimary = i === 0;
    // 主要來源失敗時：若快取新鮮，就保留快取，不混用不同來源
    if (!isPrimary && cached && cached.data.length > 0 && !isStale(def, cached.lastDate, today)) {
      const mergeable = spec.provider === 'twse' && cached.source.provider === 'yahoo';
      if (!mergeable) break;
    }
    try {
      const res = await fetchFromSource(spec, cached, http, now, today, fast);
      const fresh = res.bars
        .filter((b) => isValidBar(b) && b[0] <= tomorrow)
        .map((b): Bar => [b[0], round4(b[1]), round4(b[2]), round4(b[3]), round4(b[4])]);
      if (fresh.length === 0) throw new Error('來源回傳 0 筆有效資料');
      const canMerge =
        !!cached && (sameSource(cached.source, spec) || (spec.provider === 'twse' && cached.source.provider === 'yahoo'));
      const merged = res.incremental && canMerge;
      const data = merged ? mergeBars(cached!.data, fresh) : fresh;
      return {
        id: def.id,
        source: toSourceRef(spec),
        status: isPrimary ? 'ok' : 'fallback',
        fetchedAt: nowIso,
        lastSuccessAt: nowIso,
        lastDate: data.at(-1)?.[0] ?? null,
        closeOnly: merged ? cached!.closeOnly && res.closeOnly : res.closeOnly,
        partial: res.partial,
        errors,
        data,
      };
    } catch (e) {
      errors.push(`${spec.provider}:${spec.symbol} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (cached && cached.data.length > 0) {
    return { ...cached, status: 'cached', fetchedAt: nowIso, errors, partial: false };
  }
  return {
    id: def.id,
    source: toSourceRef(def.sources[0]!),
    status: 'error',
    fetchedAt: nowIso,
    lastSuccessAt: null,
    lastDate: null,
    closeOnly: true,
    partial: false,
    errors,
    data: [],
  };
}

export function toSummaryEntry(def: IndicatorDef, f: SeriesFile): SummaryEntry {
  return {
    id: f.id,
    source: f.source,
    status: f.status,
    fetchedAt: f.fetchedAt,
    lastSuccessAt: f.lastSuccessAt,
    lastDate: f.lastDate,
    closeOnly: f.closeOnly,
    partial: f.partial,
    errors: f.errors,
    tail: f.data.slice(-TAIL_LEN[def.frequency]).map((b) => [b[0], b[4]]),
  };
}

export async function runPipeline(opts: PipelineOptions): Promise<SummaryFile> {
  const now = opts.now ?? new Date();
  const defs = opts.indicators ?? INDICATORS;
  const log = opts.log ?? (() => {});
  const seriesDir = path.join(opts.outDir, 'series');
  await mkdir(seriesDir, { recursive: true });
  const http: HttpOptions = {
    fetchImpl: opts.fetchImpl,
    retries: opts.fast ? 0 : 2,
    retryDelayMs: opts.fast ? 0 : 1500,
  };

  const entries: Record<string, SummaryEntry> = {};
  // 依來源分組並行：不同網站同時抓，同一網站內循序以免觸發限流
  const groups = new Map<string, IndicatorDef[]>();
  for (const d of defs) {
    const k = d.sources[0]!.provider;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  await Promise.all(
    [...groups.values()].map(async (list) => {
      for (const def of list) {
        const file = path.join(seriesDir, `${def.id}.json`);
        const cached = await readJson<SeriesFile>(file);
        let result: SeriesFile;
        try {
          result = await updateIndicator(def, cached, http, now, opts.fast);
        } catch (e) {
          // 理論上 updateIndicator 不會丟錯；保險起見仍隔離
          result = {
            ...(cached ?? {
              id: def.id,
              source: toSourceRef(def.sources[0]!),
              lastSuccessAt: null,
              lastDate: null,
              closeOnly: true,
              partial: false,
              data: [],
            }),
            status: cached?.data.length ? 'cached' : 'error',
            fetchedAt: now.toISOString(),
            errors: [String(e)],
          };
        }
        await writeJsonAtomic(file, result);
        entries[def.id] = toSummaryEntry(def, result);
        log(
          `${result.status.padEnd(8)} ${def.id.padEnd(10)} ${result.source.provider}:${result.source.symbol} last=${result.lastDate} n=${result.data.length}${result.errors.length ? ` errors=${result.errors.join(' | ')}` : ''}`,
        );
      }
    }),
  );

  const summary: SummaryFile = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    // 依註冊表順序輸出，讓 diff 穩定
    entries: Object.fromEntries(defs.filter((d) => entries[d.id]).map((d) => [d.id, entries[d.id]!])),
  };
  await writeJsonAtomic(path.join(opts.outDir, 'summary.json'), summary);
  return summary;
}
