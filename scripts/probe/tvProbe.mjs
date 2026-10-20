// 暫時性探測腳本（台股估值資料源）：在 GitHub Actions 執行，原始回應寫到輸出目錄，推到 tv-probe-out 分支。
// 用法：node scripts/probe/tvProbe.mjs <outDir>
// 第三輪：證交所統計報表下載清單 API（/rwd/zh/statistics/download?type=02&date=YYYY0101）與「證券市場統計概要」月報檔
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '/tmp/probe';
mkdirSync(out, { recursive: true });
const UA = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(name, url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') ?? '';
    log.push(`${name}: HTTP ${res.status} ${ct} ${buf.length} bytes ${res.url !== url ? `→ ${res.url}` : ''}`);
    writeFileSync(path.join(out, name), buf);
    return { buf, url: res.url, ct, status: res.status };
  } catch (e) {
    log.push(`${name}: ERROR ${e.message}`);
    return null;
  }
}

const hrefOf = (cell) => /href="([^"]+)"/.exec(cell)?.[1] ?? (/^(https?:|\/)/.test(cell) ? cell : '');

for (const year of [2026, 2025, 2016, 2009, 1999]) {
  const r = await get(`list-${year}.json`, `https://www.twse.com.tw/rwd/zh/statistics/download?type=02&date=${year}0101&response=json`);
  await sleep(1500);
  if (!r) continue;
  let j;
  try {
    j = JSON.parse(r.buf.toString('utf8'));
  } catch {
    log.push(`list-${year}: 不是 JSON`);
    continue;
  }
  const row = (j.data ?? []).find((d) => /證券市場統計概要/.test(String(d[0])));
  if (!row) {
    log.push(`list-${year}: 找不到證券市場統計概要列；fields=${JSON.stringify(j.fields)}`);
    continue;
  }
  const files = row.slice(1).map(hrefOf).filter((u) => u && !/^\s*$/.test(u));
  log.push(`list-${year}: 證券市場統計概要 ${files.length} 個檔：${files.join(' ')}`);
  // 2026 抓最新兩個月；其他年份抓最後一個月
  const pick = year === 2026 ? files.slice(-2) : files.slice(-1);
  for (const f of pick) {
    const u = new URL(f, 'https://www.twse.com.tw').toString();
    const base = path.basename(new URL(u).pathname);
    await get(`file-${year}-${base}`, u);
    await sleep(1500);
  }
}

writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
