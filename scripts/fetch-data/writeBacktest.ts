import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { INDICATORS } from '../../src/shared/indicators';
import type { BacktestFile, Bar, SeriesFile } from '../../src/shared/types';
import { runBacktest } from './backtest';

/** 讀取 outDir/series/*.json，以目前規則回測並寫出 outDir/backtest.json */
export async function writeBacktest(outDir: string, now = new Date()): Promise<BacktestFile> {
  const series: Record<string, Bar[]> = {};
  for (const d of INDICATORS) {
    try {
      const f = JSON.parse(await readFile(path.join(outDir, 'series', `${d.id}.json`), 'utf8')) as SeriesFile;
      series[d.id] = f.data;
    } catch {
      /* 缺檔的指標不納入 */
    }
  }
  const bt = runBacktest(series, INDICATORS, { now });
  const file = path.join(outDir, 'backtest.json');
  await writeFile(`${file}.tmp`, JSON.stringify(bt));
  await rename(`${file}.tmp`, file);
  return bt;
}

// 直接執行：npm run backtest
if (process.argv[1]?.endsWith('writeBacktest.ts')) {
  const dir = path.resolve(process.argv[2] ?? 'public/data');
  writeBacktest(dir)
    .then((bt) => {
      console.log(`回測期間 ${bt.start}～${bt.end}`);
      console.table(Object.fromEntries(Object.entries(bt.composite).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([s, b]) => [s, `${b.pct}% | 60日 ${b.avg60}% | 勝率 ${b.win60}%`]))])));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
