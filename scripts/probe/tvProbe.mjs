// 暫時性探測腳本（台股估值資料源）：在 GitHub Actions 執行，原始回應寫到輸出目錄，推到 tv-probe-out 分支。
// 用法：node scripts/probe/tvProbe.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '/tmp/probe';
mkdirSync(out, { recursive: true });
const UA = 'macro-tw-dashboard/0.1 (+https://github.com/jey2204-creator/macro-tw-dashboard)';
const log = [];
const MAX_SAVE = 6_000_000;

const FILE_RE = /\.(xls|xlsx|csv|pdf|zip|ods|json|xml)(\?|$)/i;

function linksOf(text, base) {
  const outLinks = [];
  for (const m of text.matchAll(/href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'), base).toString();
      const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      outLinks.push({ u, label });
    } catch {
      /* 略過 */
    }
  }
  return outLinks;
}

async function get(name, url, { follow, headers } = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') ?? '';
    log.push(`${name}: HTTP ${res.status} ${ct} ${buf.length} bytes ${res.url !== url ? `→ ${res.url}` : ''}`);
    writeFileSync(path.join(out, name), buf.subarray(0, MAX_SAVE));
    const isText = /text|json|xml|javascript/i.test(ct) || /\.(html|json|txt|csv)$/i.test(name);
    if (isText) {
      const text = buf.toString('utf8');
      const links = linksOf(text, res.url || url);
      if (links.length) {
        writeFileSync(path.join(out, `${name}.links.txt`), links.map((l) => `${l.u}\t${l.label}`).join('\n') + '\n');
      }
      // 腳本內的 API 網址（rwd、response=json、OpenData）
      const apis = [...new Set([...text.matchAll(/["'`](\/?(?:rwd|api|openapi|public\/data|staticFiles)[^"'`\s]{3,200})["'`]/gi)].map((m) => m[1]))];
      if (apis.length) writeFileSync(path.join(out, `${name}.apis.txt`), apis.join('\n') + '\n');
      if (follow) {
        const targets = follow(links, text).slice(0, 6);
        let k = 0;
        for (const t of targets) {
          k++;
          const ext = (/\.(\w{2,4})(?:\?|$)/.exec(new URL(t).pathname)?.[1] ?? 'bin').toLowerCase();
          await get(`${name}.f${k}.${ext}`, t);
        }
      }
    }
    return buf;
  } catch (e) {
    log.push(`${name}: ERROR ${e.message}`);
    return null;
  }
}

const twseFiles = (links) => {
  const files = links.filter((l) => FILE_RE.test(l.u) || /staticFiles/i.test(l.u));
  // 最新兩個與最舊一個
  return [...files.slice(0, 2), ...files.slice(-1)].map((l) => l.u);
};

// ── 證交所：統計月報清單（證券市場統計概要／本益比、殖利率、股價淨值比）──
await get('twse-list-02-199-pc.html', 'https://www.twse.com.tw/pcversion/zh/statistics/statisticsList?type=02&subType=199', { follow: twseFiles });
await get('twse-list-02-199.html', 'https://www.twse.com.tw/zh/statistics/statisticsList?type=02&subType=199', { follow: twseFiles });
await get('twse-list-02-199-rwd.json', 'https://www.twse.com.tw/rwd/zh/statistics/statisticsList?type=02&subType=199&response=json');
await get('twse-list-04-220-pc.html', 'https://www.twse.com.tw/pcversion/zh/statistics/statisticsList?type=04&subType=220', { follow: twseFiles });
await get('twse-list-04-220-rwd.json', 'https://www.twse.com.tw/rwd/zh/statistics/statisticsList?type=04&subType=220&response=json');
await get('twse-openapi.json', 'https://openapi.twse.com.tw/v1/swagger.json');
await get('twse-bwibbu-d.json', 'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=20261016&selectType=ALL&response=json');
await get('moneydj-zbla.html', 'https://www.moneydj.com/Z/ZB/ZBL/ZBLA/ZBLA.djhtm');

// ── 台灣 10 年期公債殖利率 ──
await get('cbc-opendata.html', 'https://www.cbc.gov.tw/tw/lp-1032-1.html', {
  follow: (links) => links.filter((l) => /已開放資料集|資料集清單/.test(l.label)).map((l) => l.u),
});
await get('cbc-interest.pdf', 'https://www.cbc.gov.tw/public/data/economic/statistics/key/interest.pdf');
await get('tpex-openapi.json', 'https://www.tpex.org.tw/openapi/swagger.json');
await get('tpex-govbond-daily.html', 'https://www.tpex.org.tw/web/bond/tradeinfo/govbond/GovBondDaily_02.php?l=zh-tw');
await get('datagov-10840.json', 'https://data.gov.tw/api/v2/rest/dataset/10840');

writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
