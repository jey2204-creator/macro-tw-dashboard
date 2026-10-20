// 暫時性探測腳本（台股預估本益比資料源）：在 GitHub Actions 執行，原始回應寫到輸出目錄，推到 tv-probe-out 分支。
// 第二輪：下載 Wayback 上所有 MSCI 台灣指數 factsheet 存檔（回補歷史），並查其他 MSCI 文件 UUID 是哪個指數、各有幾份存檔
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '/tmp/probe';
mkdirSync(out, { recursive: true });
const UA = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
  return { buf: Buffer.from(await res.arrayBuffer()), status: res.status, ct: res.headers.get('content-type') ?? '' };
}

const TW = '6f36d84d-425d-4e1f-8d56-e65c455ebda1';
const OTHERS = [
  '6915088e-8dc3-413e-846a-cd29eac266be',
  '9ccebaa5-5511-4ec3-ab8c-d2fa2d5e2645',
  'b74d8961-6be4-41c2-8ad0-50984a58be46',
  '87981248-b0ed-4441-96de-37a7eacf163b',
  '21f4c074-cd49-f368-a923-292ca5db0e79',
  '41fe372f-90df-621b-a01a-65ac18ad2d37',
  '9e0beb48-ab2d-4096-9b59-f10ebcfe0d3c',
  '5cc96fdf-a9c0-2dda-05a8-328d1d011465',
];

async function cdx(uuid) {
  const u = `https://web.archive.org/cdx/search/cdx?url=www.msci.com/documents/10199/${uuid}&output=json&fl=timestamp,statuscode,mimetype,digest&collapse=digest&limit=2000`;
  const r = await get(u);
  try {
    return JSON.parse(r.buf.toString('utf8')).slice(1).filter((x) => x[1] === '200');
  } catch {
    return [];
  }
}

// 1) 台灣指數 factsheet 的所有存檔
const tw = await cdx(TW);
log.push(`TW 存檔 ${tw.length} 份：${tw.map((x) => x[0].slice(0, 8)).join(' ')}`);
mkdirSync(path.join(out, 'wb'), { recursive: true });
for (const [ts] of tw) {
  await sleep(1500);
  try {
    const r = await get(`https://web.archive.org/web/${ts}id_/https://www.msci.com/documents/10199/${TW}`);
    writeFileSync(path.join(out, 'wb', `${ts}.pdf`), r.buf);
    log.push(`  ${ts}: HTTP ${r.status} ${r.ct} ${r.buf.length}`);
  } catch (e) {
    log.push(`  ${ts}: ERROR ${e.message}`);
  }
}

// 2) 其他 UUID：現行檔標題（PDF /Title）與存檔數
for (const uuid of OTHERS) {
  await sleep(1200);
  try {
    const r = await get(`https://www.msci.com/documents/10199/${uuid}`);
    const title = /\/Title \(([^)]*)\)/.exec(r.buf.toString('latin1'))?.[1] ?? '?';
    const n = (await cdx(uuid)).length;
    log.push(`${uuid}: HTTP ${r.status} ${r.ct} title=${title} 存檔=${n}`);
  } catch (e) {
    log.push(`${uuid}: ERROR ${e.message}`);
  }
}

writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
