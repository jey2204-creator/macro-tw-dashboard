import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergePosts, type FactsetEpsFile } from '../../src/shared/factsetEps';
import { parsedPosts } from './sources/factset';

/**
 * 把本次管線解析到的 FactSet 週報（sources/factset.ts 的 parsedPosts）併入 outDir/factset-eps.json。
 * 沒有新文章時維持原檔（只更新 generatedAt）；沒有舊檔也沒有新文章就不寫。
 */
export async function writeFactsetEps(outDir: string, now = new Date()): Promise<FactsetEpsFile | null> {
  const file = path.join(outDir, 'factset-eps.json');
  let existing: FactsetEpsFile | null = null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as FactsetEpsFile;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.posts)) existing = parsed;
  } catch {
    existing = null;
  }
  const incoming = [...parsedPosts.values()];
  if (!existing && incoming.length === 0) return null;
  const out: FactsetEpsFile = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    posts: mergePosts(existing?.posts ?? [], incoming),
  };
  await writeFile(`${file}.tmp`, JSON.stringify(out));
  await rename(`${file}.tmp`, file);
  return out;
}
