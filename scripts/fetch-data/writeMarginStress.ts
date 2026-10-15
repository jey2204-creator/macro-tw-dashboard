import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeBreadth, combineBreadthRows, type BreadthHistoryRow, type BreadthStressFile } from '../../src/shared/breadthStress';
import { analyzeMarginStress, combineStressRows, type MarginHistoryFile, type MarginStressFile } from '../../src/shared/marginStress';
import type { Bar, SeriesFile } from '../../src/shared/types';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify(data));
  await rename(`${file}.tmp`, file);
}

/** 最近一次產生的漲跌停家數監測結果（供直接執行時印出） */
export let lastBreadth: BreadthStressFile | null = null;

/**
 * 讀取 repo 內的長期歷史（data/margin-history.json）與每日排程資料（outDir/series），
 * 合併後寫出 outDir/margin-stress.json 與 outDir/breadth-stress.json。
 */
export async function writeMarginStress(outDir: string, historyFile = path.resolve('data/margin-history.json'), now = new Date()): Promise<MarginStressFile> {
  const hist = await readJson<MarginHistoryFile>(historyFile);
  const series = async (id: string): Promise<Bar[] | undefined> =>
    (await readJson<SeriesFile>(path.join(outDir, 'series', `${id}.json`)))?.data;
  const taiex = await series('taiex');
  if (!taiex?.length) throw new Error('缺少加權指數資料');
  const rows = combineStressRows(
    hist?.rows ?? [],
    { ratio: await series('margin_ratio'), balance: await series('margin_balance'), change: await series('margin_chg') },
    taiex,
  );
  const out = analyzeMarginStress(rows, hist?.rows[0]?.[0] ?? null, now);
  // 漲跌停家數監測（同一份歷史檔）
  const breadthHist: BreadthHistoryRow[] = (hist?.schemaVersion === 2 ? hist.rows : []).flatMap((r) =>
    r[4] != null && r[5] != null && r[6] != null && r[7] != null
      ? [{ date: r[0], up: r[4], upLimit: r[5], down: r[6], downLimit: r[7] }]
      : [],
  );
  const breadth = analyzeBreadth(
    combineBreadthRows(
      breadthHist,
      {
        upLimit: await series('limit_up'),
        downLimit: await series('limit_down'),
        up: await series('advance'),
        down: await series('decline'),
      },
      taiex,
      new Map(rows.map((r) => [r[0], r[2]])),
    ),
    now,
  );
  await writeAtomic(path.join(outDir, 'breadth-stress.json'), breadth);
  lastBreadth = breadth;
  await writeAtomic(path.join(outDir, 'margin-stress.json'), out);
  return out;
}

// 直接執行：tsx scripts/fetch-data/writeMarginStress.ts [public/data]
if (process.argv[1]?.endsWith('writeMarginStress.ts')) {
  writeMarginStress(path.resolve(process.argv[2] ?? 'public/data'))
    .then((r) => {
      console.log(`期間 ${r.start}～${r.end}，${r.rows.length} 天；最新 ${JSON.stringify(r.latest)}`);
      console.table(r.eventStats);
      console.table(r.stateStats);
      console.log('基準', r.baseline);
      console.table(r.events);
      if (lastBreadth) {
        console.log(`漲跌停：${lastBreadth.start}～${lastBreadth.end}，最新 ${JSON.stringify(lastBreadth.latest)}`);
        console.table(lastBreadth.eventStats);
        console.table(lastBreadth.events);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
