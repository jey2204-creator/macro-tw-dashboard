import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeForeignChips,
  combineForeignRows,
  mergeChipsHistory,
  type ChipsHistoryFile,
  type ForeignChipsFile,
} from '../../src/shared/foreignChips';
import type { Bar, SeriesFile } from '../../src/shared/types';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 讀取 repo 內的長期歷史（data/chips-history.json，由 chipsBackfill.ts 回補）與
 * 每日排程資料（outDir/series 的 net_foreign、fut_foreign_oi、retail_oi、taiex），
 * 合併後寫出 outDir/foreign-chips.json（外資籌碼對照面板）。同一天以每日排程為準。
 */
export async function writeForeignChips(
  outDir: string,
  historyFile = path.resolve('data/chips-history.json'),
  now = new Date(),
): Promise<ForeignChipsFile> {
  const series = async (id: string): Promise<Bar[] | undefined> =>
    (await readJson<SeriesFile>(path.join(outDir, 'series', `${id}.json`)))?.data;
  const taiex = await series('taiex');
  if (!taiex?.length) throw new Error('缺少加權指數資料');
  const hist = await readJson<ChipsHistoryFile>(historyFile);
  const merged = mergeChipsHistory(hist?.schemaVersion === 1 ? hist.rows : [], {
    net: await series('net_foreign'),
    foreignOi: await series('fut_foreign_oi'),
    retailOi: await series('retail_oi'),
  });
  const rows = combineForeignRows(merged, taiex);
  const out = analyzeForeignChips(rows, now);
  const file = path.join(outDir, 'foreign-chips.json');
  await writeFile(`${file}.tmp`, JSON.stringify(out));
  await rename(`${file}.tmp`, file);
  return out;
}

// 直接執行：tsx scripts/fetch-data/writeForeignChips.ts [public/data]
if (process.argv[1]?.endsWith('writeForeignChips.ts')) {
  writeForeignChips(path.resolve(process.argv[2] ?? 'public/data'))
    .then((r) => {
      console.log(`期間 ${r.start}～${r.end}，${r.rows.length} 天；最新 ${JSON.stringify(r.latest)}`);
      console.table(r.eventStats);
      console.log('基準', r.baseline);
      console.table(r.events);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
