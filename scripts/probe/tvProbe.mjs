// 暫時性探測腳本（台股估值資料源）：在 GitHub Actions 執行，原始回應寫到輸出目錄，推到 tv-probe-out 分支。
// 用法：node scripts/probe/tvProbe.mjs <outDir>
// 第四輪：下載 1999–2026 每年最後一個「證券市場統計概要」月報（zip 內為 xls），讓工作環境驗證各年度格式的解析
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '/tmp/probe';
mkdirSync(out, { recursive: true });
const UA = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, url: res.url, status: res.status, ct: res.headers.get('content-type') ?? '' };
}

for (let year = 1999; year <= 2026; year++) {
  try {
    const r = await get(`https://www.twse.com.tw/rwd/zh/statistics/download?type=02&date=${year}0101&response=json`);
    const j = JSON.parse(r.buf.toString('utf8'));
    const row = (j.data ?? []).find((d) => /證券市場統計概要/.test(String(d[0])));
    const files = (row ?? []).slice(1, 13).filter((c) => typeof c === 'string' && /staticFiles/.test(c));
    const last = files.at(-1);
    if (!last) {
      log.push(`${year}: 沒有檔案`);
      continue;
    }
    await sleep(1200);
    // 清單給的是計數轉址網址（/rwd/zh/statistics/count?...&url=/staticFiles/...zip），照原樣請求並跟隨轉址
    const f = await get(new URL(last, 'https://www.twse.com.tw').toString());
    const name = path.basename(new URL(f.url).pathname);
    writeFileSync(path.join(out, name), f.buf);
    log.push(`${year}: ${files.length} 個月，最後 ${name} HTTP ${f.status} ${f.ct} ${f.buf.length} bytes`);
  } catch (e) {
    log.push(`${year}: ERROR ${e.message}`);
  }
  await sleep(1200);
}

writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
