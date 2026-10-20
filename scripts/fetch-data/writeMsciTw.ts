import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeMsci, type MsciTwFile } from '../../src/shared/msciTw';
import { parsedFactsheets } from './sources/msciFactsheet';

/**
 * 把本次管線解析到的 MSCI 台灣 factsheet（sources/msciFactsheet.ts 的 parsedFactsheets）併入 outDir/msci-tw.json。
 * 這次沒有抓（快取已有上個月）時維持原檔；沒有舊檔也沒有新紀錄就不寫。
 */
export async function writeMsciTw(outDir: string, now = new Date()): Promise<MsciTwFile | null> {
  const file = path.join(outDir, 'msci-tw.json');
  let existing: MsciTwFile | null = null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as MsciTwFile;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.records)) existing = parsed;
  } catch {
    existing = null;
  }
  const incoming = [...parsedFactsheets.values()];
  if (!existing && incoming.length === 0) return null;
  const out = mergeMsci(existing, incoming, now);
  await writeFile(`${file}.tmp`, JSON.stringify(out));
  await rename(`${file}.tmp`, file);
  return out;
}
