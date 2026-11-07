/**
 * 借券賣出「長期歷史」回補（上市，證交所 TWT93U 逐檔加總）。
 *
 * 每日排程只回補約半年；借券比率化與事件回測需要多年資料，因此另以此腳本
 * 由新到舊逐日抓取，結果存進 repo 的 data/sbl-history.json（由 workflow commit）。
 *
 *  - 每個交易日 1 個請求：TWT93U（逐檔借券賣出 前日餘額／當日賣出／當日還券／當日餘額，單位股）
 *  - 證交所回應慢（約 10 秒／天）且會封鎖頻繁請求：兩次請求至少間隔 --interval-ms（預設 2500ms）
 *  - 可續傳：檔案記錄 cursor（已處理到的最早日期），下次從 cursor 前一天繼續
 *  - 時間預算 --budget-min 用完就存檔結束；網路連續失敗視為被擋，存檔後以代碼 2 結束
 *
 * 用法：
 *   tsx scripts/fetch-data/sblBackfill.ts [--file data/sbl-history.json] [--target 2013-01-02] [--budget-min 300]
 *   tsx scripts/fetch-data/sblBackfill.ts --probe 2010-03-02,2013-01-02,2020-03-19   # 只測試解析，不寫檔
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addDays, todayInTaipei } from '../../src/shared/dates';
import type { SblHistoryFile, SblHistoryRow } from '../../src/shared/marginStress';
import { getJson, sleep, type HttpOptions } from './http';
import { parseTwt93u, weekdaysBackward } from './sources/twseChips';

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

type DayResult = { kind: 'row'; row: SblHistoryRow } | { kind: 'closed' } | { kind: 'parse_error'; message: string };

/** 抓一天；網路錯誤直接丟出（呼叫端決定重試／停止），解析錯誤回傳 parse_error */
export async function fetchDay(date: string, intervalMs: number): Promise<DayResult> {
  const j = await throttled(intervalMs, () =>
    getJson<Parameters<typeof parseTwt93u>[0]>(`https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=${date.replace(/-/g, '')}&response=json`, http),
  );
  try {
    const d = parseTwt93u(j);
    if (!d) return { kind: 'closed' };
    return { kind: 'row', row: [date, d.balance, d.sell, d.ret] };
  } catch (e) {
    return { kind: 'parse_error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function load(file: string): Promise<SblHistoryFile | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as SblHistoryFile;
  } catch {
    return null;
  }
}

async function save(file: string, f: SblHistoryFile): Promise<void> {
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
  const intervalMs = Number(arg('interval-ms') ?? 2500);
  const probeArg = arg('probe');
  if (probeArg) return probe(probeArg.split(','), intervalMs);

  const file = path.resolve(arg('file') ?? 'data/sbl-history.json');
  const target = arg('target') ?? '2013-01-02';
  const budgetMs = Number(arg('budget-min') ?? 300) * 60_000;
  const started = Date.now();
  const f: SblHistoryFile = (await load(file)) ?? {
    schemaVersion: 1,
    note: '上市借券賣出歷史（證交所 TWT93U 逐檔加總，萬張）：[日期, 借券賣出餘額, 當日賣出, 當日還券]。由 sblBackfill.ts 產生。',
    target,
    cursor: addDays(todayInTaipei(), 1),
    updatedAt: '',
    parseErrors: [],
    rows: [],
  };
  f.target = target;
  if (f.cursor <= target) {
    console.log(`[sbl-backfill] 已完成（cursor ${f.cursor} ≤ target ${target}）`);
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
      if (done % 20 === 0) {
        await save(file, f);
        const mins = ((Date.now() - started) / 60_000).toFixed(1);
        console.log(`[sbl-backfill] 進度 cursor=${f.cursor} 共 ${f.rows.length} 筆（本次 ${done} 天，${mins} 分）`);
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
    `::notice title=sbl-backfill::結束：cursor=${f.cursor} rows=${f.rows.length} 解析失敗 ${f.parseErrors.length} 天，${left ? '尚未完成' : '已完成'}${blocked ? '（連續網路錯誤，疑似被擋）' : ''}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `remaining=${left && !blocked ? 'true' : 'false'}\n`, { flag: 'a' });
  }
  if (blocked) process.exit(2);
}

if (process.argv[1]?.endsWith('sblBackfill.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
