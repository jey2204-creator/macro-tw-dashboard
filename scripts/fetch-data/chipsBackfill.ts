/**
 * 外資籌碼「長期歷史」回補：外資買賣超（證交所 BFI82U，上市，2010 起）＋外資台指期／散戶小台淨未平倉（2018-06 起）。
 *
 * 每日排程只保留約 1～2 年；外資籌碼對照的百分位與事件回測需要 2010 年起的資料，
 * 因此另以此腳本回補，結果存進 repo 的 data/chips-history.json（由 workflow commit）。
 *
 *  - 期貨淨未平倉：期交所官方只回溯約 3 年，2018-06-05 起改用 FinMind（逐年一段，約 18 個請求）；
 *    2010～2018-06 沒有免費來源，不回補
 *  - 證交所：BFI82U 一次只能查一天，由新到舊逐日抓；兩次請求至少間隔 --interval-ms（預設 2500ms）
 *  - 可續傳：cursor 記錄已處理到的最早日期，下次從 cursor 前一天繼續
 *  - 時間預算 --budget-min 用完就存檔結束；連續網路錯誤視為被擋，存檔後以代碼 2 結束
 *
 * 用法：
 *   tsx scripts/fetch-data/chipsBackfill.ts [--file data/chips-history.json] [--target 2010-01-04] [--budget-min 300]
 *   tsx scripts/fetch-data/chipsBackfill.ts --probe 2010-03-02,2015-08-24   # 只測試解析，不寫檔
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addDays, todayInTaipei } from '../../src/shared/dates';
import type { ChipsHistoryFile, ChipsHistoryRow } from '../../src/shared/foreignChips';
import { getJson, getText, sleep, type HttpOptions } from './http';
import { FINMIND_FUTURES_START, fetchFinmindFutures, finmindToBars } from './sources/finmind';
import { fetchTaifexRange } from './sources/taifex';
import { parseBfi82u, weekdaysBackward } from './sources/twseChips';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const http: HttpOptions = { fetchImpl: (u, i) => fetch(u, i), retries: 2, retryDelayMs: 5000, timeoutMs: 45_000 };

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

type DayResult = { kind: 'value'; net: number } | { kind: 'closed' } | { kind: 'parse_error'; message: string };

/** 抓一天的外資買賣超（億）；網路錯誤直接丟出，解析錯誤回傳 parse_error */
async function fetchNet(date: string, intervalMs: number): Promise<DayResult> {
  const j = await throttled(intervalMs, () =>
    getJson<Parameters<typeof parseBfi82u>[0]>(
      `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${date.replace(/-/g, '')}&response=json`,
      http,
    ),
  );
  try {
    const r = parseBfi82u(j);
    return r ? { kind: 'value', net: r.FOREIGN } : { kind: 'closed' };
  } catch (e) {
    return { kind: 'parse_error', message: `BFI82U ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function load(file: string): Promise<ChipsHistoryFile | null> {
  try {
    const f = JSON.parse(await readFile(file, 'utf8')) as ChipsHistoryFile;
    return f.schemaVersion === 1 ? f : null;
  } catch {
    return null;
  }
}

async function save(file: string, f: ChipsHistoryFile): Promise<void> {
  f.rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  f.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  // 每列一行，git diff 好讀
  const body = JSON.stringify({ ...f, rows: [] }, null, 1).replace(
    '"rows": []',
    `"rows": [\n${f.rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`,
  );
  await writeFile(`${file}.tmp`, body);
  await rename(`${file}.tmp`, file);
}

function rowFor(f: ChipsHistoryFile, index: Map<string, ChipsHistoryRow>, date: string): ChipsHistoryRow {
  let r = index.get(date);
  if (!r) {
    r = [date, null, null, null];
    f.rows.push(r);
    index.set(date, r);
  }
  return r;
}

/**
 * 期貨淨未平倉歷史：期交所官方查詢只回溯約 3 年，更早改用 FinMind（2018-06-05 起，匿名可用，
 * 數值與期交所一致：2026-10-16 外資 −93,675、散戶 +11,123 兩邊相同）。逐年一段，每段 TX、MTX 各一個請求。
 * 同一天若每日排程（期交所）也有資料，合併時以每日排程為準。
 */
async function backfillFutures(f: ChipsHistoryFile, index: Map<string, ChipsHistoryRow>, target: string, today: string) {
  const start = target > FINMIND_FUTURES_START ? target : FINMIND_FUTURES_START;
  let txfN = 0;
  let mxfN = 0;
  let first: string | null = null;
  for (let s = start; s <= today; ) {
    const e0 = `${s.slice(0, 4)}-12-31`;
    const e = e0 < today ? e0 : today;
    const tx = finmindToBars(await fetchFinmindFutures(http, 'TX', s, e), 'foreign');
    await sleep(1500);
    const mtx = finmindToBars(await fetchFinmindFutures(http, 'MTX', s, e), 'retail');
    await sleep(1500);
    for (const b of tx) rowFor(f, index, b[0])[2] = b[4];
    for (const b of mtx) rowFor(f, index, b[0])[3] = b[4];
    txfN += tx.length;
    mxfN += mtx.length;
    first ??= tx[0]?.[0] ?? null;
    console.log(`  [futures] FinMind ${s}～${e}：外資 ${tx.length} 天、散戶 ${mtx.length} 天`);
    s = addDays(e, 1);
  }
  f.futuresFrom = first;
  console.log(`::notice title=futures::FinMind 外資台指期 ${txfN} 天、散戶小台 ${mxfN} 天，自 ${first}`);
}

/** 診斷：印出期交所回應開頭（CSV 下載與單日 HTML 查詢頁各一） */
export async function probeTaifexRaw(d: string) {
  const slash = d.replace(/-/g, '/');
  const flat = (t: string) => t.replace(/\s+/g, ' ').slice(0, 400);
  try {
    const csv = await getText(
      'https://www.taifex.com.tw/cht/3/futContractsDateDown',
      http,
      { method: 'POST', form: { queryStartDate: slash, queryEndDate: addDays(d, 20).replace(/-/g, '/'), commodityId: 'TXF' }, encoding: 'big5' },
    );
    console.log(`::notice title=raw csv ${d}::len=${csv.length} ${flat(csv)}`);
  } catch (e) {
    console.log(`::warning title=raw csv ${d}::${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const html = await getText('https://www.taifex.com.tw/cht/3/futContractsDate', http, {
      method: 'POST',
      form: { queryType: '1', doQuery: '1', queryDate: slash, commodityId: 'TXF' },
    });
    const i = html.indexOf('外資');
    console.log(`::notice title=raw html ${d}::len=${html.length} 外資@${i} ${flat(i >= 0 ? html.slice(Math.max(0, i - 200), i + 600) : html.slice(0, 400))}`);
  } catch (e) {
    console.log(`::warning title=raw html ${d}::${e instanceof Error ? e.message : String(e)}`);
  }
}

async function probe(dates: string[], intervalMs: number) {
  if (process.argv.includes('--raw')) {
    for (const d of dates) {
      // 期交所單日 vs FinMind，同一天外資台指期淨 OI 與散戶小台
      const txf = await fetchTaifexRange('TXF_FOREIGN_OI', d, d, http);
      const mxf = await fetchTaifexRange('MXF_RETAIL_OI', d, d, http);
      let fm: string;
      try {
        const tx = finmindToBars(await fetchFinmindFutures(http, 'TX', d, d), 'foreign');
        const mtx = finmindToBars(await fetchFinmindFutures(http, 'MTX', d, d), 'retail');
        fm = `FinMind 外資=${tx[0]?.[4] ?? '無'} 散戶=${mtx[0]?.[4] ?? '無'}`;
      } catch (e) {
        fm = `FinMind 錯誤 ${e instanceof Error ? e.message : String(e)}`;
      }
      console.log(`::notice title=fut ${d}::期交所 外資=${txf[0]?.[4] ?? '無'} 散戶=${mxf[0]?.[4] ?? '無'}｜${fm}`);
    }
    return;
  }
  for (const d of dates) {
    try {
      const r = await fetchNet(d, intervalMs);
      const txf = await fetchTaifexRange('TXF_FOREIGN_OI', d, d, http);
      const mxf = await fetchTaifexRange('MXF_RETAIL_OI', d, d, http);
      console.log(`::notice title=probe ${d}::BFI82U=${JSON.stringify(r)} TXF外資=${txf[0]?.[4] ?? '無'} MXF散戶=${mxf[0]?.[4] ?? '無'}`);
    } catch (e) {
      console.log(`::warning title=probe ${d}::網路錯誤 ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main() {
  const intervalMs = Number(arg('interval-ms') ?? 2500);
  const probeArg = arg('probe');
  if (probeArg) return probe(probeArg.split(','), intervalMs);

  const file = path.resolve(arg('file') ?? 'data/chips-history.json');
  const target = arg('target') ?? '2010-01-04';
  const budgetMs = Number(arg('budget-min') ?? 300) * 60_000;
  const started = Date.now();
  const today = todayInTaipei();
  const f: ChipsHistoryFile = (await load(file)) ?? {
    schemaVersion: 1,
    note: '外資籌碼歷史：[日期, 外資買賣超億（上市，證交所 BFI82U）, 外資台指期淨未平倉口, 散戶小台淨未平倉口（推算）]。由 chipsBackfill.ts 產生。',
    target,
    cursor: addDays(today, 1),
    futuresFrom: null,
    updatedAt: '',
    parseErrors: [],
    rows: [],
  };
  f.target = target;
  const index = new Map(f.rows.map((r) => [r[0], r]));

  // 1) 期貨：還沒抓過（或目標更早）才抓；失敗不影響證交所回補
  const futuresTarget = target > FINMIND_FUTURES_START ? target : FINMIND_FUTURES_START;
  if (f.futuresFrom === null || f.futuresFrom > addDays(futuresTarget, 14)) {
    try {
      await backfillFutures(f, index, target, today);
      await save(file, f);
    } catch (e) {
      console.log(`::warning title=futures::期貨回補失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2) 證交所：由新到舊逐日
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
      const existing = index.get(day);
      if (!existing || existing[1] === null) {
        const r = await fetchNet(day, intervalMs);
        if (r.kind === 'value') rowFor(f, index, day)[1] = r.net;
        else if (r.kind === 'parse_error') {
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
        console.log(`[chips-backfill] 進度 cursor=${f.cursor}（本次 ${done} 天，${mins} 分）`);
      }
    } catch (e) {
      consecutiveFail++;
      console.warn(`  ${day} 網路錯誤（第 ${consecutiveFail} 次）：${e instanceof Error ? e.message : String(e)}`);
      if (consecutiveFail >= 4) {
        blocked = true;
        break;
      }
      // 可能被暫時封鎖：等久一點再試同一天
      await sleep(consecutiveFail * 90_000);
    }
  }
  await save(file, f);
  const nets = f.rows.filter((r) => r[1] !== null).length;
  const left = f.cursor > target;
  console.log(
    `::notice title=chips-backfill::結束：買賣超 cursor=${f.cursor}（${nets} 天）、期貨自 ${f.futuresFrom}，共 ${f.rows.length} 列，解析失敗 ${f.parseErrors.length} 天，${left ? '尚未完成' : '已完成'}${blocked ? '（連續網路錯誤，疑似被擋）' : ''}`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `remaining=${left && !blocked ? 'true' : 'false'}\n`, { flag: 'a' });
  }
  if (blocked) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
