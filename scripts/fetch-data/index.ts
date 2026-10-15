/**
 * 用法：npm run data:fetch [-- --out public/data] [-- --only sox,taiex]
 * 由 GitHub Actions 排程執行，也可本機手動執行。
 * 任一指標失敗不會讓程式以非 0 結束；只有「全部指標都失敗」才回傳 1。
 */
import path from 'node:path';
import { INDICATORS } from '../../src/shared/indicators';
import { updateCalendar } from './calendar';
import { writeBacktest } from './writeBacktest';
import { writeIcs } from './writeIcs';
import { lastBreadth, writeMarginStress } from './writeMarginStress';
import { runPipeline } from './pipeline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const outDir = path.resolve(arg('out') ?? 'public/data');
  const only = arg('only')?.split(',').map((s) => s.trim());
  const indicators = only ? INDICATORS.filter((d) => only.includes(d.id)) : INDICATORS;
  console.log(`[fetch-data] 輸出目錄 ${outDir}，指標 ${indicators.length} 個`);
  const started = Date.now();
  const summary = await runPipeline({
    outDir,
    fetchImpl: (url, init) => fetch(url, init),
    indicators,
    log: (m) => console.log(`  ${m}`),
  });
  const entries = Object.values(summary.entries);
  const bad = entries.filter((e) => e.status === 'error').length;
  const degraded = entries.filter((e) => e.status === 'cached' || e.status === 'fallback').length;
  console.log(
    `[fetch-data] 完成，用時 ${((Date.now() - started) / 1000).toFixed(1)}s；正常 ${entries.length - bad - degraded}、降級 ${degraded}、失敗 ${bad}`,
  );
  if (entries.length > 0 && bad === entries.length) process.exit(1);
  // 公布行事曆（市場預期）失敗不影響資料更新
  try {
    await updateCalendar({ outDir, fetchImpl: (url, init) => fetch(url, init), log: (m) => console.log(`  ${m}`) });
  } catch (e) {
    console.warn('[calendar] 略過：', e instanceof Error ? e.message : e);
  }
  // 行事曆檔（訂閱用）失敗不影響資料更新
  try {
    console.log(`[ics] macro-events.ics ${await writeIcs(outDir)} 個事件`);
  } catch (e) {
    console.warn('[ics] 略過：', e instanceof Error ? e.message : e);
  }
  // 回測失敗不影響資料更新
  try {
    const t = Date.now();
    const bt = await writeBacktest(outDir);
    console.log(`[backtest] ${bt.start}～${bt.end}，用時 ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[backtest] 略過：', e instanceof Error ? e.message : e);
  }
  // 融資斷頭監測失敗不影響資料更新
  try {
    const ms = await writeMarginStress(outDir);
    console.log(`[margin-stress] ${ms.start}～${ms.end}，${ms.rows.length} 天，事件 ${ms.events.length} 筆，最新 ${JSON.stringify(ms.latest)}`);
    console.log(`[breadth-stress] ${lastBreadth?.start}～${lastBreadth?.end}，事件 ${lastBreadth?.events.length}，最新 ${JSON.stringify(lastBreadth?.latest)}`);
  } catch (e) {
    console.warn('[margin-stress] 略過：', e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
