import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeMarginStress, combineStressRows, type MarginHistoryFile, type MarginStressFile } from '../../src/shared/marginStress';
import type { Bar, SeriesFile } from '../../src/shared/types';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 讀取 repo 內的長期歷史（data/margin-history.json）與每日排程資料（outDir/series），
 * 合併後寫出 outDir/margin-stress.json。
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
  const file = path.join(outDir, 'margin-stress.json');
  await writeFile(`${file}.tmp`, JSON.stringify(out));
  await rename(`${file}.tmp`, file);
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
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
