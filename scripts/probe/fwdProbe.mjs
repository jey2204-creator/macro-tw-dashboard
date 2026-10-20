// 暫時性探測腳本（台股預估本益比資料源）：在 GitHub Actions 執行，原始回應寫到輸出目錄，推到 tv-probe-out 分支。
// 用法：node scripts/probe/fwdProbe.mjs <outDir>
// 1) MSCI 台灣指數官方頁與 factsheet PDF 從 GitHub 抓不抓得到  2) Wayback Machine 有多少期 factsheet 存檔（回補歷史用）
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '/tmp/probe';
mkdirSync(out, { recursive: true });
const UA = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(name, url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    log.push(`${name}: HTTP ${res.status} ${res.headers.get('content-type') ?? ''} ${buf.length} bytes ${res.url !== url ? `→ ${res.url}` : ''}`);
    writeFileSync(path.join(out, name), buf);
    return { buf, status: res.status };
  } catch (e) {
    log.push(`${name}: ERROR ${e.message}`);
    return null;
  }
}

const PAGE = 'https://www.msci.com/indexes/index/915800';
const PDF = 'https://www.msci.com/documents/10199/6f36d84d-425d-4e1f-8d56-e65c455ebda1';

const page = await get('msci-page.html', PAGE);
if (page) {
  const text = page.buf.toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  for (const k of ['P/E Fwd', 'P/E', 'P/BV', 'Div Yld', 'Data as of', 'Index Market Cap']) {
    const i = text.indexOf(k);
    log.push(`  page[${k}]: ${i < 0 ? '找不到' : text.slice(i, i + 60)}`);
  }
}
// 換一個瀏覽器 UA 再試一次（若誠實 UA 被擋）
if (!page || page.status !== 200) await get('msci-page-browser.html', PAGE, { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
await get('msci-factsheet.pdf', PDF);

// Wayback Machine：factsheet 與官方頁的存檔清單
for (const [name, u] of [
  ['cdx-pdf.json', PDF],
  ['cdx-page.json', PAGE],
]) {
  await sleep(1500);
  await get(name, `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(u.replace(/^https:\/\//, ''))}&output=json&fl=timestamp,statuscode,mimetype,digest,length&collapse=digest&limit=2000`);
}

writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
