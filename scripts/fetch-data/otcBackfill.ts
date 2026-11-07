/**
 * 上櫃漲跌家數「長期歷史」回補（櫃買中心每日收盤行情逐檔推算）。
 *
 * 每日排程只回補約半年；上櫃漲跌停家數監測的恐慌百分位與事件回測需要多年資料，
 * 因此另以此腳本由新到舊逐日抓取，結果存進 repo 的 data/otc-breadth-history.json（由 workflow commit）。
 *
 *  - 每個交易日 1 個請求（約 1 秒），兩次請求至少間隔 --interval-ms（預設 2000ms）
 *  - 資料自 2008-01-04 起（2026-11 探測：2007-01-04 回 0 筆）
 *  - 可續傳：檔案記錄 cursor（已處理到的最早日期），下次從 cursor 前一天繼續
 *  - 時間預算 --budget-min 用完就存檔結束；網路連續失敗視為被擋，存檔後以代碼 2 結束
 *
 * 用法：
 *   tsx scripts/fetch-data/otcBackfill.ts [--file data/otc-breadth-history.json] [--target 2008-01-04] [--budget-min 300]
 *   tsx scripts/fetch-data/otcBackfill.ts --probe 2008-01-04,2012-01-04,2020-03-19   # 只測試解析，不寫檔
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OtcBreadthHistoryFile, OtcBreadthHistoryRow } from '../../src/shared/breadthStress';
import { addDays, todayInTaipei } from '../../src/shared/dates';
import { getJson, sleep, type HttpOptions } from './http';
import { parseTpexBreadth, tpexQuotesUrl, type TpexQuotes } from './sources/tpexBreadth';
import { weekdaysBackward } from './sources/twseChips';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const http: HttpOptions = { fetchImpl: (u, i) => fetch(u, i), retries: 2, retryDelayMs: 5000, timeoutMs: 60_000 };

let lastAt = 0;
async function throttled<T>(intervalMs: number, fn: () => Promise<T>): Promise<T> {
  const wait = lastAt + intervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await fn();
  } finally {
    lastAt = Date.now();
  }
}

type DayResult = { kind: 'row'; row: OtcBreadthHistoryRow } | { kind: 'closed' } | { kind: 'parse_error'; message: string };

/** 抓一天；網路錯誤直接丟出（呼叫端決定重試／停止），解析錯誤回傳 parse_error */
export async function fetchDay(date: string, intervalMs: number): Promise<DayResult> {
  const j = await throttled(intervalMs, () => getJson<TpexQuotes>(tpexQuotesUrl(date), http));
  try {
    const b = parseTpexBreadth(j, date);
    if (!b) return { kind: 'closed' };
    return { kind: 'row', row: [date, b.up, b.upLimit, b.down, b.downLimit, b.flat] };
  } catch (e) {
    return { kind: 'parse_error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function load(file: string): Promise<OtcBreadthHistoryFile | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as OtcBreadthHistoryFile;
  } catch {
    return null;
  }
}

async function save(file: string, f: OtcBreadthHistoryFile): Promise<void> {
  f.rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  f.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ ...f, rows: [] }, null, 1).replace(
    '"rows": []',
    `"rows": [\n${f.rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`,
  );
  await writeFile(`${file}.tmp`, body);
  await rename(`${file}.tmp`, file);
}

async function probe(dates: string[], intervalMs: number) {
  for (const d of dates) {
    const t0 = Date.now();
    try {
      const r = await fetchDay(d, intervalMs);
      console.log(`::notice title=probe ${d}::${JSON.stringify(r)}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    } catch (e) {
      console.log(`::warning title=probe ${d}::網路錯誤 ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  const intervalMs = Number(arg('interval-ms') ?? 2000);
  const probeArg = arg('probe');
  if (probeArg) return probe(probeArg.split(','), intervalMs);

  const file = path.resolve(arg('file') ?? 'data/otc-breadth-history.json');
  const target = arg('target') ?? '2008-01-04';
  const budgetMs = Number(arg('budget-min') ?? 300) * 60_000;
  const started = Date.now();
  const f: OtcBreadthHistoryFile = (await load(file)) ?? {
    schemaVersion: 1,
    note: '上櫃漲跌家數歷史（櫃買中心每日收盤行情逐檔推算）：[日期, 上漲, 漲停, 下跌, 跌停, 持平]。由 otcBackfill.ts 產生。',
    target,
    cursor: addDays(todayInTaipei(), 1),
    updatedAt: '',
    parseErrors: [],
    rows: [],
  };
  f.target = target;
  if (f.cursor <= target) {
    console.log(`[otc-backfill] 已完成（cursor ${f.cursor} ≤ target ${target}）`);
    return;
  }
  const have = new Set(f.rows.map((r) => r[0]));
  let done = 0;
  let consecutiveFail = 0;
  let blocked = false;
  let d = addDays(f.cursor, -1);
  while (d >= target) {
    if (Date.now() - started > budgetMs) break;
    const [day] = weekdaysBackward(d, target, 1);
    if (!day) {
      f.cursor = target;
      break;
    }
    try {
      if (!have.has(day)) {
        const r = await fetchDay(day, intervalMs);
        if (r.kind === 'row') {
          f.rows.push(r.row);
          have.add(day);
        } else if (r.kind === 'parse_error') {
          f.parseErrors.push(`${day} ${r.message}`);
          console.warn(`  ${day} 解析失敗：${r.message}`);
        }
      }
      consecutiveFail = 0;
      f.cursor = day;
      d = addDays(day, -1);
      done++;
      if (done % 40 === 0) {
        await save(file, f);
        const mins = ((Date.now() - started) / 60_000).toFixed(1);
        console.log(`[otc-backfill] 進度 cursor=${f.cursor} 共 ${f.rows.length} 筆（本次 ${done} 天，${mins} 分）`);
      }
    } catch (e) {
      consecutiveFail++;
      console.warn(`  ${day} 網路錯誤（第 ${consecutiveFail} 次）：${e instanceof Error ? e.message : String(e)}`);
      if (consecutiveFail >= 4) {
        blocked = true;
        break;
      }
      await sleep(consecutiveFail * 90_000);
    }
  }
  await save(file, f);
  const left = f.cursor > target;
  console.log(
    `::notice title=otc-backfill::結束：cursor=${f.cursor} rows=${f.rows.length} 解析失敗 ${f.parseErrors.length} 天，${left ? '尚未完成' : '已完成'}${blocked ? '（連續網路錯誤，疑似被擋）' : ''}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `remaining=${left && !blocked ? 'true' : 'false'}\n`, { flag: 'a' });
  }
  if (blocked) process.exit(2);
}

if (process.argv[1]?.endsWith('otcBackfill.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
