// 暫時性探測腳本（台股估值資料源）：在 GitHub Actions 執行，原始回應寫到輸出目錄，推到 tv-probe-out 分支。
// 用法：node scripts/probe/tvProbe.mjs <outDir>
// 第二輪：證交所統計報表新版頁面（/zh/statistics/index/NN）的資料 API、央行資本市場利率 CSV、MoneyDJ 淨值比月資料
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '/tmp/probe';
mkdirSync(out, { recursive: true });
const UA = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const log = [];
const MAX_SAVE = 6_000_000;

async function get(name, url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') ?? '';
    log.push(`${name}: HTTP ${res.status} ${ct} ${buf.length} bytes ${res.url !== url ? `→ ${res.url}` : ''}`);
    writeFileSync(path.join(out, name), buf.subarray(0, MAX_SAVE));
    return { buf, url: res.url, ct, status: res.status };
  } catch (e) {
    log.push(`${name}: ERROR ${e.message}`);
    return null;
  }
}

// ── 證交所統計報表：頁面＋所有 script，找資料 API ──
for (const t of ['02', '04']) {
  const r = await get(`twse-stat-${t}.html`, `https://www.twse.com.tw/zh/statistics/index/${t}`);
  if (!r) continue;
  const html = r.buf.toString('utf8');
  const srcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => new URL(m[1], r.url).toString());
  writeFileSync(path.join(out, `twse-stat-${t}.scripts.txt`), srcs.join('\n') + '\n');
  if (t === '02') {
    let k = 0;
    for (const s of srcs) {
      if (!/twse\.com\.tw/.test(s)) continue;
      k++;
      const js = await get(`twse-js-${k}.js`, s);
      if (js) {
        const text = js.buf.toString('utf8');
        const hits = [...new Set([...text.matchAll(/["'`]([^"'`\s]*(?:rwd|statistic|staticFiles)[^"'`\s]*)["'`]/gi)].map((m) => m[1]))];
        if (hits.length) writeFileSync(path.join(out, `twse-js-${k}.hits.txt`), `${s}\n` + hits.join('\n') + '\n');
      }
    }
  }
}
// 猜測的 API 形式（新版網站多為 /rwd/zh/<區塊>/<報表>?response=json）
const guesses = [
  'https://www.twse.com.tw/rwd/zh/statistics/index?type=02&response=json',
  'https://www.twse.com.tw/rwd/zh/statistics/index/02?response=json',
  'https://www.twse.com.tw/rwd/zh/statistics/statisticsList?type=02&response=json',
  'https://www.twse.com.tw/rwd/zh/statistics/list?type=02&response=json',
  'https://www.twse.com.tw/rwd/zh/statistics/index?type=02&year=2026&response=json',
];
let g = 0;
for (const u of guesses) await get(`twse-guess-${++g}.txt`, u);

// ── 央行：資本市場利率（月，1987-05 起；含公債殖利率） ──
await get('cbc-EG43M01.csv', 'https://www.cbc.gov.tw/public/data/OpenData/%E7%B6%93%E7%A0%94%E8%99%95/EG43M01.csv');

// ── MoneyDJ：上市大盤淨值比月資料（指數與 0.5X～3.5X 推計點數；交叉驗證用） ──
await get('moneydj-pb-m.xml', 'https://www.moneydj.com/z/mda.xdjxml?x=combo_m1&KindID=EB09999&Period=M&Count=400');

writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
